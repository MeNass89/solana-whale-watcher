import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const BIRDEYE_BASE = "https://public-api.birdeye.so";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const BIRDEYE_RATE_LIMIT_DELAY_MS = 1000;
const BIRDEYE_FETCH_TIMEOUT_MS = 10_000;

export class BirdEyeRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super(`BirdEye rate limited (retry-after=${retryAfterSeconds ?? "unknown"})`);
    this.name = "BirdEyeRateLimitError";
  }
}

export class BirdEyeUnavailableError extends Error {
  constructor(public readonly status: number | null, public readonly cause: unknown) {
    super(`BirdEye unavailable${status != null ? ` (${status})` : ""}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "BirdEyeUnavailableError";
  }
}

export interface HistoricalPrice {
  unixTime: number;
  value: number;
}

export interface TokenOverview {
  mint: string;
  symbol: string | null;
  name: string | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
  mc: number | null;
  v24hUsd: number | null;
  holder: number | null;
  createdAt: number | null;
}

export interface WalletPnl {
  totalPnl: number;
  totalPnlPercent: number;
  totalBuyAmount: number;
  totalSellAmount: number;
}

export class BirdEyeClient {
  constructor(private readonly apiKey = config.birdeye.apiKey) {}

  async getHistoricalPrices(
    mint: string,
    fromUnix: number,
    toUnix: number,
    type: "1m" | "5m" | "15m" | "1H" | "4H" | "1D" = "5m"
  ): Promise<HistoricalPrice[]> {
    if (!this.apiKey) throw new Error("BirdEye API key is required for historical prices");

    const intervalSecByType = {
      "1m": 60,
      "5m": 300,
      "15m": 900,
      "1H": 3600,
      "4H": 14400,
      "1D": 86400
    } satisfies Record<typeof type, number>;
    const intervalSec = intervalSecByType[type];
    const maxCandlesPerCall = 1000;
    const maxSpanSec = intervalSec * maxCandlesPerCall;
    const itemsByUnixTime = new Map<number, HistoricalPrice>();

    // BirdEye caps history_price responses at 1,000 candles, so wider ranges
    // are sliced into sequential windows and deduplicated by candle timestamp.
    for (let cursor = fromUnix; cursor <= toUnix; cursor += maxSpanSec + 1) {
      const chunkTo = Math.min(toUnix, cursor + maxSpanSec);
      const params = new URLSearchParams({
        address: mint,
        address_type: "token",
        type,
        time_from: String(cursor),
        time_to: String(chunkTo)
      });
      const data = await this.request(`/defi/history_price?${params.toString()}`);
      const items = Array.isArray(data?.items) ? data.items : [];
      for (const item of items) {
        if (Number.isFinite(item?.unixTime) && Number.isFinite(item?.value)) {
          itemsByUnixTime.set(item.unixTime, { unixTime: item.unixTime, value: item.value });
        }
      }
      if (chunkTo < toUnix) await sleep(BIRDEYE_RATE_LIMIT_DELAY_MS);
    }

    return [...itemsByUnixTime.values()].sort((a, b) => a.unixTime - b.unixTime);
  }

  async getSolUsdAt(unixTime: number): Promise<number | null> {
    if (!this.apiKey) return null;
    try {
      const params = new URLSearchParams({
        address: SOL_MINT,
        unixtime: String(unixTime)
      });
      const data = await this.request(`/defi/historical_price_unix?${params.toString()}`);
      return Number.isFinite(data?.value) ? data.value : null;
    } catch (error) {
      // Surface provider failures so callers can back off instead of treating
      // them as a no-data response.
      if (error instanceof BirdEyeRateLimitError || error instanceof BirdEyeUnavailableError) throw error;
      logger.warn({ unixTime, err: error instanceof Error ? error : new Error(String(error)) }, "birdeye: getSolUsdAt failed");
      return null;
    }
  }

  async getTokenOverview(mint: string): Promise<TokenOverview | null> {
    if (!this.apiKey) return null;
    try {
      const data = await this.request(`/defi/token_overview?address=${mint}`);
      if (!data) return null;
      return {
        mint,
        symbol: data.symbol ?? null,
        name: data.name ?? null,
        liquidityUsd: data.liquidity ?? null,
        priceUsd: data.price ?? null,
        mc: data.mc ?? null,
        v24hUsd: data.v24hUSD ?? null,
        holder: data.holder ?? null,
        createdAt: data.createdAt ? Math.floor(data.createdAt / 1000) : null
      };
    } catch (error) {
      if (error instanceof BirdEyeRateLimitError || error instanceof BirdEyeUnavailableError) throw error;
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "birdeye: getTokenOverview failed");
      return null;
    }
  }

  async getWalletPnl(walletAddress: string): Promise<WalletPnl | null> {
    if (!this.apiKey) return null;
    try {
      const data = await this.request(`/v1/wallet/token_performance?wallet=${walletAddress}`);
      if (!data?.items?.length) return null;
      let totalPnl = 0;
      let totalBuy = 0;
      let totalSell = 0;
      for (const item of data.items) {
        totalPnl += item.realizedProfit ?? 0;
        totalBuy += item.totalBuyAmount ?? 0;
        totalSell += item.totalSellAmount ?? 0;
      }
      return {
        totalPnl,
        totalPnlPercent: totalBuy > 0 ? (totalPnl / totalBuy) * 100 : 0,
        totalBuyAmount: totalBuy,
        totalSellAmount: totalSell
      };
    } catch (error) {
      if (error instanceof BirdEyeRateLimitError || error instanceof BirdEyeUnavailableError) throw error;
      logger.warn(
        { walletAddress: walletAddress.substring(0, 12), err: error instanceof Error ? error : new Error(String(error)) },
        "birdeye: getWalletPnl failed"
      );
      return null;
    }
  }

  private async request(path: string): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${BIRDEYE_BASE}${path}`, {
        // Hung connections used to block the scoring/risk path indefinitely.
        signal: AbortSignal.timeout(BIRDEYE_FETCH_TIMEOUT_MS),
        headers: {
          "x-chain": "solana",
          "X-API-KEY": this.apiKey
        }
      });
    } catch (error) {
      throw new BirdEyeUnavailableError(null, error);
    }
    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const retryAfter = header && Number.isFinite(Number(header)) ? Number(header) : null;
      throw new BirdEyeRateLimitError(retryAfter);
    }
    if (response.status === 401 || response.status === 403 || response.status >= 500) {
      throw new BirdEyeUnavailableError(response.status, new Error(await response.text()));
    }
    if (!response.ok) {
      throw new BirdEyeUnavailableError(response.status, new Error(await response.text()));
    }
    let json: { success: boolean; data?: any };
    try {
      json = (await response.json()) as { success: boolean; data?: any };
    } catch (error) {
      throw new BirdEyeUnavailableError(response.status, error);
    }
    if (!json.success) {
      throw new BirdEyeUnavailableError(response.status, new Error("BirdEye request unsuccessful"));
    }
    return json.data ?? null;
  }
}

export const birdEyeClient = new BirdEyeClient();
