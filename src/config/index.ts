import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")): void {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HELIUS_API_KEY: z.string().default(""),
  ALCHEMY_API_KEY: z.string().default(""),
  CHAINSTACK_RPC_URL: z.string().default(""),
  BIRDEYE_API_KEY: z.string().default(""),
  HELIUS_WEBHOOK_SECRET: z.string().min(1).default("dev-webhook-secret"),
  HELIUS_WEBHOOK_ID: z.string().optional().default(""),
  DISCORD_WEBHOOK_URL: z.string().url().optional().or(z.literal("")).default(""),
  DISCORD_WEBHOOK_URL_CRITICAL: z.string().url().optional().or(z.literal("")).default(""),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  API_AUTH_TOKEN: z.string().min(16).default("change-me-random-64-char-token"),
  PUBLIC_WEBHOOK_URL: z.string().url().optional().or(z.literal("")).default(""),
  CONVERGENCE_WINDOW_MINUTES: z.coerce.number().int().positive().default(120),
  MIN_TRADE_USD: z.coerce.number().nonnegative().default(500),
  MIN_TOKEN_AGE_HOURS: z.coerce.number().nonnegative().default(24),
  DATABASE_PATH: z.string().default("./data/whale-watcher.sqlite"),
  EXECUTION_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  EXECUTION_MODE: z.enum(["paper", "live"]).default("paper"),
  JITO_BLOCK_ENGINE_URL: z.string().url().default("https://mainnet.block-engine.jito.wtf"),
  JUPITER_API_KEY: z.string().default(""),
  PAPER_INITIAL_BALANCE: z.coerce.number().positive().default(10_000),
  SOLANA_WALLET_PUBLIC: z.string().default(""),
  SOLANA_WALLET_PRIVATE: z.string().default("")
});

const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production") {
  if (!env.HELIUS_WEBHOOK_SECRET || env.HELIUS_WEBHOOK_SECRET === "dev-webhook-secret") {
    throw new Error("HELIUS_WEBHOOK_SECRET must be set in production");
  }
  if (!env.API_AUTH_TOKEN || env.API_AUTH_TOKEN === "change-me-random-64-char-token") {
    throw new Error("API_AUTH_TOKEN must be set in production");
  }
  if (env.EXECUTION_ENABLED && env.EXECUTION_MODE === "live" && (!env.SOLANA_WALLET_PUBLIC || !env.SOLANA_WALLET_PRIVATE)) {
    throw new Error("SOLANA_WALLET_PUBLIC and SOLANA_WALLET_PRIVATE must be set for live execution");
  }
  if (!env.ALCHEMY_API_KEY || !env.CHAINSTACK_RPC_URL) {
    throw new Error("ALCHEMY_API_KEY and CHAINSTACK_RPC_URL must be set in production");
  }
  // BIRDEYE_API_KEY is intentionally NOT required in prod: every BirdEye client
  // method (getSolUsdAt, getTokenOverview, getWalletPnl, getHistoricalPrices)
  // checks `if (!this.apiKey)` and degrades to null/cached values. The risk
  // engine and wallet scorer all have DexScreener / DB fallbacks, so the system
  // stays operational without it — just with reduced enrichment quality.
}

export const config = {
  helius: {
    apiKey: env.HELIUS_API_KEY,
    webhookSecret: env.HELIUS_WEBHOOK_SECRET,
    webhookId: env.HELIUS_WEBHOOK_ID
  },
  rpc: {
    alchemyApiKey: env.ALCHEMY_API_KEY,
    chainstackUrl: env.CHAINSTACK_RPC_URL
  },
  birdeye: {
    apiKey: env.BIRDEYE_API_KEY
  },
  discord: {
    webhookUrl: env.DISCORD_WEBHOOK_URL,
    criticalWebhookUrl: env.DISCORD_WEBHOOK_URL_CRITICAL
  },
  server: {
    port: env.PORT,
    host: env.HOST,
    apiAuthToken: env.API_AUTH_TOKEN,
    publicWebhookUrl: env.PUBLIC_WEBHOOK_URL
  },
  convergence: {
    windowMinutes: env.CONVERGENCE_WINDOW_MINUTES,
    minTradeUsd: env.MIN_TRADE_USD,
    minTokenAgeHours: env.MIN_TOKEN_AGE_HOURS
  },
  databasePath: env.DATABASE_PATH,
  execution: {
    enabled: env.EXECUTION_ENABLED,
    mode: env.EXECUTION_MODE,
    jitoBlockEngineUrl: env.JITO_BLOCK_ENGINE_URL,
    jupiterApiKey: env.JUPITER_API_KEY,
    paperInitialBalance: env.PAPER_INITIAL_BALANCE,
    walletPublic: env.SOLANA_WALLET_PUBLIC,
    walletPrivate: env.SOLANA_WALLET_PRIVATE
  }
} as const;

export type AppConfig = typeof config;
