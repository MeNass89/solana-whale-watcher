import { config } from "../config/index.js";
import { getThreshold } from "../config/thresholds.js";
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

export class ConvergenceEngine {
  constructor(
    private readonly trades: TradeModel,
    private readonly convergences: ConvergenceModel,
    private readonly wallets: WalletModel,
    private readonly tokens: TokenModel,
    private readonly resolver: TokenResolver,
    private readonly db?: AppDatabase
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

    if (this.db) {
      const signals = computeManipulationSignals(recentBuys, recentSells, this.wallets, this.db);
      score = applyManipulationPenalty(score, signals);
      if (score < 10) return null;
    }

    let tier: "CRITICAL" | "NOTABLE" | "WATCH" = score >= 75 ? "CRITICAL" : score >= 40 ? "NOTABLE" : "WATCH";

    const tierWindowSeconds = tier === "CRITICAL" ? 30 * 60 : tier === "NOTABLE" ? 60 * 60 : windowSeconds;
    if (tierWindowSeconds < windowSeconds) {
      const tierSince = Math.floor(Date.now() / 1000) - tierWindowSeconds;
      const tierWallets = new Set(recentBuys.filter((t) => t.block_time >= tierSince).map((t) => t.wallet_address));
      if (tierWallets.size < threshold) {
        tier = tier === "CRITICAL" ? "NOTABLE" : "WATCH";
      }
    }

    if (this.convergences.wasRecentlyAlerted(newTrade.tokenMint, tier, 30)) return null;

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

    if (this.db) {
      discoverCoBuyers(this.db, this.wallets, convergence.token_mint, convergence.first_trade_at, config.convergence.windowMinutes).catch((error) => {
        logger.warn({ err: error instanceof Error ? error : new Error(String(error)) }, "co-buyer scan failed");
      });
    }
  }
}

function totalUsd(trades: TradeRow[]): number | undefined {
  const values = trades.map((trade) => trade.amount_usd).filter((value): value is number => value !== null);
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0);
}
