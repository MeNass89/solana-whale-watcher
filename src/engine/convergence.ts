import { config } from "../config/index.js";
import { getMinWalletsForTier, getThreshold } from "../config/thresholds.js";
import type { TokenResolver } from "../blockchain/token-resolver.js";
import type { ITradeEvent } from "../blockchain/types.js";
import type { AppDatabase } from "../storage/database.js";
import type { ConvergenceModel, ConvergenceRow } from "../storage/models/convergences.js";
import type { TokenModel } from "../storage/models/tokens.js";
import type { TradeModel, TradeRow } from "../storage/models/trades.js";
import type { WalletModel } from "../storage/models/wallets.js";
import { passesMvpFilters } from "./filters.js";
import { computeMvpScore, applyManipulationPenalty } from "./scorer.js";
import { computeManipulationSignals } from "./manipulation-detector.js";
import { tradeExecutor } from "../execution/trade-executor.js";
import { discoverCoBuyers } from "../jobs/co-buyer-scanner.js";
import { logger } from "../utils/logger.js";

// V1 alpha trigger: require meaningful 30d realized SOL profit across enough closed cycles.
const TOP_ALPHA_REALIZED_SOL_30D = 100;
const TOP_ALPHA_MIN_CLOSED_30D = 5;

export class ConvergenceEngine {
  constructor(
    private readonly trades: TradeModel,
    private readonly convergences: ConvergenceModel,
    private readonly wallets: WalletModel,
    private readonly tokens: TokenModel,
    private readonly resolver: TokenResolver,
    private readonly db: AppDatabase
  ) {}

  async checkConvergence(newTrade: ITradeEvent): Promise<ConvergenceRow | null> {
    if (newTrade.tradeType !== "BUY") return null;

    const windowSeconds = config.convergence.windowMinutes * 60;
    const since = Math.floor(Date.now() / 1000) - windowSeconds;
    const recentBuys = this.trades.findByTokenInWindow(newTrade.tokenMint, since, "BUY");
    const uniqueWallets = new Set(recentBuys.map((trade) => trade.wallet_address));
    const totalActive = this.wallets.countActive();
    const coreCount = this.wallets.countByState("ACTIVE");
    const threshold = getThreshold(coreCount, totalActive);
    if (uniqueWallets.size < threshold) return null;

    const metadata = await this.resolver.resolve(newTrade.tokenMint).catch(() => ({ mint: newTrade.tokenMint }));
    if (!passesMvpFilters(newTrade.tokenMint, recentBuys, this.tokens, metadata)) return null;

    const recentSells = this.trades.findByTokenInWindow(newTrade.tokenMint, since, "SELL");
    if (recentSells.length > 0 && recentSells.length / (recentBuys.length + recentSells.length) > 0.3) return null;

    const total = totalUsd(recentBuys);
    let score = computeMvpScore(recentBuys, this.wallets.scoresFor([...uniqueWallets]));

    const signals = computeManipulationSignals(recentBuys, recentSells, this.wallets, this.db);
    score = applyManipulationPenalty(score, signals);

    let tier = pickTier(score, uniqueWallets.size);

    // Iteratively downgrade until the tier's tighter window has enough wallets.
    // A single-step downgrade can land on a tier whose own window still doesn't
    // satisfy its min-wallet floor (e.g. CRITICAL→NOTABLE where the 60min window
    // also has too few unique wallets).
    while (tier !== "WATCH") {
      const tierWindowSeconds = tier === "CRITICAL" ? 30 * 60 : tier === "NOTABLE" ? 60 * 60 : windowSeconds;
      if (tierWindowSeconds >= windowSeconds) break;
      const tierSince = Math.floor(Date.now() / 1000) - tierWindowSeconds;
      const tierWallets = new Set(recentBuys.filter((t) => t.block_time >= tierSince).map((t) => t.wallet_address));
      if (tierWallets.size >= getMinWalletsForTier(tier)) break;
      tier = tier === "CRITICAL" ? "NOTABLE" : "WATCH";
    }

    const quality = this.wallets.qualityFor([...uniqueWallets]);
    const resolvedQuality = [...uniqueWallets].map((addr) => quality.get(addr));
    const triggers = resolvedQuality.filter((q): q is NonNullable<typeof q> => Boolean(q));
    const unresolvedCount = resolvedQuality.length - triggers.length;

    // Reject only when EVERY trigger resolved AND every resolved one is bad —
    // missing lookups stay neutral (don't flip allBad on a partial subset).
    const allBad =
      triggers.length > 0 &&
      unresolvedCount === 0 &&
      triggers.every(
        (q) =>
          q.wallet_class === "loser" ||
          q.wallet_class === "accumulation_bot" ||
          (q.wallet_class === "incomplete" && q.n_closed_30d === 0)
      );
    if (allBad) {
      logger.info({ token: newTrade.tokenMint, walletCount: uniqueWallets.size }, "convergence rejected: no proven-alpha trigger");
      return null;
    }

    const hasTopAlpha = triggers.some(
      (q) => q.realized_sol_30d > TOP_ALPHA_REALIZED_SOL_30D && q.n_closed_30d >= TOP_ALPHA_MIN_CLOSED_30D
    );
    const avgPnl = triggers.reduce((sum, q) => sum + (q.realized_sol_30d ?? 0), 0) / Math.max(triggers.length, 1);

    if (hasTopAlpha) {
      const boosted = tier === "WATCH" ? "NOTABLE" : tier === "NOTABLE" ? "CRITICAL" : tier;
      tier = pickTier(scoreForTier(boosted), uniqueWallets.size, boosted);
      logger.info({ token: newTrade.tokenMint, avgPnl, hasTopAlpha: true, tier }, "tier boosted by alpha trigger (re-validated against wallet floor)");
    }

    const convergence = this.convergences.create({
      tokenMint: newTrade.tokenMint,
      tokenSymbol: "symbol" in metadata ? metadata.symbol : undefined,
      score,
      tier,
      walletCount: uniqueWallets.size,
      totalUsd: total,
      firstTradeAt: Math.min(...recentBuys.map((trade) => trade.block_time)),
      lastTradeAt: Math.max(...recentBuys.map((trade) => trade.block_time)),
      windowMinutes: config.convergence.windowMinutes,
      trades: recentBuys
    });
    if (tier !== "WATCH") this.executeConvergence(convergence, recentBuys);
    return convergence;
  }

