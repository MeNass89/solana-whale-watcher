import { config } from "../config/index.js";
import type { IChainMonitor } from "./types.js";

const HELIUS_BASE_URL = "https://api.helius.xyz";
const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com";

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
  tokenStandard?: string;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

export interface HeliusTransaction {
  signature: string;
  type: string;
  timestamp: number;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
  description?: string;
  source?: string;
  fee?: number;
}

export class HeliusClient implements IChainMonitor {
  constructor(private readonly apiKey = config.helius.apiKey) {}

  async registerWebhook(addresses: string[], webhookUrl: string): Promise<string> {
    this.assertReady(webhookUrl);

    const response = await this.request<{ webhookID?: string; id?: string }>("/v0/webhooks", {
      method: "POST",
      body: JSON.stringify({
        webhookURL: webhookUrl,
        transactionTypes: ["SWAP"],
        accountAddresses: addresses,
        webhookType: "enhanced"
      })
    });

    const id = response.webhookID ?? response.id;
    if (!id) throw new Error("Helius did not return a webhook id");
    return id;
  }

  async updateWebhook(webhookId: string, addresses: string[], webhookUrl: string): Promise<void> {
    this.assertReady(webhookUrl);
    if (!webhookId) throw new Error("HELIUS_WEBHOOK_ID is required to update a webhook");

    await this.request(`/v0/webhooks/${webhookId}`, {
      method: "PUT",
      body: JSON.stringify({
        webhookURL: webhookUrl,
        transactionTypes: ["SWAP"],
        accountAddresses: addresses,
        webhookType: "enhanced"
      })
    });
  }

  async getWebhook(webhookId: string): Promise<{ webhookID: string; webhookURL: string; accountAddresses: string[]; webhookType: string } | null> {
    if (!this.apiKey || !webhookId) return null;
    try {
      return await this.request<{ webhookID: string; webhookURL: string; accountAddresses: string[]; webhookType: string }>(`/v0/webhooks/${webhookId}`, { method: "GET" });
    } catch {
      return null;
    }
  }

  async getWalletTransactions(address: string, limit = 100): Promise<HeliusTransaction[]> {
    if (!this.apiKey) return [];
    const results: HeliusTransaction[] = [];
    let beforeSignature: string | undefined;

    while (results.length < limit) {
      const batchSize = Math.min(100, limit - results.length);
      let url = `${HELIUS_BASE_URL}/v0/addresses/${address}/transactions?api-key=${this.apiKey}&limit=${batchSize}`;
      if (beforeSignature) url += `&before=${beforeSignature}`;

      const response = await fetch(url);
      if (!response.ok) break;
      const batch = (await response.json()) as HeliusTransaction[];
      if (batch.length === 0) break;

      results.push(...batch);
      beforeSignature = batch[batch.length - 1].signature;
      if (batch.length < batchSize) break;
    }

    return results;
  }

  async getAsset(mint: string): Promise<unknown> {
    if (!this.apiKey) return null;
    const response = await fetch(`${HELIUS_RPC_URL}/?api-key=${this.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "solana-whale-watcher",
        method: "getAsset",
        params: { id: mint }
      })
    });
    if (!response.ok) throw new Error(`Helius DAS getAsset failed: ${response.status}`);
    const result = (await response.json()) as { result?: unknown; error?: unknown };
    if (result.error) throw new Error(`Helius DAS getAsset error: ${JSON.stringify(result.error)}`);
    return result.result ?? null;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    if (!this.apiKey) throw new Error("HELIUS_API_KEY is required");
    const response = await fetch(`${HELIUS_BASE_URL}${path}?api-key=${this.apiKey}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Helius request failed (${response.status}): ${body}`);
    }
    return (await response.json()) as T;
  }

  private assertReady(webhookUrl: string): void {
    if (!this.apiKey) throw new Error("HELIUS_API_KEY is required");
    if (!webhookUrl) throw new Error("PUBLIC_WEBHOOK_URL is required");
  }
}
