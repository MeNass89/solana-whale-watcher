import { logger } from "../utils/logger.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";

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
  async getTokenPairs(mint: string): Promise<DexPair[]> {
    try {
      const response = await fetch(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`);
      if (!response.ok) return [];
      const data = (await response.json()) as any[];
      if (!Array.isArray(data)) return [];
      return data.map((pair) => ({
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
    } catch (error) {
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "dexscreener: getTokenPairs failed");
      return [];
    }
  }

  async getBestPair(mint: string): Promise<DexPair | null> {
    const pairs = await this.getTokenPairs(mint);
    if (pairs.length === 0) return null;
    return pairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
  }
}

export const dexScreenerClient = new DexScreenerClient();
