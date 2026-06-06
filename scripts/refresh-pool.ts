import { PublicKey } from "@solana/web3.js";
import { openDatabase } from "../src/storage/database.js";
import { WalletModel } from "../src/storage/models/wallets.js";
import { WalletMonitor } from "../src/blockchain/wallet-monitor.js";
import { HeliusRequestError } from "../src/blockchain/helius-client.js";
import { logger } from "../src/utils/logger.js";

const API_KEY = process.env.SOLANATRACKER_API_KEY;
if (!API_KEY) {
  throw new Error("SOLANATRACKER_API_KEY missing from environment");
}

const POOL_SIZE = 50;
const TRENDING_TOKEN_COUNT = 10;
const TRADERS_PER_TOKEN = 20;
const THROTTLE_MS = 1200;

const NOISE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
]);

type Wallet = {
  wallet: string;
  summary: {
    realized: number;
    totalWins: number;
    totalLosses: number;
    winPercentage: number;
    averageBuyAmount: number;
  };
};

type TrendingToken = { mint?: string; address?: string; token?: { mint?: string } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function st<T>(path: string, attempt = 1): Promise<T> {
  const res = await fetch(`https://data.solanatracker.io${path}`, {
    headers: { "x-api-key": API_KEY! }
  });
  if (res.status === 429 && attempt <= 3) {
    const backoff = 2000 * attempt;
    logger.warn({ path, attempt, backoff }, "refresh-pool: 429, backing off");
    await sleep(backoff);
    return st<T>(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`Solana Tracker ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function fetchGlobalTopTraders(): Promise<Wallet[]> {
  const body = await st<{ wallets: Wallet[] }>("/top-traders/all");
  return body.wallets ?? [];
}

async function fetchTrendingTokens(): Promise<string[]> {
  const body = await st<TrendingToken[] | { tokens?: TrendingToken[] }>("/tokens/trending/24h");
  const list = Array.isArray(body) ? body : body.tokens ?? [];
  const mints: string[] = [];
  for (const t of list) {
    const mint = t.mint ?? t.address ?? t.token?.mint;
    if (mint && !NOISE_MINTS.has(mint)) mints.push(mint);
    if (mints.length >= TRENDING_TOKEN_COUNT) break;
  }
  return mints;
}

async function fetchTopTradersForToken(mint: string): Promise<Wallet[]> {
  try {
    const body = await st<Wallet[] | { wallets?: Wallet[]; traders?: Wallet[] }>(`/top-traders/${mint}`);
    const list = Array.isArray(body) ? body : body.wallets ?? body.traders ?? [];
    return list.slice(0, TRADERS_PER_TOKEN);
  } catch (err) {
    logger.warn({ mint, err: err instanceof Error ? err.message : String(err) }, "refresh-pool: per-token fetch failed");
    return [];
  }
}

function isValidAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  logger.info("refresh-pool: fetching global top traders");
  const global = await fetchGlobalTopTraders();
  logger.info({ count: global.length }, "refresh-pool: global fetched");
  await sleep(THROTTLE_MS);

  logger.info("refresh-pool: fetching trending tokens");
  const trendingMints = await fetchTrendingTokens();
  logger.info({ count: trendingMints.length, mints: trendingMints }, "refresh-pool: trending tokens");
  await sleep(THROTTLE_MS);

  const perToken: Wallet[][] = [];
  for (const mint of trendingMints) {
    const traders = await fetchTopTradersForToken(mint);
    perToken.push(traders);
    logger.info({ mint, traders: traders.length }, "refresh-pool: per-token fetched");
    await sleep(THROTTLE_MS);
  }

  const byAddress = new Map<string, Wallet>();
  const ingest = (w: Wallet) => {
    if (!w?.wallet || !isValidAddress(w.wallet)) return;
    const prev = byAddress.get(w.wallet);
    if (!prev || (w.summary?.realized ?? 0) > (prev.summary?.realized ?? 0)) {
      byAddress.set(w.wallet, w);
    }
  };
  for (const w of global) ingest(w);
  for (const list of perToken) for (const w of list) ingest(w);

  const ranked = [...byAddress.values()].sort(
    (a, b) => (b.summary?.realized ?? 0) - (a.summary?.realized ?? 0)
  );
  const pool = ranked.slice(0, POOL_SIZE);

  logger.info(
    { unique: byAddress.size, kept: pool.length, global: global.length, perTokenTotal: perToken.flat().length },
    "refresh-pool: pool composed"
  );

  if (pool.length === 0) {
    logger.error("refresh-pool: aggregated zero wallets — aborting");
    process.exit(1);
  }

  const db = openDatabase();
  const wallets = new WalletModel(db);

  const txn = db.transaction(() => {
    db.prepare("UPDATE wallets SET active = 0").run();
    for (const w of pool) {
      wallets.upsert({
        address: w.wallet,
        label: `realized=$${Math.round(w.summary?.realized ?? 0)} win=${(w.summary?.winPercentage ?? 0).toFixed(1)}%`,
        source: "discovered",
        state: "ACTIVE",
        active: true
      });
    }
  });
  txn();

  const activeCount = wallets.countActive();
  logger.info({ activeCount }, "refresh-pool: database updated");

  const monitor = new WalletMonitor(wallets);
  await syncWebhookWithRetry(monitor);
}

async function syncWebhookWithRetry(monitor: WalletMonitor): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await monitor.syncWebhook();
      logger.info({ attempt }, "refresh-pool: Helius webhook synced");
      return;
    } catch (err) {
      const isHelius = err instanceof HeliusRequestError;
      const status = isHelius ? err.status : undefined;
      const retryable = !isHelius || status === 429 || status === 408 || (typeof status === "number" && status >= 500);
      if (!retryable || attempt === maxAttempts) {
        logger.error(
          { err, attempt, status },
          "refresh-pool: CRITICAL DESYNC — DB pool updated but Helius webhook NOT synced. Webhook is monitoring a stale wallet set. Next scheduled refresh will retry."
        );
        throw err;
      }
      const retryAfterSec = isHelius && typeof err.retryAfterSeconds === "number" ? err.retryAfterSeconds : null;
      const backoffMs = retryAfterSec ? retryAfterSec * 1000 : Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      logger.warn(
        { attempt, status, retryAfterSec, backoffMs },
        "refresh-pool: Helius webhook sync failed, backing off"
      );
      await sleep(backoffMs);
    }
  }
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "refresh-pool: failed");
  process.exit(1);
});
