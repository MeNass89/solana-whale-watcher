import { createLruCache } from "../storage/cache.js";
import type { TokenMetadata } from "./types.js";
import type { TokenModel } from "../storage/models/tokens.js";
import { HeliusClient } from "./helius-client.js";

export class TokenResolver {
  private readonly cache = createLruCache<string, TokenMetadata>(10_000);

  constructor(
    private readonly tokens: TokenModel,
    private readonly helius = new HeliusClient()
  ) {}

  async resolve(mint: string): Promise<TokenMetadata> {
    const cached = this.cache.get(mint);
    if (cached) return cached;

    const stored = this.tokens.findByMint(mint);
    if (stored) {
      this.cache.set(mint, stored);
      return stored;
    }

    const metadata = await this.fetchMetadata(mint);
    this.tokens.upsert(metadata);
    this.cache.set(mint, metadata);
    return metadata;
  }

  private async fetchMetadata(mint: string): Promise<TokenMetadata> {
    const asset = (await this.helius.getAsset(mint)) as Record<string, unknown> | null;
    const content = asset?.content as Record<string, unknown> | undefined;
    const metadata = content?.metadata as Record<string, unknown> | undefined;
    const links = content?.links as Record<string, unknown> | undefined;
    const tokenInfo = asset?.token_info as Record<string, unknown> | undefined;

    return {
      mint,
      symbol: stringValue(tokenInfo?.symbol) ?? stringValue(metadata?.symbol) ?? "UNKNOWN",
      name: stringValue(metadata?.name),
      decimals: numberValue(tokenInfo?.decimals),
      imageUrl: stringValue(links?.image),
      isVerified: Boolean(tokenInfo?.symbol),
      createdAt: timestampValue(asset?.created_at ?? asset?.createdAt)
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}
