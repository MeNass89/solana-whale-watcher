import { config } from "../config/index.js";
import type { AlertTier } from "../blockchain/types.js";
import type { AppDatabase } from "../storage/database.js";
import type { ConvergenceRow } from "../storage/models/convergences.js";
import type { TradeRow } from "../storage/models/trades.js";
import { unixNow } from "../utils/helpers.js";

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
  adjustedSizePct?: number;
  phase?: RiskPhase;
  portfolioValueUsd?: number;
  sizeUsd?: number;
}

type RiskPhase = "cold_start" | "validated" | "mature";

interface PhaseLimits {
  base: number;
  notable: number;
  critical: number;
  cap: number;
  maxExposure: number;
  maxPositions: number;
}

const PHASE_LIMITS: Record<RiskPhase, PhaseLimits> = {
  cold_start: { base: 0.5, notable: 0.75, critical: 1.0, cap: 3, maxExposure: 40, maxPositions: 15 },
  validated: { base: 1.0, notable: 1.5, critical: 2.0, cap: 5, maxExposure: 50, maxPositions: 15 },
  mature: { base: 1.5, notable: 2.25, critical: 3.0, cap: 5, maxExposure: 60, maxPositions: 15 }
};

const MAX_POSITION_POOL_TVL_PCT = 0.5;
const MIN_POOL_TVL_USD = 100_000;
const MAX_HONEYPOT_ROUNDTRIP_LOSS_PCT = 8;
const MAX_FIRST_WHALE_MOVE_PCT = 15;
const MIN_WHALE_BUY_USD = 25_000;
const MAX_TOP_10_HOLDERS_PCT = 40;
const MIN_TOKEN_AGE_HOURS = 24;
const NEW_TOKEN_MIN_LP_USD = 50_000;
const MAX_PER_NARRATIVE = 3;
const PORTFOLIO_HEAT_CAP_PCT = 6;
const SOL_RESERVE = 5;
const MAX_POSITION_PORTFOLIO_PCT = 3;
const MAX_POSITION_USD = 3000;
const MAX_PRE_ENTRY_PUMP_PCT = 300;

export class RiskEngine {
  constructor(private db: AppDatabase | null = null) {}

  configure(db: AppDatabase): void {
    this.db = db;
    this.ensurePaperBalance();
  }

