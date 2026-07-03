/**
 * Discovery DB — data/discovery.sqlite. Resumable state for the wallet
 * archaeology pipeline: pump winners → early buyers → candidate audits.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const DISCOVERY_DB_PATH = "data/discovery.sqlite";

export interface WinnerRow {
  token_mint: string;
  first_ts: number;
  first_close: number;
  peak_ts: number;
  mult: number;
  volume_usd: number;
  status: "pending" | "done" | "skipped";
  note: string | null;
}

export interface EarlyBuyRow {
  token_mint: string;
  wallet: string;
  first_buy_ts: number;
  sol_spent: number;
}

export interface AuditRow {
  wallet: string;
  winners_hit: number;
  n_swaps: number;
  buy_sol: number;
  sell_sol: number;
  net_sol: number;
  span_days: number;
  verdict: string;
  audited_at: number;
}

export function openDiscoveryDb(dbPath = DISCOVERY_DB_PATH): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS winners (
      token_mint TEXT PRIMARY KEY,
      first_ts INTEGER NOT NULL,
      first_close REAL NOT NULL,
      peak_ts INTEGER NOT NULL,
      mult REAL NOT NULL,
      volume_usd REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS early_buys (
      token_mint TEXT NOT NULL,
      wallet TEXT NOT NULL,
      first_buy_ts INTEGER NOT NULL,
      sol_spent REAL NOT NULL,
      PRIMARY KEY (token_mint, wallet)
    );
    CREATE INDEX IF NOT EXISTS idx_early_wallet ON early_buys(wallet);
    CREATE TABLE IF NOT EXISTS audits (
      wallet TEXT PRIMARY KEY,
      winners_hit INTEGER NOT NULL,
      n_swaps INTEGER NOT NULL,
      buy_sol REAL NOT NULL,
      sell_sol REAL NOT NULL,
      net_sol REAL NOT NULL,
      span_days REAL NOT NULL,
      verdict TEXT NOT NULL,
      audited_at INTEGER NOT NULL
    );
  `);
  return db;
}
