/**
 * Minimal GeckoTerminal public-API client (no key required).
 * Rate limit is ~30 req/min → we throttle to one request every 2.1s and back
 * off exponentially on 429/5xx.
 */
import type { Timeframe } from "./candle-store.js";

const BASE = "https://api.geckoterminal.com/api/v2";
const THROTTLE_MS = 2100;
const MAX_RETRIES = 5;

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttledGet(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + THROTTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error;
      await sleep(5000 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`GeckoTerminal ${res.status} after ${attempt + 1} tries: ${url}`);
      await sleep(5000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`GeckoTerminal ${res.status}: ${url}`);
    return res.json();
  }
}

export interface PoolInfo {
  address: string;
  reserveUsd: number;
}

/** Top pool for a token, by USD reserve. Returns undefined if no pool. */
export async function fetchTopPool(mint: string): Promise<PoolInfo | undefined> {
  const json = (await throttledGet(`${BASE}/networks/solana/tokens/${mint}/pools?page=1`)) as {
    data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string } }>;
  } | null;
  if (!json?.data?.length) return undefined;
  let best: PoolInfo | undefined;
  for (const pool of json.data) {
    const address = pool.attributes?.address;
    if (!address) continue;
    const reserveUsd = Number(pool.attributes?.reserve_in_usd ?? 0);
    if (!best || reserveUsd > best.reserveUsd) best = { address, reserveUsd };
  }
  return best;
}

export interface OhlcvBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * OHLCV for a pool. `tokenMint` is passed as the `token` query param so the
 * price series is the TOKEN's USD price regardless of pool base/quote
 * orientation. Returned bars are ascending by ts. Volume is in USD.
 */
export async function fetchOhlcv(
  poolAddress: string,
  timeframe: Timeframe,
  beforeTimestamp: number,
  limit: number,
  tokenMint?: string
): Promise<OhlcvBar[]> {
  const params = new URLSearchParams({
    aggregate: "1",
    before_timestamp: String(beforeTimestamp),
    limit: String(Math.min(1000, Math.max(1, limit))),
    currency: "usd"
  });
  if (tokenMint) params.set("token", tokenMint);
  const json = (await throttledGet(
    `${BASE}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}?${params}`
  )) as { data?: { attributes?: { ohlcv_list?: number[][] } } } | null;
  const list = json?.data?.attributes?.ohlcv_list ?? [];
  return list
    .map((row) => ({ ts: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] }))
    .filter((bar) => Number.isFinite(bar.ts) && Number.isFinite(bar.close))
    .sort((a, b) => a.ts - b.ts);
}

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
