import type { AppDatabase } from "../database.js";
import type { AlertTier } from "../../blockchain/types.js";
import type { TradeRow } from "./trades.js";
import { unixNow } from "../../utils/helpers.js";

export interface ConvergenceRow {
  id: number;
  token_mint: string;
  token_symbol: string | null;
  score: number;
  tier: AlertTier;
  wallet_count: number;
  total_usd: number | null;
  first_trade_at: number;
  last_trade_at: number;
  window_minutes: number | null;
  alerted_at: number | null;
  price_at_detection: number | null;
  price_1h: number | null;
  price_24h: number | null;
  price_7d: number | null;
  outcome: string | null;
  created_at: number;
}

export class ConvergenceModel {
  constructor(private readonly db: AppDatabase) {}

  create(input: {
    tokenMint: string;
    tokenSymbol?: string;
    score: number;
    tier: AlertTier;
    walletCount: number;
    totalUsd?: number;
    firstTradeAt: number;
    lastTradeAt: number;
    windowMinutes: number;
    trades: TradeRow[];
  }): ConvergenceRow {
    const result = this.db
      .prepare(
        `INSERT INTO convergences
          (token_mint, token_symbol, score, tier, wallet_count, total_usd, first_trade_at, last_trade_at, window_minutes, outcome)
         VALUES
          (@tokenMint, @tokenSymbol, @score, @tier, @walletCount, @totalUsd, @firstTradeAt, @lastTradeAt, @windowMinutes, 'PENDING')`
      )
      .run({
        tokenMint: input.tokenMint,
        tokenSymbol: input.tokenSymbol ?? null,
        score: input.score,
        tier: input.tier,
        walletCount: input.walletCount,
        totalUsd: input.totalUsd ?? null,
        firstTradeAt: input.firstTradeAt,
        lastTradeAt: input.lastTradeAt,
        windowMinutes: input.windowMinutes
      });

    const id = Number(result.lastInsertRowid);
    const insertLink = this.db.prepare(
      "INSERT OR IGNORE INTO convergence_trades (convergence_id, trade_id) VALUES (?, ?)"
    );
    for (const trade of input.trades) insertLink.run(id, trade.id);
    return this.findById(id)!;
  }

  markAlerted(id: number): void {
    this.db.prepare("UPDATE convergences SET alerted_at = ? WHERE id = ?").run(unixNow(), id);
  }

  wasRecentlyAlerted(tokenMint: string, tier: AlertTier, minutes: number): boolean {
    const since = unixNow() - minutes * 60;
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM convergences WHERE token_mint = ? AND tier = ? AND alerted_at IS NOT NULL AND alerted_at >= ? LIMIT 1")
        .get(tokenMint, tier, since)
    );
  }

  findById(id: number): ConvergenceRow | null {
    return (this.db.prepare("SELECT * FROM convergences WHERE id = ?").get(id) as ConvergenceRow | undefined) ?? null;
  }

  list(limit = 100): ConvergenceRow[] {
    return this.db.prepare("SELECT * FROM convergences ORDER BY created_at DESC LIMIT ?").all(limit) as ConvergenceRow[];
  }

  tradesForConvergence(id: number): TradeRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM trades t
         JOIN convergence_trades ct ON ct.trade_id = t.id
         WHERE ct.convergence_id = ?
         ORDER BY t.block_time ASC`
      )
      .all(id) as TradeRow[];
  }

  markOutcome(id: number, outcome: string): void {
    this.db.prepare("UPDATE convergences SET outcome = ? WHERE id = ?").run(outcome, id);
  }

  incrementExecutionAttempts(id: number): number {
    const key = `convergence:${id}:execution_attempts`;
    const row = this.db.prepare("SELECT value FROM execution_config WHERE key = ?").get(key) as { value: string } | undefined;
    const next = Number(row?.value ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO execution_config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, String(next), unixNow());
    return next;
  }

  pendingExecutionRetries(olderThanSeconds: number, maxAttempts: number): ConvergenceRow[] {
    const cutoff = unixNow() - olderThanSeconds;
    return this.db
      .prepare(
        `SELECT c.*
         FROM convergences c
         LEFT JOIN execution_config ec ON ec.key = 'convergence:' || c.id || ':execution_attempts'
         WHERE c.outcome = 'PENDING'
           AND c.tier != 'WATCH'
           AND c.created_at <= ?
           AND CAST(COALESCE(ec.value, '0') AS INTEGER) < ?
           AND NOT EXISTS (
             SELECT 1 FROM executions e
             WHERE e.convergence_id = c.id AND e.status = 'FILLED'
           )
         ORDER BY c.created_at ASC`
      )
      .all(cutoff, maxAttempts) as ConvergenceRow[];
  }
}
