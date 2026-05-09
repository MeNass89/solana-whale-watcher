import type { FastifyInstance } from "fastify";
import { verifyHeliusHmac } from "../middleware/hmac.js";
import { parseEnhancedTransactions, isRapidReversal } from "../../blockchain/transaction-parser.js";
import type { AlertManager } from "../../engine/alert-manager.js";
import type { ConvergenceEngine } from "../../engine/convergence.js";
import type { AppDatabase } from "../../storage/database.js";
import type { ConvergenceModel } from "../../storage/models/convergences.js";
import type { TradeModel } from "../../storage/models/trades.js";
import type { WalletModel } from "../../storage/models/wallets.js";
import { logger, logWallet } from "../../utils/logger.js";
import { positionManager } from "../../execution/position-manager.js";
import { formatWhaleTradeMessage } from "../../alerts/formatter.js";
import { DiscordAlerter } from "../../alerts/discord.js";

const WHALE_ALERT_MIN_SCORE = 40;

export async function registerWebhookRoutes(
  app: FastifyInstance,
  deps: {
    db: AppDatabase;
    wallets: WalletModel;
    trades: TradeModel;
    convergences: ConvergenceModel;
    engine: ConvergenceEngine;
    alerts: AlertManager;
  }
): Promise<void> {
  const whaleDiscord = new DiscordAlerter();

  app.post("/api/webhooks/helius", { preHandler: verifyHeliusHmac }, async (request, reply) => {
    const activeWallets = new Set(deps.wallets.listActive().map((wallet) => wallet.address));
    const parsedTrades = parseEnhancedTransactions(request.body, activeWallets);

    for (const trade of parsedTrades) {
      if (isRapidReversal(trade)) {
        logger.info({ wallet: logWallet(trade.walletAddress), token: trade.tokenMint, type: trade.tradeType }, "rapid-reversal filtered (MEV suspect) — not persisted");
        continue;
      }
      const preSellBalance = trade.tradeType === "SELL"
        ? computePreSellBalance(deps.db, trade.walletAddress, trade.tokenMint, trade.blockTime, trade.txSignature)
        : 0;
      const inserted = deps.trades.insert(trade);
      if (!inserted) continue;
      deps.wallets.markTrade(trade.walletAddress, trade.blockTime);
      logger.info({ wallet: logWallet(trade.walletAddress), token: trade.tokenMint, type: trade.tradeType }, "trade ingested");

      const wallet = deps.wallets.find(trade.walletAddress);
      if (wallet && wallet.score >= WHALE_ALERT_MIN_SCORE) {
        whaleDiscord.send(formatWhaleTradeMessage(trade, wallet), "NOTABLE").catch(() => {});
      }

      if (trade.tradeType === "SELL") {
        const sellPct = trade.amountToken && preSellBalance > 0 ? (trade.amountToken / preSellBalance) * 100 : 0;
        await positionManager.onWhaleSell(trade.walletAddress, trade.tokenMint, sellPct);
      }

      const convergence = await deps.engine.checkConvergence(trade);
      if (convergence) {
        const trades = deps.convergences.tradesForConvergence(convergence.id);
        await deps.alerts.dispatch(convergence, trades);
      }
    }

    await reply.send({ ok: true, trades: parsedTrades.length });
  });
}

function computePreSellBalance(
  db: AppDatabase,
  walletAddress: string,
  tokenMint: string,
  beforeBlockTime: number,
  excludeTxSignature: string
): number {
  const row = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN trade_type = 'BUY' THEN amount_token ELSE 0 END), 0) AS bought,
        COALESCE(SUM(CASE WHEN trade_type = 'SELL' THEN amount_token ELSE 0 END), 0) AS sold
       FROM trades
       WHERE wallet_address = ?
         AND token_mint = ?
         AND (block_time < ? OR (block_time = ? AND tx_signature != ?))`
    )
    .get(walletAddress, tokenMint, beforeBlockTime, beforeBlockTime, excludeTxSignature) as { bought: number; sold: number };
  return Math.max(0, row.bought - row.sold);
}
