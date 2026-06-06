import type { TradeRow } from "../storage/models/trades.js";
import type { TokenModel } from "../storage/models/tokens.js";
import type { TokenMetadata } from "../blockchain/types.js";
import { config } from "../config/index.js";

const NOISE_MINTS = new Set<string>([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
]);

export function passesMvpFilters(tokenMint: string, buys: TradeRow[], tokens: TokenModel, metadata?: TokenMetadata): boolean {
  if (NOISE_MINTS.has(tokenMint)) return false;
  if (tokens.isBlacklisted(tokenMint)) return false;
  if (!buys.some((buy) => (buy.amount_usd ?? 0) >= config.convergence.minTradeUsd)) return false;

  const createdAt = tokenCreatedAt(metadata);
  if (createdAt !== null) {
    const ageSeconds = Math.floor(Date.now() / 1000) - createdAt;
    if (ageSeconds < 10 * 60) return false;
    if (ageSeconds < config.convergence.minTokenAgeHours * 60 * 60) return false;
  }

  return buys.length > 0;
}

function tokenCreatedAt(metadata?: TokenMetadata): number | null {
  const raw = metadata as (TokenMetadata & { created_at?: unknown; createdAt?: unknown }) | undefined;
  const value = raw?.created_at ?? raw?.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}
