import type { HeliusClient } from "../blockchain/helius-client.js";
import { HeliusRequestError } from "../blockchain/helius-client.js";
import type { WalletModel } from "../storage/models/wallets.js";
import type { DiscordAlerter } from "../alerts/discord.js";
import { logger } from "../utils/logger.js";

const WEBHOOK_HEALTH_429_MAX_RETRIES = 3;
const WEBHOOK_HEALTH_429_BASE_DELAY_MS = 5_000;

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

  let webhook: Awaited<ReturnType<HeliusClient["getWebhook"]>>;
  try {
    webhook = await getWebhookWithRetry(helius, webhookId);
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error : new Error(String(error)), webhookId },
      "webhook-health: getWebhook failed (transient/auth/network) — skipping heal to avoid thrashing Helius"
    );
    return;
  }

  const activeAddresses = wallets ? wallets.listActive().map((w) => w.address) : [];
  const needsHeal = !webhook || isDisabled(webhook) || (webhook.accountAddresses?.length ?? 0) === 0;

  if (needsHeal) {
    // If the local active list is transiently empty, use the webhook's
    // last-known-good addresses. Only both-empty is truly unrecoverable.
    const addresses = activeAddresses.length > 0
      ? activeAddresses
      : (webhook?.accountAddresses ?? []);
    if (addresses.length === 0) {
      logger.error({ webhookId }, "webhook-health: refusing to heal with empty wallet list — would unsubscribe the bot");
      await discord.send({
        embeds: [{
          title: "🚨 Webhook Heal SKIPPED — No Active Wallets",
          description: `Webhook \`${webhookId.substring(0, 8)}…\` is disabled/unreachable, but the active wallet list is empty. Manual intervention required.`,
          color: 0xff3366,
          timestamp: new Date().toISOString()
        }]
      }, "CRITICAL");
      return;
    }

    logger.warn({ webhookId, walletCount: addresses.length }, "webhook-health: webhook unhealthy — attempting re-enable");
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

  logger.info({ webhookId: webhookId.substring(0, 8), addresses: webhook!.accountAddresses?.length ?? 0 }, "webhook-health: webhook OK");
}

function isDisabled(webhook: { webhookType?: string } & Record<string, unknown>): boolean {
  const status = webhook["status"];
  if (typeof status === "string" && /disabled|inactive|paused/i.test(status)) return true;
  const enabled = webhook["enabled"];
  if (enabled === false) return true;
  return false;
}

/**
 * Retry getWebhook with exponential backoff on 429 (rate limit).
 * Other errors propagate immediately.
 */
async function getWebhookWithRetry(
  helius: HeliusClient,
  webhookId: string
): Promise<Awaited<ReturnType<HeliusClient["getWebhook"]>>> {
  for (let attempt = 0; attempt <= WEBHOOK_HEALTH_429_MAX_RETRIES; attempt++) {
    try {
      return await helius.getWebhook(webhookId);
    } catch (error) {
      const is429 =
        error instanceof HeliusRequestError && error.status === 429;
      if (!is429 || attempt === WEBHOOK_HEALTH_429_MAX_RETRIES) throw error;

      const delay = WEBHOOK_HEALTH_429_BASE_DELAY_MS * 2 ** attempt;
      logger.warn(
        { attempt, delay, webhookId },
        "webhook-health: getWebhook 429 — backing off"
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable, but satisfies TS
  return null;
}
