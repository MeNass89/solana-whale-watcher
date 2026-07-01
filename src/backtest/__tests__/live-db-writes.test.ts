import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyResolutionBatch, ensureResolvedViaColumn } from "../live-db.js";
import { maxDrawdown, median, winsorizedMean } from "../stats.js";

describe("live-DB write path (against a throwaway copy of the schema)", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wt-")), "test.sqlite");
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE convergences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_mint TEXT NOT NULL, tier TEXT, wallet_count INTEGER,
        first_trade_at INTEGER, last_trade_at INTEGER,
        price_at_detection REAL, price_1h REAL, price_24h REAL, price_7d REAL,
        outcome TEXT
      );
    `);
    db.prepare(
      `INSERT INTO convergences (token_mint, first_trade_at, price_at_detection, price_1h, outcome)
       VALUES ('tok', 1000, 2.0, 2.5, 'BACKFILL')`
    ).run();
  });

  afterEach(() => db.close());

  it("resolved_via migration is idempotent", () => {
    ensureResolvedViaColumn(db);
    ensureResolvedViaColumn(db);
    const cols = (db.prepare(`PRAGMA table_info(convergences)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols.filter((c) => c === "resolved_via")).toHaveLength(1);
  });

  it("fills only NULL price fields and never overwrites live values", () => {
    ensureResolvedViaColumn(db);
    applyResolutionBatch(db, [
      { id: 1, price_at_detection: 9.9, price_1h: 9.9, price_24h: 3.0, price_7d: 4.0, outcome: "WIN" }
    ]);
    const row = db.prepare(`SELECT * FROM convergences WHERE id = 1`).get() as Record<string, unknown>;
    expect(row.price_at_detection).toBe(2.0); // existing > 0 → kept
    expect(row.price_1h).toBe(2.5); // existing non-null → kept
    expect(row.price_24h).toBe(3.0); // was NULL → filled
    expect(row.price_7d).toBe(4.0);
    expect(row.outcome).toBe("WIN");
    expect(row.resolved_via).toBe("candles");
  });
});

describe("stats", () => {
  it("winsorized mean clamps the tails", () => {
    const xs = [...Array(98).fill(1), -1000, 1000];
    expect(Math.abs(winsorizedMean(xs, 0.01))).toBeLessThan(5);
    expect(median(xs)).toBe(1);
  });

  it("max drawdown tracks the peak-to-trough of cumulative PnL", () => {
    expect(maxDrawdown([100, -30, -50, 200])).toBe(80);
    expect(maxDrawdown([])).toBe(0);
  });
});
