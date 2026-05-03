import type { AppDatabase } from "../database.js";
import type { ITradeEvent, TradeType } from "../../blockchain/types.js";

export interface TradeRow {
  id: number;
  wallet_address: string;
  token_mint: string;
  tx_signature: string;
  amount_token: number | null;
  amount_sol: number | null;
  amount_usd: number | null;
  dex_source: string | null;
  trade_type: TradeType;
  block_time: number;
  created_at: number;
}

export class TradeModel {
  constructor(private readonly db: AppDatabase) {}

  insert(trade: ITradeEvent): TradeRow | null {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO trades
          (wallet_address, token_mint, tx_signature, amount_token, amount_sol, amount_usd, dex_source, trade_type, block_time)
         VALUES
          (@walletAddress, @tokenMint, @txSignature, @amountToken, @amountSol, @amountUsd, @dexSource, @tradeType, @blockTime)`
      )
      .run({
        walletAddress: trade.walletAddress,
        tokenMint: trade.tokenMint,
        txSignature: trade.txSignature,
        amountToken: trade.amountToken ?? null,
        amountSol: trade.amountSol ?? null,
        amountUsd: trade.amountUsd ?? null,
        dexSource: trade.dexSource ?? null,
        tradeType: trade.tradeType,
        blockTime: trade.blockTime
      });

    if (result.changes === 0) return null;
    return this.findById(Number(result.lastInsertRowid));
  }

  findById(id: number): TradeRow | null {
    return (this.db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as TradeRow | undefined) ?? null;
  }

  findByTokenInWindow(tokenMint: string, sinceBlockTime: number, tradeType: TradeType): TradeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM trades
         WHERE token_mint = ? AND block_time >= ? AND trade_type = ?
         ORDER BY block_time ASC`
      )
      .all(tokenMint, sinceBlockTime, tradeType) as TradeRow[];
  }

  findByWalletToken(walletAddress: string, tokenMint: string, tradeType?: TradeType): TradeRow[] {
    if (tradeType) {
      return this.db
        .prepare(
          `SELECT * FROM trades
           WHERE wallet_address = ? AND token_mint = ? AND trade_type = ?
           ORDER BY block_time ASC`
        )
        .all(walletAddress, tokenMint, tradeType) as TradeRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM trades
         WHERE wallet_address = ? AND token_mint = ?
         ORDER BY block_time ASC`
      )
      .all(walletAddress, tokenMint) as TradeRow[];
  }

  findByWalletSince(walletAddress: string, sinceBlockTime: number): TradeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM trades
         WHERE wallet_address = ? AND block_time >= ?
         ORDER BY block_time ASC`
      )
      .all(walletAddress, sinceBlockTime) as TradeRow[];
  }

  recent(limit = 100): TradeRow[] {
    return this.db.prepare("SELECT * FROM trades ORDER BY block_time DESC LIMIT ?").all(limit) as TradeRow[];
  }
}
