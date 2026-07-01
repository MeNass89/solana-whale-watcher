import { config } from "../config/index.js";
import { BirdEyeRateLimitError, BirdEyeUnavailableError, birdEyeClient } from "../blockchain/birdeye-client.js";
import {
  DexScreenerRateLimitError,
  DexScreenerServerError,
  DexScreenerTransientError,
  dexScreenerClient
} from "../blockchain/dexscreener-client.js";
import { jupiterClient } from "./jupiter-client.js";
import type { AppDatabase } from "../storage/database.js";
import type { ConvergenceRow } from "../storage/models/convergences.js";
import type { TradeRow } from "../storage/models/trades.js";
import { unixNow } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
  adjustedSizePct?: number;
  liquidityCapApplied?: boolean;
  phase?: RiskPhase;
  portfolioValueUsd?: number;
  sizeUsd?: number;
  liquidityUsd?: number;
}

type RiskPhase = "cold_start" | "validated" | "mature";

interface PhaseLimits {
  cap: number;
  maxExposure: number;
  maxPositions: number;
}

const PHASE_LIMITS: Record<RiskPhase, PhaseLimits> = {
  cold_start: { cap: 3, maxExposure: 40, maxPositions: 15 },
  validated: { cap: 5, maxExposure: 50, maxPositions: 15 },
  mature: { cap: 5, maxExposure: 60, maxPositions: 15 }
};

const MAX_POSITION_LIQUIDITY_PCT = 5;   // never buy more than 5% of pool TVL
const TVL_HARD_FLOOR_USD = 5_000;
const TVL_SMALL_BRACKET_USD = 25_000;
const TVL_MEDIUM_BRACKET_USD = 100_000;
const TVL_SMALL_CAP_PCT = 0.2;
const TVL_MEDIUM_CAP_PCT = 0.5;

const MAX_HONEYPOT_ROUNDTRIP_LOSS_PCT = 8;
const MAX_TOP_10_HOLDERS_PCT = 40;
const MIN_TOKEN_AGE_HOURS = 24;
const NEW_TOKEN_MIN_LP_USD = 50_000;
const MAX_PER_NARRATIVE = 3;
const PORTFOLIO_HEAT_CAP_PCT = 6;
const SOL_RESERVE = 5;
const MAX_POSITION_PORTFOLIO_PCT = 3;
const MAX_POSITION_USD = 2000;

const SOL_MINT = "So11111111111111111111111111111111111111112";
// Fills with |pnl| under a dollar are float dust from partial-exit rounding,
// not trading outcomes — they count as neither loss nor win for the streak.
const LOSS_STREAK_EPSILON_USD = 1;
const LOSS_STREAK_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const LOSS_STREAK_PAUSE_SECONDS = 6 * 60 * 60;
const MIRROR_MIN_PCT = 0.3;
const MIRROR_MAX_PCT = 5.0;
const MIRROR_FALLBACK_PCT = 1.0;
const MAX_REASONABLE_VOL_PCT = 300;
// Cold-start fallback: when a token has no volatility history yet but has
// passed the TVL hard floor, treat it as high-volatility (150%). That gives
// volAdj = 50/150 = 0.33, which combined with the MIRROR_MIN_PCT floor ends
// up as a conservative ~0.3% portfolio position — not "no entry at all".
const VOLATILITY_COLD_START_FALLBACK_PCT = 150;

function isTransientProviderError(error: unknown): boolean {
  return (
    error instanceof BirdEyeRateLimitError ||
    error instanceof BirdEyeUnavailableError ||
    error instanceof DexScreenerRateLimitError ||
    error instanceof DexScreenerServerError ||
    error instanceof DexScreenerTransientError
  );
}

export class RiskEngine {
  private closeAllHandler: ((reason: string) => Promise<void>) | null = null;

  constructor(private db: AppDatabase | null = null) {}

  configure(db: AppDatabase): void {
    this.db = db;
    this.ensurePaperBalance();
  }

  /** Wired at startup to close every open position through the normal exit path. */
  setCloseAllHandler(handler: (reason: string) => Promise<void>): void {
    this.closeAllHandler = handler;
  }

