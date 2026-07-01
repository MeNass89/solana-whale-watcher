import { PublicKey } from "@solana/web3.js";
import type { AppDatabase } from "../storage/database.js";
import { logger } from "../utils/logger.js";
import { getRpcRouter } from "./rpc-router.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const KNOWN_DECIMALS = new Map<string, number>([
  [SOL_MINT, 9],
  [USDC_MINT, 6],
  [USDT_MINT, 6]
]);

export class UnknownTokenDecimalsError extends Error {
  constructor(public readonly mint: string) {
    super(`token decimals unknown for mint ${mint}: DB row missing and on-chain fetch failed`);
    this.name = "UnknownTokenDecimalsError";
  }
}

type OnChainFetcher = (mint: string) => Promise<number | null>;

async function fetchDecimalsOnChain(mint: string): Promise<number | null> {
  const mintKey = new PublicKey(mint);
  const account = await getRpcRouter().call("getAccountInfo", (c) => c.getAccountInfo(mintKey));
  const decimals = account?.data[44];
  return decimals === undefined ? null : decimals;
}

/**
 * The single source of truth for token decimals. Every entry/exit amount
 * conversion must resolve through here — one token scaled three different
 * ways (6 in one file, 9 in another) fabricates -99.9% "losses" out of pure
 * unit mismatch. Resolution order: known stables/SOL -> in-memory cache ->
 * DB token row -> on-chain mint account. If all fail, the operation FAILS
 * loudly; a silent default is never returned.
 */
export class TokenDecimalsResolver {
  private db: AppDatabase | null = null;
  private fetchOnChain: OnChainFetcher = fetchDecimalsOnChain;
  private cache = new Map<string, number>();

  configure(input: { db: AppDatabase; fetchOnChain?: OnChainFetcher }): void {
    this.db = input.db;
    this.fetchOnChain = input.fetchOnChain ?? fetchDecimalsOnChain;
    this.cache.clear();
  }

  async resolve(mint: string): Promise<number> {
    const known = KNOWN_DECIMALS.get(mint);
    if (known !== undefined) return known;

    const cached = this.cache.get(mint);
    if (cached !== undefined) return cached;

    const stored = this.storedDecimals(mint);
    if (stored !== null) {
      this.cache.set(mint, stored);
      return stored;
    }

    let fetched: number | null = null;
    try {
      fetched = await this.fetchOnChain(mint);
    } catch (error) {
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "token-decimals: on-chain fetch failed");
    }
    if (fetched === null || !Number.isInteger(fetched) || fetched < 0 || fetched > 18) {
      logger.error({ mint, fetched }, "token-decimals: unresolvable — refusing to default (would corrupt amount scaling)");
      throw new UnknownTokenDecimalsError(mint);
    }

    this.persist(mint, fetched);
    this.cache.set(mint, fetched);
    return fetched;
  }

  private storedDecimals(mint: string): number | null {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT decimals FROM tokens WHERE mint = ?").get(mint) as
      | { decimals: number | null }
      | undefined;
    const decimals = row?.decimals ?? null;
    return decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : null;
  }

  private persist(mint: string, decimals: number): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO tokens (mint, decimals) VALUES (?, ?)
         ON CONFLICT(mint) DO UPDATE SET decimals = excluded.decimals`
      )
      .run(mint, decimals);
  }
}

export const tokenDecimalsResolver = new TokenDecimalsResolver();
