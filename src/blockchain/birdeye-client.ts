import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const BIRDEYE_BASE = "https://public-api.birdeye.so";

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
      const invested = totalBuy > 0 ? totalBuy : 1;
      return {
        totalPnl,
        totalPnlPercent: (totalPnl / invested) * 100,
        totalBuyAmount: totalBuy,
        totalSellAmount: totalSell
      };
    } catch (error) {
      logger.warn(
        { walletAddress: walletAddress.substring(0, 12), err: error instanceof Error ? error : new Error(String(error)) },
        "birdeye: getWalletPnl failed"
      );
      return null;
    }
  }

  private async request(path: string): Promise<any> {
    const response = await fetch(`${BIRDEYE_BASE}${path}`, {
      headers: {
        "x-chain": "solana",
        "X-API-KEY": this.apiKey
      }
    });
    if (!response.ok) throw new Error(`BirdEye ${response.status}: ${await response.text()}`);
    const json = (await response.json()) as { success: boolean; data?: any };
    if (!json.success) throw new Error("BirdEye request unsuccessful");
    return json.data ?? null;
  }
}

export const birdEyeClient = new BirdEyeClient();
