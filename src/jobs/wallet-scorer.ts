import type { HeliusClient } from "../blockchain/helius-client.js";
import type { TradeModel } from "../storage/models/trades.js";
import type { WalletModel } from "../storage/models/wallets.js";
import type { WalletMonitor } from "../blockchain/wallet-monitor.js";
import { computeWalletMetrics } from "../engine/scorer.js";
import { logger } from "../utils/logger.js";

const BATCH_SIZE = 50;
const THIRTY_DAYS_SEC = 30 * 86400;
const HELIUS_TX_LIMIT = 300;

export async function runWalletScorer(
  wallets: WalletModel,
  trades: TradeModel,
  helius: HeliusClient,
  monitor?: WalletMonitor
): Promise<void> {
  const queue = wallets.findScoringQueue(BATCH_SIZE);
  if (queue.length === 0) {
    logger.info("wallet-scorer: no wallets in scoring queue");
    return;
  }

  logger.info({ count: queue.length }, "wallet-scorer: scoring batch");
  const since = Math.floor(Date.now() / 1000) - THIRTY_DAYS_SEC;
  let promoted = 0;
  let demoted = 0;

  for (const wallet of queue) {
    try {
      const dbTrades = trades.findByWalletSince(wallet.address, since);
      const heliusTxs = await helius.getWalletTransactions(wallet.address, HELIUS_TX_LIMIT);

      const metrics = computeWalletMetrics(dbTrades, heliusTxs, wallet.address, wallet.state);
      const oldState = wallet.state;

      wallets.updateScore(wallet.address, {
        score: metrics.score,
        winRate: metrics.winRate,
        avgRoi: metrics.avgRoi,
        totalTrades: metrics.totalTrades,
        state: metrics.state,
      });

      if (metrics.state === "ACTIVE" && oldState !== "ACTIVE") promoted++;
      if ((metrics.state === "DEMOTED" || metrics.state === "DORMANT") && oldState !== "DEMOTED" && oldState !== "DORMANT") demoted++;

      logger.info({
        address: wallet.address.substring(0, 12),
        score: metrics.score,
        winRate: metrics.winRate,
        avgRoi: metrics.avgRoi,
        trades: metrics.totalTrades,
        pnl: metrics.realizedPnlSol,
        transition: oldState !== metrics.state ? `${oldState} → ${metrics.state}` : metrics.state,
      }, "wallet-scorer: scored");
    } catch (error) {
      logger.warn({ address: wallet.address.substring(0, 12), err: error instanceof Error ? error : new Error(String(error)) }, "wallet-scorer: failed to score wallet");
    }
  }

  const MIN_ACTIVE_POOL = 20;
  const activeCount = wallets.countByState("ACTIVE");
  if (activeCount < MIN_ACTIVE_POOL) {
    const deficit = MIN_ACTIVE_POOL - activeCount;
    const forcePromoted = wallets.promoteTopN(deficit);
    promoted += forcePromoted;
    logger.info({ activeCount, deficit, forcePromoted }, "wallet-scorer: force-promoted to meet minimum pool");
  }

  if (demoted > 0 || promoted > 0) {
    try {
      await monitor?.syncWebhook();
      logger.info({ promoted, demoted }, "wallet-scorer: webhook synced after state changes");
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error : new Error(String(error)) }, "wallet-scorer: webhook sync failed");
    }
  }

  logger.info({ scored: queue.length, promoted, demoted }, "wallet-scorer: batch complete");
}
