import type { FastifyInstance } from "fastify";
import { verifyHeliusHmac } from "../middleware/hmac.js";
import { parseEnhancedTransactions, isRapidReversal } from "../../blockchain/transaction-parser.js";
import type { AlertManager } from "../../engine/alert-manager.js";
import type { ConvergenceEngine } from "../../engine/convergence.js";
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
      const inserted = deps.trades.insert(trade);
      if (isRapidReversal(trade)) {
        logger.info({ wallet: logWallet(trade.walletAddress), token: trade.tokenMint, type: trade.tradeType }, "rapid-reversal filtered (MEV suspect)");
        continue;
      }
      if (!inserted) continue;
      deps.wallets.markTrade(trade.walletAddress, trade.blockTime);
      logger.info({ wallet: logWallet(trade.walletAddress), token: trade.tokenMint, type: trade.tradeType }, "trade ingested");

      const wallet = deps.wallets.find(trade.walletAddress);
      if (wallet && wallet.score >= WHALE_ALERT_MIN_SCORE) {
        whaleDiscord.send(formatWhaleTradeMessage(trade, wallet), "NOTABLE").catch(() => {});
      }

      if (trade.tradeType === "SELL") {
        const sellPct = estimateSellPct(deps.trades, trade.walletAddress, trade.tokenMint, trade.amountToken);
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

function estimateSellPct(trades: TradeModel, walletAddress: string, tokenMint: string, amountToken?: number): number {
  if (!amountToken || amountToken <= 0) return 100;
  const buys = trades.findByWalletToken(walletAddress, tokenMint, "BUY");
  const totalBought = buys.reduce((sum, trade) => sum + (trade.amount_token ?? 0), 0);
  if (totalBought <= 0) return 100;
  return (amountToken / totalBought) * 100;
}
