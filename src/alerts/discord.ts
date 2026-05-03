import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const MAX_RETRIES = 3;

export class DiscordAlerter {
  private nextSendAt = 0;

  async send(payload: Record<string, unknown>, tier: "CRITICAL" | "NOTABLE" | "WATCH"): Promise<boolean> {
    if (tier === "WATCH") return false;
    const webhookUrl = tier === "CRITICAL" && config.discord.criticalWebhookUrl
      ? config.discord.criticalWebhookUrl
      : config.discord.webhookUrl;
    if (!webhookUrl) {
      logger.warn("Discord webhook URL not configured; alert skipped");
      return false;
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const waitMs = Math.max(0, this.nextSendAt - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      this.nextSendAt = Date.now() + 1_100;

      if (response.ok) return true;

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") || "2");
        logger.warn({ retryAfter, attempt }, "Discord rate limited, backing off");
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }

      logger.error({ status: response.status, body: await response.text() }, "Discord alert failed");
      return false;
    }
    logger.error("Discord alert failed after max retries");
    return false;
  }
}
