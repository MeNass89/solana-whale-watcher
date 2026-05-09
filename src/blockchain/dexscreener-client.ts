import { logger } from "../utils/logger.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const FETCH_TIMEOUT_MS = 8_000;

export class DexScreenerRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super(`DexScreener rate limited (retry-after=${retryAfterSeconds ?? "unknown"})`);
    this.name = "DexScreenerRateLimitError";
  }
}

export class DexScreenerServerError extends Error {
  constructor(public readonly status: number) {
    super(`DexScreener server error ${status}`);
    this.name = "DexScreenerServerError";
  }
}

export interface DexPair {
  pairAddress: string;
  dexId: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string };
  liquidityUsd: number | null;
  volume24h: number | null;
  priceUsd: number | null;
  pairCreatedAt: number | null;
  fdv: number | null;
}

export class DexScreenerClient {
  // Returns:
  //   - [] only when the API confirms zero pairs (200 + empty array, or 404).
  //   - throws DexScreenerRateLimitError on 429 so callers can back off.
  //   - throws DexScreenerServerError on 5xx so callers can retry transparently.
  //   - returns [] (with warn log) on network/parse errors — same as before.
  async getTokenPairs(mint: string): Promise<DexPair[]> {
    let response: Response;
    try {
      response = await fetch(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (error) {
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "dexscreener: getTokenPairs network/timeout");
      return [];
    }

    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const retryAfter = header && Number.isFinite(Number(header)) ? Number(header) : null;
      throw new DexScreenerRateLimitError(retryAfter);
    }
    if (response.status >= 500) throw new DexScreenerServerError(response.status);
    if (response.status === 404) return [];
    if (!response.ok) {
      logger.warn({ mint, status: response.status }, "dexscreener: unexpected non-OK status");
      return [];
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "dexscreener: invalid JSON");
      return [];
    }
    if (!Array.isArray(data)) return [];

    return data.map((pair: any) => ({
      pairAddress: pair.pairAddress ?? "",
      dexId: pair.dexId ?? "",
      baseToken: {
        address: pair.baseToken?.address ?? mint,
        symbol: pair.baseToken?.symbol ?? "???",
        name: pair.baseToken?.name ?? ""
      },
      quoteToken: {
        address: pair.quoteToken?.address ?? "",
        symbol: pair.quoteToken?.symbol ?? ""
      },
      liquidityUsd: pair.liquidity?.usd ?? null,
      volume24h: pair.volume?.h24 ?? null,
      priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
      pairCreatedAt: pair.pairCreatedAt ?? null,
      fdv: pair.fdv ?? null
    }));
  }

  async getBestPair(mint: string): Promise<DexPair | null> {
    const pairs = await this.getTokenPairs(mint);
    if (pairs.length === 0) return null;
    return pairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
  }
}

export const dexScreenerClient = new DexScreenerClient();
