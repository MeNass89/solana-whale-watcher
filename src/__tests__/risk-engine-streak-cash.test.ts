import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import type { ConvergenceRow } from "../storage/models/convergences.js";
import type { TradeRow } from "../storage/models/trades.js";
import { RiskEngine } from "../execution/risk-engine.js";

class TestRiskEngine extends RiskEngine {
  constructor(db: AppDatabase) {
    super(db);
    this.configure(db);
  }

  override async tokenLiquidityLive(): Promise<number | null> {
    return 1_000_000;
  }

  override async tokenAgeLive(): Promise<number | null> {
    return null;
  }
}

const databases: AppDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const NOW = () => Math.floor(Date.now() / 1000);

function setup(paperBalanceUsd = 100_000): { db: AppDatabase; engine: TestRiskEngine } {
  const db = new Database(":memory:") as AppDatabase;
  databases.push(db);
  runMigrations(db);
  const engine = new TestRiskEngine(db);
  db.prepare(
    `INSERT INTO execution_config (key, value, updated_at) VALUES ('paper_balance_usd', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(paperBalanceUsd));
  db.prepare(
    `INSERT INTO execution_config (key, value, updated_at) VALUES ('token:mint-a:realized_vol_24h_pct', '50', unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run();
  return { db, engine };
}

function insertSellFill(db: AppDatabase, pnlUsd: number, closedAt: number): void {
  db.prepare(
    "INSERT INTO executions (token_mint, direction, status, pnl_usd, closed_at, created_at) VALUES ('mint-x', 'SELL', 'FILLED', ?, ?, ?)"
  ).run(pnlUsd, closedAt, closedAt);
}

function convergence(): ConvergenceRow {
  return {
    id: 1,
    token_mint: "mint-a",
    token_symbol: "MINTA",
    score: 80,
    tier: "CRITICAL",
    wallet_count: 3,
    total_usd: 100_000,
    first_trade_at: 1,
    last_trade_at: 2,
    window_minutes: 120,
    alerted_at: null,
    price_at_detection: null,
    price_1h: null,
    price_24h: null,
    price_7d: null,
    outcome: null,
    created_at: 2
  } as ConvergenceRow;
}

// No amount_sol keeps computeMirrorSizePct on the offline fallback path.
const trades = (): TradeRow[] => [{ amount_usd: 30_000, trade_type: "BUY" } as TradeRow];

describe("loss-streak circuit breaker (#2)", () => {
  it("pauses entries after 5 consecutive significant losses", async () => {
    const { db, engine } = setup();
    for (let i = 0; i < 5; i++) insertSellFill(db, -10, NOW() - 60 * (5 - i));

    const result = await engine.checkEntry(convergence(), trades(), 1);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("5 consecutive losses");
    const pausedUntil = db.prepare("SELECT value FROM execution_config WHERE key = 'entries_paused_until'").get() as { value: string };
    expect(Number(pausedUntil.value)).toBeGreaterThan(NOW());
  });

  it("ignores dust exits below the $1 epsilon", async () => {
    const { db, engine } = setup();
    for (let i = 0; i < 5; i++) insertSellFill(db, -1e-13, NOW() - 60 * (5 - i));

    const result = await engine.checkEntry(convergence(), trades(), 1);

    expect(result.allowed).toBe(true);
  });

  it("ignores losses older than the 7-day window", async () => {
    const { db, engine } = setup();
    const eightDaysAgo = NOW() - 8 * 24 * 60 * 60;
    for (let i = 0; i < 5; i++) insertSellFill(db, -10, eightDaysAgo - 60 * (5 - i));

    const result = await engine.checkEntry(convergence(), trades(), 1);

    expect(result.allowed).toBe(true);
  });

  it("does not re-arm the pause for the same streak once it expires (no deadlock)", async () => {
    const { db, engine } = setup();
    for (let i = 0; i < 5; i++) insertSellFill(db, -10, NOW() - 60 * (5 - i));

    const first = await engine.checkEntry(convergence(), trades(), 1);
    expect(first.allowed).toBe(false);
    expect(first.reason).toBe("5 consecutive losses");

    // Simulate the 6h cooldown elapsing with the streak still standing.
    db.prepare("UPDATE execution_config SET value = ? WHERE key = 'entries_paused_until'").run(String(NOW() - 1));

    const second = await engine.checkEntry(convergence(), trades(), 1);

    expect(second.allowed).toBe(true);
    const pausedUntil = db.prepare("SELECT value FROM execution_config WHERE key = 'entries_paused_until'").get() as { value: string };
    expect(Number(pausedUntil.value)).toBeLessThan(NOW() + 1);
  });
});

describe("paper cash gate (#11)", () => {
  it("rejects entries whose size exceeds spendable paper cash", async () => {
    const { db, engine } = setup(10); // $10 cash left
    // Heavy open exposure inflates portfolio value, and with it the % sizing.
    db.prepare(
      `INSERT INTO positions (token_mint, token_symbol, amount_token, entry_price_usd, current_price_usd, tier, status)
       VALUES ('mint-open', 'OPEN', 100000, 1, 1, 'CRITICAL', 'OPEN')`
    ).run();

    const result = await engine.checkEntry(convergence(), trades(), 1);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/^insufficient cash: size \$/);
  });

  it("allows entries when cash covers the computed size", async () => {
    const { engine } = setup(100_000);

    const result = await engine.checkEntry(convergence(), trades(), 1);

    expect(result.allowed).toBe(true);
    expect(result.sizeUsd).toBeGreaterThan(0);
  });
});