  async checkEntry(convergence: ConvergenceRow, trades: TradeRow[], _entryPriceUsd: number): Promise<RiskCheck> {
    const db = this.requireDb();
    const phase = this.phase();
    const limits = PHASE_LIMITS[phase];
    const portfolioValueUsd = this.portfolioValueUsd();

    const circuitBreaker = this.circuitBreakerReason(portfolioValueUsd);
    if (circuitBreaker) return { allowed: false, reason: circuitBreaker, phase, portfolioValueUsd };

    const liquidityUsd = await this.tokenLiquidityLive(convergence.token_mint);
    if (liquidityUsd === null) return { allowed: false, reason: "pool TVL unavailable", phase, portfolioValueUsd };
    if (liquidityUsd < TVL_HARD_FLOOR_USD) {
      return { allowed: false, reason: `pool TVL $${Math.round(liquidityUsd)} below $${TVL_HARD_FLOOR_USD / 1000}k floor`, phase, portfolioValueUsd };
    }

    const tvlBracketCapPct =
      liquidityUsd < TVL_SMALL_BRACKET_USD ? TVL_SMALL_CAP_PCT
      : liquidityUsd < TVL_MEDIUM_BRACKET_USD ? TVL_MEDIUM_CAP_PCT
      : limits.cap;

    const rawVolatility = this.numberConfig(`token:${convergence.token_mint}:realized_vol_24h_pct`);
    // Outsized volatility (>300%) still hard-fails — that's a token bouncing
    // 3x intraday and not size-able. But unknown volatility on a token that
    // already cleared the TVL hard floor now uses a conservative fallback
    // instead of an outright reject, so cold-start convergences on freshly
    // ingested established tokens can still trade at minimum size.
    if (rawVolatility !== null && rawVolatility > MAX_REASONABLE_VOL_PCT) {
      logger.warn(
        { mint: convergence.token_mint, volatility: rawVolatility },
        "risk-engine: volatility outsized; refusing entry"
      );
      return { allowed: false, reason: "volatility outsized", phase, portfolioValueUsd };
    }
    const volatility = rawVolatility !== null && rawVolatility > 0
      ? rawVolatility
      : VOLATILITY_COLD_START_FALLBACK_PCT;
    if (rawVolatility === null || rawVolatility <= 0) {
      logger.info(
        { mint: convergence.token_mint, fallback: VOLATILITY_COLD_START_FALLBACK_PCT },
        "risk-engine: volatility unknown, using cold-start fallback"
      );
    }
    const mirrorPct = await this.computeMirrorSizePct(trades, portfolioValueUsd);
    const volAdj = Math.min(1, 50 / volatility);
    const drawdownHalve = this.stringConfig("drawdown_halve_sizes") === "true" ? 0.5 : 1;

    const floorApplied = Math.max(MIRROR_MIN_PCT, mirrorPct * volAdj * drawdownHalve);
    const adjustedSizePct = Math.min(tvlBracketCapPct, floorApplied);

    // Apply portfolio hard cap BEFORE downstream size-based gates so we evaluate
    // the executable size, not an uncapped theoretical one.
    const sizeUsd = (portfolioValueUsd * adjustedSizePct) / 100;
    const hardCapUsd = Math.min(portfolioValueUsd * MAX_POSITION_PORTFOLIO_PCT / 100, MAX_POSITION_USD);
    let finalSizeUsd = Math.min(sizeUsd, hardCapUsd);
    let finalSizePct = (finalSizeUsd / portfolioValueUsd) * 100;
    let liquidityCapApplied = false;

    // Cap position to MAX_POSITION_LIQUIDITY_PCT of pool TVL
    const maxLiquiditySizeUsd = (liquidityUsd * MAX_POSITION_LIQUIDITY_PCT) / 100;
    if (finalSizeUsd > maxLiquiditySizeUsd) {
      finalSizeUsd = maxLiquiditySizeUsd;
      finalSizePct = (finalSizeUsd / portfolioValueUsd) * 100;
      liquidityCapApplied = true;
    }

    // Cash gate: sizing is a % of PORTFOLIO value (cash + open positions), so
    // with heavy open exposure the computed size can exceed spendable cash and
    // drive the paper balance negative. Never buy money we do not have.
    if (config.execution.mode === "paper") {
      const cashUsd = this.paperCashUsd();
      if (finalSizeUsd > cashUsd) {
        return {
          allowed: false,
          reason: `insufficient cash: size $${finalSizeUsd.toFixed(2)} exceeds paper cash $${cashUsd.toFixed(2)}`,
          phase,
          portfolioValueUsd
        };
      }
    }

    const honeypotLoss = this.numberConfig(`token:${convergence.token_mint}:honeypot_roundtrip_loss_pct`);
    if (honeypotLoss !== null && honeypotLoss > MAX_HONEYPOT_ROUNDTRIP_LOSS_PCT) {
      return { allowed: false, reason: "honeypot roundtrip loss above 8%", phase, portfolioValueUsd };
    }

    const top10Pct = this.numberConfig(`token:${convergence.token_mint}:top10_holders_pct`);
    if (top10Pct !== null && top10Pct > MAX_TOP_10_HOLDERS_PCT) {
      return { allowed: false, reason: "top 10 holders above 40% supply", phase, portfolioValueUsd };
    }

    const tokenAgeHours = await this.tokenAgeLive(convergence.token_mint);
    if (tokenAgeHours !== null && tokenAgeHours < MIN_TOKEN_AGE_HOURS && liquidityUsd < NEW_TOKEN_MIN_LP_USD) {
      return { allowed: false, reason: "token age below 24h and LP below $50k", phase, portfolioValueUsd };
    }

    const openPositions = (
      db.prepare("SELECT COUNT(*) AS count FROM positions WHERE status IN ('OPEN','PARTIAL')").get() as { count: number }
    ).count;
    if (openPositions >= limits.maxPositions) return { allowed: false, reason: "max open positions reached", phase, portfolioValueUsd };

    const exposurePct = this.openExposurePct(portfolioValueUsd);
    if (exposurePct + finalSizePct > limits.maxExposure) {
      return { allowed: false, reason: "portfolio exposure limit exceeded", phase, portfolioValueUsd };
    }

    const narrative = this.stringConfig(`token:${convergence.token_mint}:narrative`);
    if (narrative && this.positionsInNarrative(narrative) >= MAX_PER_NARRATIVE) {
      return { allowed: false, reason: "max per narrative reached", phase, portfolioValueUsd };
    }

    if (this.portfolioHeatPct(portfolioValueUsd) + finalSizePct * 0.25 > PORTFOLIO_HEAT_CAP_PCT) {
      return { allowed: false, reason: "portfolio heat cap exceeded", phase, portfolioValueUsd };
    }

    const solBalance = this.numberConfig("wallet:sol_balance");
    if (config.execution.mode === "live" && solBalance !== null && solBalance < SOL_RESERVE) {
      return { allowed: false, reason: "SOL reserve below 5 SOL", phase, portfolioValueUsd };
    }

    return {
      allowed: true,
      adjustedSizePct: finalSizePct,
      ...(liquidityCapApplied ? { liquidityCapApplied: true } : {}),
      phase,
      portfolioValueUsd,
      sizeUsd: finalSizeUsd,
      liquidityUsd
    };
  }

