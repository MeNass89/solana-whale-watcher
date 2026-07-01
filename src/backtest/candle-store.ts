import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export type Timeframe = "minute" | "hour" | "day";

export interface Candle {
  token_mint: string;
  pool_address: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeframe: Timeframe;
}

export type FetchStatus = "done" | "no_data" | "error";

export interface FetchState {
  token_mint: string;
  pool_address: string | null;
  status: FetchStatus;
  fetched_at: number;
}

/**
 * Candle storage. Lives in its own SQLite file (data/candles.sqlite) —
 * NEVER the live whale-watcher DB.
 */
export class CandleStore {
  readonly db: Database.Database;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        token_mint   TEXT NOT NULL,
        pool_address TEXT NOT NULL,
        ts           INTEGER NOT NULL,
        open         REAL NOT NULL,
        high         REAL NOT NULL,
        low          REAL NOT NULL,
        close        REAL NOT NULL,
        volume       REAL NOT NULL,
        timeframe    TEXT NOT NULL CHECK (timeframe IN ('minute','hour','day'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_candles_unique
        ON candles(token_mint, timeframe, ts);
      CREATE INDEX IF NOT EXISTS idx_candles_lookup
        ON candles(token_mint, timeframe, ts, close);
      CREATE TABLE IF NOT EXISTS fetch_state (
        token_mint   TEXT PRIMARY KEY,
        pool_address TEXT,
        status       TEXT NOT NULL CHECK (status IN ('done','no_data','error')),
        fetched_at   INTEGER NOT NULL
      );
    `);
  }

  upsertCandles(candles: Candle[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO candles (token_mint, pool_address, ts, open, high, low, close, volume, timeframe)
      VALUES (@token_mint, @pool_address, @ts, @open, @high, @low, @close, @volume, @timeframe)
      ON CONFLICT(token_mint, timeframe, ts) DO UPDATE SET
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume, pool_address = excluded.pool_address
    `);
    const insertAll = this.db.transaction((rows: Candle[]) => {
      for (const row of rows) stmt.run(row);
    });
    insertAll(candles);
    return candles.length;
  }

  setFetchState(tokenMint: string, poolAddress: string | null, status: FetchStatus): void {
    this.db
      .prepare(
        `INSERT INTO fetch_state (token_mint, pool_address, status, fetched_at)
         VALUES (?, ?, ?, unixepoch())
         ON CONFLICT(token_mint) DO UPDATE SET
           pool_address = excluded.pool_address, status = excluded.status, fetched_at = excluded.fetched_at`
      )
      .run(tokenMint, poolAddress, status);
  }

  getFetchState(tokenMint: string): FetchState | undefined {
    return this.db.prepare(`SELECT * FROM fetch_state WHERE token_mint = ?`).get(tokenMint) as
      | FetchState
      | undefined;
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM fetch_state GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  hasCandles(tokenMint: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM candles WHERE token_mint = ? LIMIT 1`).get(tokenMint) !==
      undefined
    );
  }

  /**
   * Close of the candle whose ts is nearest to `targetTs`, within
   * ±`toleranceSeconds`. Candle ts is the bucket OPEN time; using the close of
   * the nearest bucket is the documented approximation.
   */
  closestClose(
    tokenMint: string,
    timeframe: Timeframe,
    targetTs: number,
    toleranceSeconds: number
  ): { ts: number; close: number } | undefined {
    return this.db
      .prepare(
        `SELECT ts, close FROM candles
         WHERE token_mint = ? AND timeframe = ? AND ts BETWEEN ? AND ?
         ORDER BY ABS(ts - ?) ASC LIMIT 1`
      )
      .get(tokenMint, timeframe, targetTs - toleranceSeconds, targetTs + toleranceSeconds, targetTs) as
      | { ts: number; close: number }
      | undefined;
  }

  /**
   * Nearest candle at-or-before targetTs within tolerance — used for entry
   * pricing so we never price an entry off a future candle.
   */
  closeAtOrBefore(
    tokenMint: string,
    timeframe: Timeframe,
    targetTs: number,
    toleranceSeconds: number
  ): { ts: number; close: number; volume: number } | undefined {
    return this.db
      .prepare(
        `SELECT ts, close, volume FROM candles
         WHERE token_mint = ? AND timeframe = ? AND ts <= ? AND ts >= ?
         ORDER BY ts DESC LIMIT 1`
      )
      .get(tokenMint, timeframe, targetTs, targetTs - toleranceSeconds) as
      | { ts: number; close: number; volume: number }
      | undefined;
  }

  candlesBetween(tokenMint: string, timeframe: Timeframe, fromTs: number, toTs: number): Candle[] {
    return this.db
      .prepare(
        `SELECT * FROM candles
         WHERE token_mint = ? AND timeframe = ? AND ts >= ? AND ts <= ?
         ORDER BY ts ASC`
      )
      .all(tokenMint, timeframe, fromTs, toTs) as Candle[];
  }

  lastCandleTs(tokenMint: string): number | undefined {
    const row = this.db
      .prepare(`SELECT MAX(ts) AS ts FROM candles WHERE token_mint = ?`)
      .get(tokenMint) as { ts: number | null };
    return row.ts ?? undefined;
  }

  close(): void {
    this.db.close();
  }
}

export const DEFAULT_CANDLE_DB = "data/candles.sqlite";
