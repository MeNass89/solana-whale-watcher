import type { AppDatabase } from "../database.js";
import type { TokenMetadata } from "../../blockchain/types.js";
import { unixNow } from "../../utils/helpers.js";

export class TokenModel {
  constructor(private readonly db: AppDatabase) {}

  findByMint(mint: string): TokenMetadata | null {
    const row = this.db.prepare("SELECT * FROM tokens WHERE mint = ?").get(mint) as
      | {
          mint: string;
          symbol: string | null;
          name: string | null;
          decimals: number | null;
          image_url: string | null;
          liquidity_usd: number | null;
          is_verified: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      mint: row.mint,
      symbol: row.symbol ?? undefined,
      name: row.name ?? undefined,
      decimals: row.decimals ?? undefined,
      imageUrl: row.image_url ?? undefined,
      liquidityUsd: row.liquidity_usd ?? undefined,
      isVerified: row.is_verified === 1,
      updatedAt: row.updated_at
    };
  }

  upsert(token: TokenMetadata): void {
    this.db
      .prepare(
        `INSERT INTO tokens (mint, symbol, name, decimals, image_url, liquidity_usd, is_verified, updated_at)
         VALUES (@mint, @symbol, @name, @decimals, @imageUrl, @liquidityUsd, @isVerified, @updatedAt)
         ON CONFLICT(mint) DO UPDATE SET
           symbol = excluded.symbol,
           name = excluded.name,
           decimals = excluded.decimals,
           image_url = excluded.image_url,
           liquidity_usd = excluded.liquidity_usd,
           is_verified = excluded.is_verified,
           updated_at = excluded.updated_at`
      )
      .run({
        mint: token.mint,
        symbol: token.symbol ?? null,
        name: token.name ?? null,
        decimals: token.decimals ?? null,
        imageUrl: token.imageUrl ?? null,
        liquidityUsd: token.liquidityUsd ?? null,
        isVerified: token.isVerified ? 1 : 0,
        updatedAt: token.updatedAt ?? unixNow()
      });
  }

  isBlacklisted(mint: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM token_blacklist WHERE mint = ?").get(mint));
  }
}