  private async computeMirrorSizePct(trades: TradeRow[], portfolioValueUsd: number): Promise<number> {
    if (portfolioValueUsd <= 0) return MIRROR_FALLBACK_PCT;
    const buys = trades.filter((trade) => trade.trade_type === "BUY");
    const solAmounts = buys.map((trade) => trade.amount_sol ?? 0).filter((value) => value > 0);
    if (solAmounts.length === 0) return MIRROR_FALLBACK_PCT;
    solAmounts.sort((a, b) => a - b);
    // True median: average the two middle elements for even-length samples.
    const mid = Math.floor(solAmounts.length / 2);
    const median = solAmounts.length % 2 === 0 ? (solAmounts[mid - 1] + solAmounts[mid]) / 2 : solAmounts[mid];
    let solPriceUsd: number | null;
    try {
      solPriceUsd = await jupiterClient.getPriceUsd(SOL_MINT);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error : new Error(String(error)), trades: trades.length, portfolioValueUsd },
        "risk-engine: SOL/USD pricing failed for mirror sizing"
      );
      throw error;
    }
    if (!solPriceUsd || solPriceUsd <= 0) {
      logger.warn(
        { trades: trades.length, portfolioValueUsd, solPriceUsd },
        "risk-engine: SOL/USD price unavailable; using fallback mirror size"
      );
      return MIRROR_FALLBACK_PCT;
    }
    const targetUsd = median * solPriceUsd;
    const targetPct = (targetUsd / portfolioValueUsd) * 100;
    return Math.max(MIRROR_MIN_PCT, Math.min(MIRROR_MAX_PCT, targetPct));
  }

  recordJupiterError(): void {
    const lastReset = this.numberConfig("jupiter_errors_5m_reset") ?? 0;
    if (unixNow() - lastReset > 5 * 60) {
      this.setConfig("jupiter_errors_5m", "0");
      this.setConfig("jupiter_errors_5m_reset", String(unixNow()));
    }
    const count = Number(this.stringConfig("jupiter_errors_5m") ?? "0") + 1;
    this.setConfig("jupiter_errors_5m", String(count));
    if (count > 5) this.pauseEntries(5 * 60, "jupiter API errors > 5% in 5min");
  }

  recordFailedTransaction(): void {
    const lastReset = this.numberConfig("failed_txs_1h_reset") ?? 0;
    if (unixNow() - lastReset > 60 * 60) {
      this.setConfig("failed_txs_1h", "0");
      this.setConfig("failed_txs_1h_reset", String(unixNow()));
    }
    const count = Number(this.stringConfig("failed_txs_1h") ?? "0") + 1;
    this.setConfig("failed_txs_1h", String(count));
    if (count > 25) this.pauseEntries(30 * 60, "failed tx rate > 25% in 1h");
  }

  updatePaperBalance(deltaUsd: number): void {
    const balance = this.paperCashUsd() + deltaUsd;
    this.setConfig("paper_balance_usd", balance.toFixed(6));
  }

  portfolioValueUsd(): number {
    const db = this.requireDb();
    const openValue =
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount_token * COALESCE(current_price_usd, entry_price_usd)), 0) AS value
             FROM positions WHERE status IN ('OPEN','PARTIAL')`
          )
          .get() as { value: number }
      ).value ?? 0;
    return this.paperCashUsd() + openValue;
  }

  private circuitBreakerReason(portfolioValueUsd: number): string | null {
    const now = unixNow();
    const pauseUntil = this.numberConfig("entries_paused_until");
    if (pauseUntil && pauseUntil > now) return this.stringConfig("entries_pause_reason") ?? "entries paused";
    if (this.sumPnlSince(now - 24 * 60 * 60) <= -portfolioValueUsd * 0.07) {
      this.pauseEntries(24 * 60 * 60, "daily loss >= 7%");
      return "daily loss >= 7%";
    }
    if (this.sumPnlSince(now - 7 * 24 * 60 * 60) <= -portfolioValueUsd * 0.15) {
      this.pauseEntries(7 * 24 * 60 * 60, "weekly loss >= 15%");
      return "weekly loss >= 15%";
    }
    if (this.sumPnlSince(now - 30 * 24 * 60 * 60) <= -portfolioValueUsd * 0.25) {
      this.setConfig("kill_switch", "monthly loss >= 25%");
      return "monthly loss >= 25%";
    }
    const highWatermark = this.numberConfig("portfolio_high_watermark_usd") ?? portfolioValueUsd;
    if (portfolioValueUsd > highWatermark) this.setConfig("portfolio_high_watermark_usd", portfolioValueUsd.toFixed(6));
    const drawdownPct = highWatermark > 0 ? ((portfolioValueUsd - highWatermark) / highWatermark) * 100 : 0;
    if (drawdownPct <= -25) return "drawdown kill switch at -25%";
    if (drawdownPct <= -20) {
      this.pauseEntries(7 * 24 * 60 * 60, "drawdown -20% close all and freeze 7d");
      // The breaker's name must be honest: "close all" actually closes all.
      // (This branch is unreachable while the pause it arms is active, so it
      // cannot re-fire in a loop; on an empty book the close-all is a no-op.)
      this.triggerCloseAll("drawdown -20%: close all positions, freeze 7d");
      return "drawdown -20%: close all positions, freeze 7d";
    }
    if (drawdownPct <= -15) return "drawdown pause entries at -15%";
    if (drawdownPct <= -10) this.setConfig("drawdown_halve_sizes", "true");
    else this.setConfig("drawdown_halve_sizes", "false");
    if (this.lossStreak() >= 5) {
      // Arm the pause ONCE per streak occurrence. Re-arming on every
      // checkEntry call turned a 6h cooldown into a permanent deadlock: the
      // streak stays >= 5 until a new fill lands, but no fill can land while
      // entries re-pause themselves forever. The latest SELL fill id
      // identifies the streak; only a new fill can start a new occurrence.
      const latestSellId = this.latestSellFillId();
      const pausedFor = this.stringConfig("loss_streak_paused_for_fill");
      if (pausedFor !== String(latestSellId)) {
        this.setConfig("loss_streak_paused_for_fill", String(latestSellId));
        this.pauseEntries(LOSS_STREAK_PAUSE_SECONDS, "5 consecutive losses");
        return "5 consecutive losses";
      }
      // Pause already served for this exact streak: let entries flow — a new
      // trade is the only thing that can ever break the streak.
    }
    const solDropPct = this.numberConfig("sol_drop_1h_pct");
    if (solDropPct !== null && solDropPct <= -8) return "SOL dropped 8% in 1h";
    const tps = this.numberConfig("network_tps");
    const skipRate = this.numberConfig("network_skip_rate_pct");
    if ((tps !== null && tps < 1_000) || (skipRate !== null && skipRate > 40)) return "network TPS/skip-rate breaker";
    const sharpe = this.numberConfig("rolling_7d_sharpe");
    if (sharpe !== null && sharpe < 0) return "rolling 7d Sharpe < 0";
    const winRate = this.winRateLast30();
    if (winRate !== null && winRate < 25) {
      this.pauseEntries(6 * 60 * 60, "win rate < 25% over 30 trades");
      return "win rate < 25% over 30 trades";
    }
    return this.stringConfig("kill_switch");
  }

  private triggerCloseAll(reason: string): void {
    if (!this.closeAllHandler) {
      logger.warn({ reason }, "risk-engine: close-all requested but no handler wired; only pausing entries");
      return;
    }
    this.closeAllHandler(reason).catch((error) =>
      logger.error({ reason, err: error instanceof Error ? error : new Error(String(error)) }, "risk-engine: close-all handler failed")
    );
  }

  private phase(): RiskPhase {
    // Phase = validated ENTRIES, not raw fill count. Exit fills (a single
    // position can produce several) would otherwise promote the system to
    // "mature" limits off pure exit spam.
    const filled = (
      this.requireDb().prepare("SELECT COUNT(*) AS count FROM executions WHERE status = 'FILLED' AND direction = 'BUY'").get() as { count: number }
    ).count;
    if (filled < 50) return "cold_start";
    if (filled < 200) return "validated";
    return "mature";
  }

  private tokenLiquidity(mint: string): number | null {
    const row = this.requireDb().prepare("SELECT liquidity_usd FROM tokens WHERE mint = ?").get(mint) as
      | { liquidity_usd: number | null }
      | undefined;
    return row?.liquidity_usd ?? null;
  }

  async tokenLiquidityLive(mint: string): Promise<number | null> {
    // Provider rate-limit/transient failures fail closed; only benign nulls
    // continue to the next source or cached DB value.
    const overview = await birdEyeClient.getTokenOverview(mint).catch((error) => {
      if (isTransientProviderError(error)) throw error;
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "risk-engine: birdeye unavailable, falling through to dexscreener");
      return null;
    });
    if (overview?.liquidityUsd != null) return overview.liquidityUsd;
    const pair = await dexScreenerClient.getBestPair(mint).catch((error) => {
      if (isTransientProviderError(error)) throw error;
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "risk-engine: dexscreener unavailable, falling back to cached liquidity");
      return null;
    });
    if (pair?.liquidityUsd != null) return pair.liquidityUsd;
    return this.tokenLiquidity(mint);
  }

  async tokenAgeLive(mint: string): Promise<number | null> {
    const overview = await birdEyeClient.getTokenOverview(mint).catch((error) => {
      if (isTransientProviderError(error)) throw error;
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "risk-engine: birdeye unavailable for token age, trying dexscreener");
      return null;
    });
    if (overview?.createdAt) {
      return (Date.now() / 1000 - overview.createdAt) / 3600;
    }
    const pair = await dexScreenerClient.getBestPair(mint).catch((error) => {
      if (isTransientProviderError(error)) throw error;
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "risk-engine: dexscreener unavailable, no token-age estimate");
      return null;
    });
    if (pair?.pairCreatedAt) {
      return (Date.now() - pair.pairCreatedAt) / (1000 * 3600);
    }
    return null;
  }

  private paperCashUsd(): number {
    this.ensurePaperBalance();
    return this.numberConfig("paper_balance_usd") ?? config.execution.paperInitialBalance;
  }

  private openExposurePct(portfolioValueUsd: number): number {
    if (portfolioValueUsd <= 0) return 0;
    const db = this.requireDb();
    const exposure = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_token * COALESCE(current_price_usd, entry_price_usd)), 0) AS value
           FROM positions WHERE status IN ('OPEN','PARTIAL')`
        )
        .get() as { value: number }
    ).value;
    return (exposure / portfolioValueUsd) * 100;
  }

  private positionsInNarrative(narrative: string): number {
    const rows = this.requireDb()
      .prepare("SELECT token_mint FROM positions WHERE status IN ('OPEN','PARTIAL')")
      .all() as Array<{ token_mint: string }>;
    return rows.filter((row) => this.stringConfig(`token:${row.token_mint}:narrative`) === narrative).length;
  }

  private portfolioHeatPct(portfolioValueUsd: number): number {
    if (portfolioValueUsd <= 0) return 0;
    const rows = this.requireDb()
      .prepare("SELECT amount_token, entry_price_usd, stop_loss_price FROM positions WHERE status IN ('OPEN','PARTIAL')")
      .all() as Array<{ amount_token: number; entry_price_usd: number; stop_loss_price: number | null }>;
    return rows.reduce((sum, row) => {
      const valuePct = ((row.amount_token * row.entry_price_usd) / portfolioValueUsd) * 100;
      const stopDistance = row.stop_loss_price ? Math.max(0, (row.entry_price_usd - row.stop_loss_price) / row.entry_price_usd) : 0.25;
      return sum + valuePct * stopDistance;
    }, 0);
  }

  private sumPnlSince(since: number): number {
    const row = this.requireDb()
      .prepare("SELECT COALESCE(SUM(pnl_usd), 0) AS pnl FROM executions WHERE direction = 'SELL' AND closed_at >= ?")
      .get(since) as { pnl: number };
    return row.pnl ?? 0;
  }

  private lossStreak(): number {
    // Only fills from the trailing window count: five dust losses from a
    // year ago must never gate today's entries. LIMIT is generous because
    // dust fills are skipped, not counted.
    const since = unixNow() - LOSS_STREAK_WINDOW_SECONDS;
    const rows = this.requireDb()
      .prepare(
        "SELECT pnl_usd FROM executions WHERE direction = 'SELL' AND status = 'FILLED' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 50"
      )
      .all(since) as Array<{ pnl_usd: number | null }>;
    let streak = 0;
    for (const row of rows) {
      const pnl = row.pnl_usd ?? 0;
      if (Math.abs(pnl) < LOSS_STREAK_EPSILON_USD) continue;
      if (pnl < 0) streak += 1;
      else break;
      if (streak >= 5) break;
    }
    return streak;
  }

  private latestSellFillId(): number {
    const row = this.requireDb()
      .prepare("SELECT MAX(id) AS id FROM executions WHERE direction = 'SELL' AND status = 'FILLED'")
      .get() as { id: number | null };
    return row.id ?? 0;
  }

  private winRateLast30(): number | null {
    const rows = this.requireDb()
      .prepare("SELECT pnl_usd FROM executions WHERE direction = 'SELL' AND status = 'FILLED' ORDER BY closed_at DESC LIMIT 30")
      .all() as Array<{ pnl_usd: number | null }>;
    if (rows.length < 30) return null;
    return (rows.filter((row) => (row.pnl_usd ?? 0) > 0).length / rows.length) * 100;
  }

  private pauseEntries(seconds: number, reason: string): void {
    this.setConfig("entries_paused_until", String(unixNow() + seconds));
    this.setConfig("entries_pause_reason", reason);
  }

  private numberConfig(key: string): number | null {
    const value = this.stringConfig(key);
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private stringConfig(key: string): string | null {
    const row = this.requireDb().prepare("SELECT value FROM execution_config WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setConfig(key: string, value: string): void {
    this.requireDb()
      .prepare(
        `INSERT INTO execution_config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, unixNow());
  }

  private ensurePaperBalance(): void {
    if (!this.db) return;
    const existing = this.stringConfig("paper_balance_usd");
    if (existing === null) this.setConfig("paper_balance_usd", String(config.execution.paperInitialBalance));
  }

  private requireDb(): AppDatabase {
    if (!this.db) throw new Error("RiskEngine is not configured");
    return this.db;
  }
}

export const riskEngine = new RiskEngine();
