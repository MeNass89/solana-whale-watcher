import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/index.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import type { ConvergenceRow } from "../storage/models/convergences.js";
import { PositionManager } from "../execution/position-manager.js";
import { TradeExecutor } from "../execution/trade-executor.js";

const databases: AppDatabase[] = [];
const executionEnabled = config.execution.enabled;

afterEach(() => {
  (config.execution as { enabled: boolean }).enabled = executionEnabled;
  for (const db of databases.splice(0)) db.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function convergence(id: number, mint = "mint-a"): ConvergenceRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    token_mint: mint,
    token_symbol: "MINTA",
    score: 90,
    tier: "CRITICAL",
    wallet_count: 3,
    total_usd: 100_000,
    first_trade_at: now,
    last_trade_at: now,
    window_minutes: 120,
    alerted_at: null,
    price_at_detection: null,
    price_1h: null,
    price_24h: null,
    price_7d: null,
    outcome: null,
    created_at: now
  } as ConvergenceRow;
}

describe("per-mint entry idempotency (#8)", () => {
  it("executes exactly one BUY when two convergences on the same mint race", async () => {
    (config.execution as { enabled: boolean }).enabled = true;
    const db = new Database(":memory:") as AppDatabase;
    databases.push(db);
    runMigrations(db);
    // Satisfy the executions.convergence_id foreign key.
    const insertConv = db.prepare(
      "INSERT INTO convergences (id, token_mint, token_symbol, score, tier, wallet_count, first_trade_at, last_trade_at) VALUES (?, 'mint-a', 'MINTA', 90, 'CRITICAL', 3, unixepoch(), unixepoch())"
    );
    insertConv.run(1);
    insertConv.run(2);
    const positions = new PositionManager();
    positions.configure({ db });
    const executor = new TradeExecutor();
    executor.configure({
      db,
      swaps: {
        getPriceUsd: async () => {
          await sleep(10);
          return 1;
        },
        slippageBpsForLiquidity: () => 100,
        executeSwap: async () => {
          await sleep(20);
          return { txSignature: "paper-buy", inputAmount: 100, outputAmount: 100, priceImpactPct: 0, executedAt: Date.now() };
        }
      } as any,
      risk: {
        checkEntry: async () => ({
          allowed: true,
          adjustedSizePct: 1,
          sizeUsd: 100,
          liquidityUsd: 1_000_000,
          phase: "cold_start",
          portfolioValueUsd: 10_000
        }),
        updatePaperBalance: vi.fn(),
        recordFailedTransaction: vi.fn()
      } as any,
      positions,
      discord: { send: vi.fn(async () => true) } as any
    });

    await Promise.all([executor.onConvergence(convergence(1), []), executor.onConvergence(convergence(2), [])]);

    expect(db.prepare("SELECT COUNT(*) AS count FROM executions WHERE direction = 'BUY'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM positions").get()).toEqual({ count: 1 });
  });

  it("enforces one in-flight BUY per mint at the database level (partial unique index)", () => {
    const db = new Database(":memory:") as AppDatabase;
    databases.push(db);
    runMigrations(db);
    const insert = db.prepare(
      "INSERT INTO executions (token_mint, direction, status, amount_usd) VALUES ('mint-b', 'BUY', ?, 100)"
    );

    insert.run("PENDING");
    expect(() => insert.run("PENDING")).toThrow(/UNIQUE constraint failed/);
    // FILLED rows leave the index: a closed position's historical BUY must
    // never block re-entry on the same mint (post-fill dedup is the
    // open-position check in TradeExecutor, not the index).
    insert.run("FILLED");
    db.prepare("UPDATE executions SET status = 'FILLED' WHERE token_mint = 'mint-b' AND status = 'PENDING'").run();
    insert.run("PENDING");
    // Dead rows (FAILED/CANCELLED) and SELLs stay unconstrained.
    insert.run("FAILED");
    insert.run("CANCELLED");
    db.prepare("INSERT INTO executions (token_mint, direction, status, amount_usd) VALUES ('mint-b', 'SELL', 'PENDING', 100)").run();
  });
});
