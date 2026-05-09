import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { auditOpenPositions } from "../execution/position-auditor.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";

const databases: AppDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("position startup audit", () => {
  it("quarantines open positions with bypass-safety violations", () => {
    const db = setupDb();
    const convergenceId = insertConvergence(db, 1, "NOTABLE");
    db.prepare(
      `INSERT INTO positions
        (token_mint, token_symbol, convergence_id, amount_token, entry_price_usd, current_price_usd, tier, status)
       VALUES ('mint-a', 'MINTA', ?, 1e31, 2, 2, 'WATCH', 'OPEN')`
    ).run(convergenceId);

    const result = auditOpenPositions(db);
    const position = db.prepare("SELECT status, exit_reason, closed_at FROM positions WHERE token_mint = 'mint-a'").get() as {
      status: string;
      exit_reason: string;
      closed_at: number | null;
    };

    expect(result.total).toBe(1);
    expect(result.valid).toBe(0);
    expect(result.quarantined).toBe(1);
    expect(result.reasons).toContain("WATCH tier position");
    expect(result.reasons).toContain("invalid amount: 1e+31");
    expect(result.reasons).toContain("convergence had only 1 wallet(s)");
    expect(position.status).toBe("CLOSED");
    expect(position.exit_reason).toContain("AUDIT_QUARANTINE");
    expect(position.closed_at).toEqual(expect.any(Number));
  });

  it("keeps valid open positions active", () => {
    const db = setupDb();
    const convergenceId = insertConvergence(db, 2, "NOTABLE");
    db.prepare(
      `INSERT INTO positions
        (token_mint, token_symbol, convergence_id, amount_token, entry_price_usd, current_price_usd, tier, status)
       VALUES ('mint-b', 'MINTB', ?, 100, 0.001, 0.0012, 'NOTABLE', 'OPEN')`
    ).run(convergenceId);

    const result = auditOpenPositions(db);
    const position = db.prepare("SELECT status, exit_reason FROM positions WHERE token_mint = 'mint-b'").get() as {
      status: string;
      exit_reason: string | null;
    };

    expect(result).toEqual({ total: 1, valid: 1, quarantined: 0, reasons: [] });
    expect(position.status).toBe("OPEN");
    expect(position.exit_reason).toBeNull();
  });

  it("quarantines open positions without convergence backing", () => {
    const db = setupDb();
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO positions
        (token_mint, token_symbol, convergence_id, amount_token, entry_price_usd, current_price_usd, tier, status)
       VALUES ('mint-orphan', 'ORPHAN', 9999, 100, 0.001, 0.0012, 'NOTABLE', 'OPEN')`
    ).run();
    db.pragma("foreign_keys = ON");

    const result = auditOpenPositions(db);
    const position = db.prepare("SELECT status, exit_reason FROM positions WHERE token_mint = 'mint-orphan'").get() as {
      status: string;
      exit_reason: string | null;
    };

    expect(result.quarantined).toBe(1);
    expect(result.reasons).toContain("no convergence backing (orphaned position)");
    expect(position.status).toBe("CLOSED");
    expect(position.exit_reason).toContain("no convergence backing");
  });
});

function setupDb(): AppDatabase {
  const db = new Database(":memory:") as AppDatabase;
  databases.push(db);
  runMigrations(db);
  return db;
}

function insertConvergence(db: AppDatabase, walletCount: number, tier: "WATCH" | "NOTABLE" | "CRITICAL"): number {
  const result = db.prepare(
    `INSERT INTO convergences
      (token_mint, token_symbol, score, tier, wallet_count, first_trade_at, last_trade_at)
     VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())`
  ).run(`conv-${walletCount}-${tier}`, "CONV", 50, tier, walletCount);
  return Number(result.lastInsertRowid);
}
