import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { buildWalletMetrics } from "../../scripts/leaderboard.js";
import type { RawTrade } from "../engine/fifo-matcher.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";

const databases: AppDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("leaderboard script aggregation", () => {
  it("counts repeated round-trips on the same mint as separate closed cycles", () => {
    const db = setupDb();
    db.prepare("INSERT INTO wallets (address, active) VALUES ('wallet-a', 1)").run();
    insertTrade(db, "wallet-a", "mint-a", "BUY", 1, 100, 1, 100);
    insertTrade(db, "wallet-a", "mint-a", "SELL", 2, 100, 1.5, 150);
    insertTrade(db, "wallet-a", "mint-a", "BUY", 3, 200, 3, 300);
    insertTrade(db, "wallet-a", "mint-a", "SELL", 4, 200, 2, 200);

    const trades = db
      .prepare(
        `SELECT wallet_address AS wallet,
                token_mint AS mint,
                trade_type AS type,
                block_time,
                COALESCE(amount_token, 0) AS amount_token,
                COALESCE(amount_sol, 0) AS amount_sol,
                COALESCE(amount_usd, 0) AS amount_usd
         FROM trades
         WHERE block_time > ?
           AND wallet_address IN (SELECT address FROM wallets WHERE active = 1)
         ORDER BY wallet_address, token_mint, block_time, id`
      )
      .all(0) as RawTrade[];

    const result = buildWalletMetrics(["wallet-a"], trades);
    const metrics = result.metrics[0];

    expect(result.unmatched_sells).toBe(0);
    expect(metrics.n_closed).toBe(2);
    expect(metrics.realized_sol).toBeCloseTo(-0.5);
    expect(metrics.wins).toBe(1);
    expect(metrics.n_open).toBe(0);
    expect(metrics.n_partial).toBe(0);
  });
});

function setupDb(): AppDatabase {
  const db = new Database(":memory:") as AppDatabase;
  databases.push(db);
  runMigrations(db);
  return db;
}

function insertTrade(
  db: AppDatabase,
  wallet: string,
  mint: string,
  type: "BUY" | "SELL",
  blockTime: number,
  amountToken: number,
  amountSol: number,
  amountUsd: number
): void {
  db.prepare(
    `INSERT INTO trades (wallet_address, token_mint, tx_signature, amount_token, amount_sol, amount_usd, trade_type, block_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(wallet, mint, `${wallet}-${mint}-${type}-${blockTime}`, amountToken, amountSol, amountUsd, type, blockTime);
}