  async retryPendingExecutions(): Promise<void> {
    for (const convergence of this.convergences.pendingExecutionRetries(5 * 60, 3)) {
      this.executeConvergence(convergence, this.convergences.tradesForConvergence(convergence.id));
    }
  }

  private executeConvergence(convergence: ConvergenceRow, trades: TradeRow[]): void {
    const attempt = this.convergences.incrementExecutionAttempts(convergence.id);
    tradeExecutor.onConvergence(convergence, trades).catch((error) => {
      this.convergences.markOutcome(convergence.id, "FAILED");
      logger.error({ error, convergenceId: convergence.id, attempt }, "trade execution failed for convergence");
    });

    discoverCoBuyers(this.db, this.wallets, convergence.token_mint, convergence.first_trade_at, config.convergence.windowMinutes).catch((error) => {
      logger.warn({ err: error instanceof Error ? error : new Error(String(error)) }, "co-buyer scan failed");
    });
  }
}

function totalUsd(trades: TradeRow[]): number | undefined {
  const values = trades.map((trade) => trade.amount_usd).filter((value): value is number => value !== null);
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0);
}

type ConvergenceTier = "CRITICAL" | "NOTABLE" | "WATCH";

// Pick the highest tier whose score floor AND wallet floor are both satisfied.
// `preferred` lets a boosted tier propose itself; we still validate against
// getMinWalletsForTier so a boost on too-few wallets falls back cleanly.
function pickTier(score: number, walletCount: number, preferred?: ConvergenceTier): ConvergenceTier {
  const candidates: ConvergenceTier[] = preferred
    ? [preferred, ...(["CRITICAL", "NOTABLE", "WATCH"] as ConvergenceTier[]).filter((t) => t !== preferred)]
    : (["CRITICAL", "NOTABLE", "WATCH"] as ConvergenceTier[]);
  for (const tier of candidates) {
    const minScore = scoreForTier(tier);
    if (score >= minScore && walletCount >= getMinWalletsForTier(tier)) return tier;
  }
  return "WATCH";
}

function scoreForTier(tier: ConvergenceTier): number {
  if (tier === "CRITICAL") return 75;
  if (tier === "NOTABLE") return 40;
  return 0;
}
