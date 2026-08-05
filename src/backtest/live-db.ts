/**
 * Access to the LIVE whale-watcher DB. The live service is running against it,
 * so:
 *  - reads use a `readonly` connection;
 *  - the ONLY permitted writes are (a) the one-time `resolved_via` column
 *    migration and (b) the resolver's UPDATEs on `convergences`, executed in
 *    short WAL-friendly transactions (batches of 200).
 */
import Database from "better-sqlite3";

export const LIVE_DB_PATH = "data/whale-watcher.sqlite";

export interface ConvergenceRow {
  id: number;
  token_mint: string;
  token_symbol: string | null;
  tier: string;
  wallet_count: number;
  total_usd: number | null;
  first_trade_at: number;
  last_trade_at: number;
  window_minutes: number | null;
  price_at_detection: number | null;
  price_1h: number | null;
  price_24h: number | null;
  price_7d: number | null;
  outcome: string | null;
}

export interface TradeRow {
  wallet_address: string;
  token_mint: string;
  amount_token: number | null;
  amount_sol: number | null;
  amount_usd: number | null;
  trade_type: "BUY" | "SELL";
  block_time: number;
}

export function openLiveReadonly(dbPath: string = LIVE_DB_PATH): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

export function openLiveWritable(dbPath: string = LIVE_DB_PATH): Database.Database {
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Idempotent: adds convergences.resolved_via TEXT if missing. */
export function ensureResolvedViaColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(convergences)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "resolved_via")) {
    db.exec(`ALTER TABLE convergences ADD COLUMN resolved_via TEXT`);
  }
}

const EIGHT_DAYS = 8 * 86400;

/** Convergences the historical resolver is allowed to touch. */
export function resolvableConvergences(db: Database.Database, nowTs: number, limit?: number): ConvergenceRow[] {
  const sql = `
    SELECT id, token_mint, token_symbol, tier, wallet_count, total_usd,
           first_trade_at, last_trade_at, window_minutes,
           price_at_detection, price_1h, price_24h, price_7d, outcome
    FROM convergences
    WHERE outcome = 'BACKFILL'
       OR (outcome = 'PENDING' AND first_trade_at < ?)
    ORDER BY first_trade_at ASC
    ${limit ? "LIMIT " + Math.floor(limit) : ""}`;
  return db.prepare(sql).all(nowTs - EIGHT_DAYS) as ConvergenceRow[];
}

/** Distinct tokens the fetcher must cover, with per-token detection timestamps. */
export function tokensNeedingCandles(
  db: Database.Database,
  nowTs: number
): Map<string, number[]> {
  // Anchor = last_trade_at (the resolver's t0); COALESCE guards legacy rows.
  const rows = db
    .prepare(
      `SELECT token_mint, COALESCE(last_trade_at, first_trade_at) AS anchor_at FROM convergences
       WHERE (outcome = 'BACKFILL' OR outcome = 'PENDING') AND first_trade_at < ?
       ORDER BY token_mint, anchor_at`
    )
    .all(nowTs - EIGHT_DAYS) as Array<{ token_mint: string; anchor_at: number }>;
  const map = new Map<string, number[]>();
  for (const row of rows) {
    const list = map.get(row.token_mint) ?? [];
    list.push(row.anchor_at);
    map.set(row.token_mint, list);
  }
  return map;
}

export function allBuyAndSellTrades(db: Database.Database): TradeRow[] {
  return db
    .prepare(
      `SELECT wallet_address, token_mint, amount_token, amount_sol, amount_usd, trade_type, block_time
       FROM trades ORDER BY block_time ASC, id ASC`
    )
    .all() as TradeRow[];
}

export function tradesTimeRange(db: Database.Database): { min: number; max: number } {
  return db
    .prepare(`SELECT MIN(block_time) AS min, MAX(block_time) AS max FROM trades`)
    .get() as { min: number; max: number };
}

export interface ResolutionUpdate {
  id: number;
  price_1h: number | null;
  price_24h: number | null;
  price_7d: number | null;
  price_at_detection: number | null;
  outcome: string;
}

/**
 * Applies resolver updates in a single short transaction (callers pass ≤200
 * rows). Only NULL/≤0 price fields are filled — existing live values win.
 */
export function applyResolutionBatch(db: Database.Database, updates: ResolutionUpdate[]): void {
  const stmt = db.prepare(`
    UPDATE convergences SET
      price_at_detection = CASE WHEN price_at_detection IS NULL OR price_at_detection <= 0
                                THEN @price_at_detection ELSE price_at_detection END,
      price_1h  = COALESCE(price_1h,  @price_1h),
      price_24h = COALESCE(price_24h, @price_24h),
      price_7d  = COALESCE(price_7d,  @price_7d),
      outcome = @outcome,
      resolved_via = 'candles'
    WHERE id = @id
  `);
  const txn = db.transaction((rows: ResolutionUpdate[]) => {
    for (const row of rows) stmt.run(row);
  });
  txn(updates);
}
