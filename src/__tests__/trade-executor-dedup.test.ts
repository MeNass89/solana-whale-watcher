import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/index.js";
import { TradeExecutor } from "../execution/trade-executor.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import type { ConvergenceRow } from "../storage/models/convergences.js";

const databases: AppDatabase[] = [];
let executionEnabled = config.execution.enabled;

afterEach(() => {
  (config.execution as { enabled: boolean }).enabled = executionEnabled;
  for (const db of databases.splice(0)) db.close();
});

describe("trade-executor mint dedup", () => {
  it("skips execution when an open position already exists for the token mint", async () => {
    executionEnabled = config.execution.enabled;
    (config.execution as { enabled: boolean }).enabled = true;
    const db = new Database(":memory:") as AppDatabase;
    databases.push(db);
    runMigrations(db);
    db.prepare(
      `INSERT INTO positions
        (token_mint, token_symbol, amount_token, entry_price_usd, tier, status)
       VALUES ('mint-a', 'MINTA', 10, 1, 'NOTABLE', 'OPEN')`
    ).run();
    const getPriceUsd = vi.fn();
    const executor = new TradeExecutor();
    executor.configure({
      db,
      swaps: { getPriceUsd } as any,
      risk: { checkEntry: vi.fn() } as any,
      positions: { openPosition: vi.fn() } as any,
      discord: { send: vi.fn() } as any
    });

    await executor.onConvergence(convergence(), []);

    expect(getPriceUsd).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
  });
});

function convergence(): ConvergenceRow {
  return {
    id: 1,
    token_mint: "mint-a",
    token_symbol: "MINTA",
    score: 60,
    tier: "NOTABLE",
    wallet_count: 2,
    total_usd: 50_000,
    first_trade_at: Math.floor(Date.now() / 1000),
    last_trade_at: Math.floor(Date.now() / 1000),
    window_minutes: 120,
    alerted_at: null,
    price_at_detection: null,
    price_1h: null,
    price_24h: null,
    price_7d: null,
    outcome: null,
    created_at: Math.floor(Date.now() / 1000)
  };
}
