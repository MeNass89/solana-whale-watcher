import type { HeliusClient } from "../blockchain/helius-client.js";
import type { WalletModel } from "../storage/models/wallets.js";
import type { DiscordAlerter } from "../alerts/discord.js";
import { logger } from "../utils/logger.js";

export async function checkWebhookHealth(
  helius: HeliusClient,
  webhookId: string,
  publicWebhookUrl: string,
  discord: DiscordAlerter,
  wallets?: WalletModel
): Promise<void> {
  if (!webhookId) {
    logger.warn("webhook-health: no HELIUS_WEBHOOK_ID configured, skipping");
    return;
  }

  const webhook = await helius.getWebhook(webhookId);

  if (!webhook) {
    logger.warn({ webhookId }, "webhook-health: webhook not found or unreachable — attempting re-enable");
    const addresses = wallets ? wallets.listActive().map((w) => w.address) : [];
    try {
      await helius.updateWebhook(webhookId, addresses, publicWebhookUrl);
      logger.info({ webhookId }, "webhook-health: webhook re-enabled successfully");
      await discord.send({
        embeds: [{
          title: "🔧 Webhook Auto-Healed",
          description: `Webhook \`${webhookId.substring(0, 8)}…\` was disabled/unreachable and has been re-enabled with ${addresses.length} wallets.`,
          color: 0xffcc00,
          timestamp: new Date().toISOString()
        }]
      }, "NOTABLE");
    } catch (error) {
      logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "webhook-health: re-enable failed");
      await discord.send({
        embeds: [{
          title: "🚨 Webhook Re-Enable FAILED",
          description: `Webhook \`${webhookId.substring(0, 8)}…\` could not be re-enabled. Manual intervention required.`,
          color: 0xff3366,
          timestamp: new Date().toISOString()
        }]
      }, "CRITICAL");
    }
    return;
  }

  logger.info({ webhookId: webhookId.substring(0, 8), addresses: webhook.accountAddresses?.length ?? 0 }, "webhook-health: webhook OK");
}
