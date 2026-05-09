import { HeliusClient } from "../blockchain/helius-client.js";
import type { AppDatabase } from "../storage/database.js";
import type { TokenModel } from "../storage/models/tokens.js";
import { unixNow } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

const DEXSCREENER_URL = "https://api.dexscreener.com/tokens/v1/solana";
const BATCH_SIZE = 30;
const RATE_LIMIT_MS = 1200;

interface DexScreenerPair {
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number; h6?: number; h1?: number };
  baseToken?: { address?: string };
}

export async function runTokenMetadata(db: AppDatabase, tokens: TokenModel): Promise<void> {
  const mints = activeTokenMints(db);
  if (mints.length === 0) return;

  const helius = new HeliusClient();
  let updated = 0;

  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const batch = mints.slice(i, i + BATCH_SIZE);
    const dex = await fetchDexScreener(batch);

    for (const mint of batch) {
      try {
        const pair = dex.get(mint);
        if (pair) {
          setConfig(db, `token:${mint}:realized_vol_24h_pct`, String(Math.abs(pair.priceChange?.h24 ?? 0)));
          const existing = tokens.findByMint(mint);
          if (existing) {
            tokens.upsert({ ...existing, liquidityUsd: pair.liquidity?.usd ?? existing.liquidityUsd });
          }
        }

        await refreshHelius(db, helius, mint);
        updated++;
      } catch (err) {
        logger.warn({ mint, err }, "token-metadata: failed for token");
      }
    }

    if (i + BATCH_SIZE < mints.length) await sleep(RATE_LIMIT_MS);
  }

  logger.info({ total: mints.length, updated }, "token-metadata: refresh complete");
}

async function fetchDexScreener(mints: string[]): Promise<Map<string, DexScreenerPair>> {
  const result = new Map<string, DexScreenerPair>();
  try {
    const res = await fetch(`${DEXSCREENER_URL}/${mints.join(",")}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "token-metadata: DexScreener request failed");
      return result;
    }
    const pairs = (await res.json()) as DexScreenerPair[];
    if (!Array.isArray(pairs)) return result;

    for (const pair of pairs) {
      const addr = pair.baseToken?.address;
      if (!addr || !mints.includes(addr)) continue;
      const existing = result.get(addr);
      if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
        result.set(addr, pair);
      }
    }
  } catch (err) {
    logger.warn({ err }, "token-metadata: DexScreener fetch error");
  }
  return result;
}

async function refreshHelius(db: AppDatabase, helius: HeliusClient, mint: string): Promise<void> {
  const asset = (await helius.getAsset(mint)) as Record<string, unknown> | null;
  if (!asset) return;

  const authorities = asset.authorities as Array<{ address?: string; scopes?: string[] }> | undefined;
  const hasMintAuthority = authorities?.some((a) => a.scopes?.includes("mint")) ?? false;
  setConfig(db, `token:${mint}:mint_authority_renounced`, hasMintAuthority ? "false" : "true");

  const createdAt = parseTimestamp(asset.created_at ?? asset.createdAt);
  if (createdAt) {
    const ageHours = Math.max(0, (unixNow() - createdAt) / 3600);
    setConfig(db, `token:${mint}:age_hours`, ageHours.toFixed(1));
  }
}

function activeTokenMints(db: AppDatabase): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT token_mint FROM (
        SELECT token_mint FROM positions WHERE status IN ('OPEN', 'PARTIAL')
        UNION
        SELECT token_mint FROM convergences WHERE first_trade_at > ?
      )`
    )
    .all(unixNow() - 24 * 60 * 60) as Array<{ token_mint: string }>;
  return rows.map((r) => r.token_mint);
}

function setConfig(db: AppDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO execution_config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, unixNow());
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e10 ? Math.floor(value / 1000) : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
