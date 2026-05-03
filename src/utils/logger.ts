import pino from "pino";
import { truncateAddress } from "./helpers.js";

const redactions = [
  "config.helius.apiKey",
  "config.helius.webhookSecret",
  "config.discord.webhookUrl",
  "config.discord.criticalWebhookUrl",
  "config.server.apiAuthToken",
  "req.headers.authorization",
  "req.headers.x-api-token"
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: redactions,
    censor: "[redacted]"
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" }
        }
});

export function logWallet(address: string): string {
  return truncateAddress(address);
}
