import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
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

export class HeliusRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "HeliusRequestError";
  }
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
        webhookType: "enhanced",
        // Helius echoes this as the Authorization header on every delivery;
        // without it our HMAC middleware 401s every webhook and the pipeline
        // silently starves.
        authHeader: config.helius.webhookSecret
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
        webhookType: "enhanced",
        // Keep the auth header on updates too — a PUT without it strips the
        // header from the registration and re-starves the pipeline.
        authHeader: config.helius.webhookSecret
      })
    });
  }

  async getWebhook(webhookId: string): Promise<{ webhookID: string; webhookURL: string; accountAddresses: string[]; webhookType: string } | null> {
    if (!this.apiKey || !webhookId) return null;
    try {
      return await this.request<{ webhookID: string; webhookURL: string; accountAddresses: string[]; webhookType: string }>(`/v0/webhooks/${webhookId}`, { method: "GET" });
    } catch (error) {
      const status = error instanceof HeliusRequestError ? error.status : undefined;
      if (status === 404) return null;
      throw error;
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
      if (!response.ok) {
        // Rate-limit, auth, and server errors should surface to callers so the
        // scorer can log/retry; treating 401/403 as pagination end truncates
        // recent activity when the key expires or is unauthorized.
        if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
          throw new HeliusRequestError(
            response.status,
            `Helius getWalletTransactions failed (${response.status})`,
            parseRetryAfter(response.headers.get("retry-after"))
          );
        }
        if (response.status === 404) {
          logger.warn({ address, status: response.status, beforeSignature }, "getWalletTransactions: wallet not found, stopping pagination");
          break;
        }
        throw new HeliusRequestError(
          response.status,
          `Helius getWalletTransactions failed (${response.status})`,
          parseRetryAfter(response.headers.get("retry-after"))
        );
      }
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
    if (!response.ok) {
      if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
        throw new HeliusRequestError(response.status, `Helius DAS getAsset failed (${response.status})`, parseRetryAfter(response.headers.get("retry-after")));
      }
      throw new Error(`Helius DAS getAsset failed: ${response.status}`);
    }
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
      throw new HeliusRequestError(
        response.status,
        `Helius request failed (${response.status}): ${body}`,
        parseRetryAfter(response.headers.get("retry-after"))
      );
    }
    return (await response.json()) as T;
  }

  private assertReady(webhookUrl: string): void {
    if (!this.apiKey) throw new Error("HELIUS_API_KEY is required");
    if (!webhookUrl) throw new Error("PUBLIC_WEBHOOK_URL is required");
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}