  checkEntry(convergence: ConvergenceRow, trades: TradeRow[], entryPriceUsd: number): RiskCheck {
    const db = this.requireDb();
    const phase = this.phase();
    const limits = PHASE_LIMITS[phase];
    const portfolioValueUsd = this.portfolioValueUsd();
    const baseSizePct = sizeForTier(convergence.tier, limits);
    const volatility = this.numberConfig(`token:${convergence.token_mint}:realized_vol_24h_pct`);
    const volAdj = volatility && volatility > 0 ? Math.min(1, 80 / volatility) : 1;
    const drawdownHalve = this.stringConfig("drawdown_halve_sizes") === "true" ? 0.5 : 1;
    const adjustedSizePct = Math.min(limits.cap, baseSizePct * volAdj * drawdownHalve);
    const sizeUsd = (portfolioValueUsd * adjustedSizePct) / 100;

    const circuitBreaker = this.circuitBreakerReason(portfolioValueUsd);
    if (circuitBreaker) return { allowed: false, reason: circuitBreaker, phase, portfolioValueUsd };

    const liquidityUsd = this.tokenLiquidity(convergence.token_mint);
    if (liquidityUsd === null) return { allowed: false, reason: "pool TVL unavailable", phase, portfolioValueUsd };
    if (liquidityUsd < MIN_POOL_TVL_USD) return { allowed: false, reason: "pool TVL below $100k", phase, portfolioValueUsd };
    if ((sizeUsd / liquidityUsd) * 100 > MAX_POSITION_POOL_TVL_PCT) {
      return { allowed: false, reason: "position exceeds 0.5% of pool TVL", phase, portfolioValueUsd };
    }

    const maxWhaleBuyUsd = Math.max(...trades.map((trade) => trade.amount_usd ?? 0));
    if (maxWhaleBuyUsd < MIN_WHALE_BUY_USD) return { allowed: false, reason: "whale buy below $25k", phase, portfolioValueUsd };

    const firstWhalePrice = this.numberConfig(`token:${convergence.token_mint}:first_whale_price_usd`);
    if (firstWhalePrice && Math.abs(((entryPriceUsd - firstWhalePrice) / firstWhalePrice) * 100) > MAX_FIRST_WHALE_MOVE_PCT) {
      return { allowed: false, reason: "token moved more than 15% since first whale fill", phase, portfolioValueUsd };
    }

    const creationPrice = this.numberConfig(`token:${convergence.token_mint}:creation_price_usd`);
    if (creationPrice && creationPrice > 0) {
      const pumpPct = ((entryPriceUsd - creationPrice) / creationPrice) * 100;
      if (pumpPct > MAX_PRE_ENTRY_PUMP_PCT) {
        return { allowed: false, reason: `token already pumped ${Math.round(pumpPct)}% from creation (max ${MAX_PRE_ENTRY_PUMP_PCT}%)`, phase, portfolioValueUsd };
      }
    }

    const honeypotLoss = this.numberConfig(`token:${convergence.token_mint}:honeypot_roundtrip_loss_pct`);
    if (honeypotLoss !== null && honeypotLoss > MAX_HONEYPOT_ROUNDTRIP_LOSS_PCT) {
      return { allowed: false, reason: "honeypot roundtrip loss above 8%", phase, portfolioValueUsd };
    }

    const mintRenounced = this.stringConfig(`token:${convergence.token_mint}:mint_authority_renounced`);
    if (mintRenounced === "false") return { allowed: false, reason: "mint authority not renounced", phase, portfolioValueUsd };

    const top10Pct = this.numberConfig(`token:${convergence.token_mint}:top10_holders_pct`);
    if (top10Pct !== null && top10Pct > MAX_TOP_10_HOLDERS_PCT) {
      return { allowed: false, reason: "top 10 holders above 40% supply", phase, portfolioValueUsd };
    }

    const tokenAgeHours = this.numberConfig(`token:${convergence.token_mint}:age_hours`);
    if (tokenAgeHours !== null && tokenAgeHours < MIN_TOKEN_AGE_HOURS && liquidityUsd < NEW_TOKEN_MIN_LP_USD) {
      return { allowed: false, reason: "token age below 24h and LP below $50k", phase, portfolioValueUsd };
    }

    const openPositions = (
      db.prepare("SELECT COUNT(*) AS count FROM positions WHERE status IN ('OPEN','PARTIAL')").get() as { count: number }
    ).count;
    if (openPositions >= limits.maxPositions) return { allowed: false, reason: "max open positions reached", phase, portfolioValueUsd };

    const exposurePct = this.openExposurePct(portfolioValueUsd);
    if (exposurePct + adjustedSizePct > limits.maxExposure) {
      return { allowed: false, reason: "portfolio exposure limit exceeded", phase, portfolioValueUsd };
    }

    const narrative = this.stringConfig(`token:${convergence.token_mint}:narrative`);
    if (narrative && this.positionsInNarrative(narrative) >= MAX_PER_NARRATIVE) {
      return { allowed: false, reason: "max per narrative reached", phase, portfolioValueUsd };
    }

    if (this.portfolioHeatPct(portfolioValueUsd) + adjustedSizePct * 0.25 > PORTFOLIO_HEAT_CAP_PCT) {
      return { allowed: false, reason: "portfolio heat cap exceeded", phase, portfolioValueUsd };
    }

    const solBalance = this.numberConfig("wallet:sol_balance");
    if (config.execution.mode === "live" && solBalance !== null && solBalance < SOL_RESERVE) {
      return { allowed: false, reason: "SOL reserve below 5 SOL", phase, portfolioValueUsd };
    }

    const hardCapUsd = Math.min(portfolioValueUsd * MAX_POSITION_PORTFOLIO_PCT / 100, MAX_POSITION_USD);
    const finalSizeUsd = Math.min(sizeUsd, hardCapUsd);
    const finalSizePct = (finalSizeUsd / portfolioValueUsd) * 100;

    return { allowed: true, adjustedSizePct: finalSizePct, phase, portfolioValueUsd, sizeUsd: finalSizeUsd };
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
      return "drawdown -20%: close all positions, freeze 7d";
    }
    if (drawdownPct <= -15) return "drawdown pause entries at -15%";
    if (drawdownPct <= -10) this.setConfig("drawdown_halve_sizes", "true");
    else this.setConfig("drawdown_halve_sizes", "false");
    if (this.lossStreak() >= 5) {
      this.pauseEntries(6 * 60 * 60, "5 consecutive losses");
      return "5 consecutive losses";
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

  private phase(): RiskPhase {
    const filled = (
      this.requireDb().prepare("SELECT COUNT(*) AS count FROM executions WHERE status = 'FILLED'").get() as { count: number }
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
    const rows = this.requireDb()
      .prepare("SELECT pnl_usd FROM executions WHERE direction = 'SELL' AND status = 'FILLED' ORDER BY closed_at DESC LIMIT 5")
      .all() as Array<{ pnl_usd: number | null }>;
    let streak = 0;
    for (const row of rows) {
      if ((row.pnl_usd ?? 0) < 0) streak += 1;
      else break;
    }
    return streak;
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

function sizeForTier(tier: AlertTier, limits: PhaseLimits): number {
  if (tier === "CRITICAL") return limits.critical;
  if (tier === "NOTABLE") return limits.notable;
  return limits.base;
}

export const riskEngine = new RiskEngine();
