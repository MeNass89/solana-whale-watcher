import { config } from "../config/index.js";
import type { TokenResolver } from "../blockchain/token-resolver.js";
import type { ITradeEvent } from "../blockchain/types.js";
import type { AppDatabase } from "../storage/database.js";
import type { ConvergenceModel, ConvergenceRow } from "../storage/models/convergences.js";
import type { TokenModel } from "../storage/models/tokens.js";
import type { TradeModel, TradeRow } from "../storage/models/trades.js";
import type { WalletModel } from "../storage/models/wallets.js";
import { passesMvpFilters } from "./filters.js";
import { computeMvpScore } from "./scorer.js";
import { tradeExecutor } from "../execution/trade-executor.js";
import { discoverCoBuyers } from "../jobs/co-buyer-scanner.js";
import { logger } from "../utils/logger.js";

const CONVERGENCE_THRESHOLD = 2;
const MAX_SELL_RATIO = 0.3;

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
    const nowSeconds = Math.floor(Date.now() / 1000);
    const since = nowSeconds - windowSeconds;
    const recentBuys = this.trades.findByTokenInWindow(newTrade.tokenMint, since, "BUY");
    const uniqueWallets = new Set(recentBuys.map((trade) => trade.wallet_address));
    if (uniqueWallets.size < CONVERGENCE_THRESHOLD) return null;

    const metadata = await this.resolver.resolve(newTrade.tokenMint).catch(() => ({ mint: newTrade.tokenMint }));
    if (!passesMvpFilters(newTrade.tokenMint, recentBuys, this.tokens, metadata)) return null;

    const recentSells = this.trades.findByTokenInWindow(newTrade.tokenMint, since, "SELL");
    if (recentSells.length > 0 && recentSells.length / (recentBuys.length + recentSells.length) > MAX_SELL_RATIO) return null;

    const tier = uniqueWallets.size >= 3 ? "CRITICAL" : "NOTABLE";

    const convergence = this.convergences.create({
      tokenMint: newTrade.tokenMint,
      tokenSymbol: "symbol" in metadata ? metadata.symbol : undefined,
      // Composite score (wallet count + wallet quality + USD volume +
      // velocity) instead of the old bare walletCount * 30.
      score: computeMvpScore(recentBuys, this.wallets.scoresFor([...uniqueWallets])),
      tier,
      walletCount: uniqueWallets.size,
      totalUsd: totalUsd(recentBuys),
      firstTradeAt: Math.min(...recentBuys.map((trade) => trade.block_time)),
      lastTradeAt: Math.max(...recentBuys.map((trade) => trade.block_time)),
      windowMinutes: config.convergence.windowMinutes,
      trades: recentBuys
    });

    logger.info(
      { token: newTrade.tokenMint, tier, walletCount: uniqueWallets.size },
      "convergence detected — executing"
    );
    this.executeConvergence(convergence, recentBuys);
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
