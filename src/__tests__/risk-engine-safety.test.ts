import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import type { ConvergenceRow } from "../storage/models/convergences.js";
import type { TradeRow } from "../storage/models/trades.js";
import { RiskEngine } from "../execution/risk-engine.js";

class TestRiskEngine extends RiskEngine {
  constructor(db: AppDatabase, private liquidityUsd: number | null = 1_000_000) {
    super(db);
    this.configure(db);
  }

  override async tokenLiquidityLive(): Promise<number | null> {
    return this.liquidityUsd;
  }

  override async tokenAgeLive(): Promise<number | null> {
    return null;
  }
}

const databases: AppDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("risk-engine safety parameters", () => {
  it("should block entries with volatility > 300%", async () => {
    const { engine, convergence, trades } = setupRisk({ volatility: 350 });

    const result = await engine.checkEntry(convergence, trades, 1);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("volatility 350% exceeds 300% ceiling");
  });

  it("should block entries with liquidity < $25k", async () => {
    const { engine, convergence, trades } = setupRisk({ volatility: 50, liquidityUsd: 10_000 });

    const result = await engine.checkEntry(convergence, trades, 1);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("pool TVL $10000 below $25k minimum");
  });

  it("should block entries with null volatility", async () => {
    const { engine, convergence, trades } = setupRisk({ volatility: null });

    const result = await engine.checkEntry(convergence, trades, 1);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("volatility data unavailable — cannot size position");
  });

  it("should reduce position size aggressively above 50% vol", async () => {
    const at100Vol = setupRisk({ paperBalanceUsd: 100_000, volatility: 100 });
    const at200Vol = setupRisk({ paperBalanceUsd: 100_000, volatility: 200 });

    const sizeAt100Vol = await at100Vol.engine.checkEntry(at100Vol.convergence, at100Vol.trades, 1);
    const sizeAt200Vol = await at200Vol.engine.checkEntry(at200Vol.convergence, at200Vol.trades, 1);

    expect(sizeAt100Vol.allowed).toBe(true);
    expect(sizeAt100Vol.sizeUsd).toBe(500);
    expect(sizeAt200Vol.allowed).toBe(true);
    expect(sizeAt200Vol.sizeUsd).toBe(250);
  });

  it("should cap position at $2000", async () => {
    const { engine, convergence, trades } = setupRisk({ paperBalanceUsd: 1_000_000, volatility: 50, liquidityUsd: 10_000_000 });

    const result = await engine.checkEntry(convergence, trades, 1);

    expect(result.allowed).toBe(true);
    expect(result.sizeUsd).toBe(2_000);
  });
});

function setupRisk(input: {
  volatility: number | null;
  liquidityUsd?: number | null;
  paperBalanceUsd?: number;
}): { engine: TestRiskEngine; convergence: ConvergenceRow; trades: TradeRow[] } {
  const db = new Database(":memory:") as AppDatabase;
  databases.push(db);
  runMigrations(db);
  const engine = new TestRiskEngine(db, input.liquidityUsd ?? 1_000_000);
  db.prepare(
    `INSERT INTO execution_config (key, value, updated_at)
     VALUES ('paper_balance_usd', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(input.paperBalanceUsd ?? 100_000));
  if (input.volatility !== null) {
    db.prepare("INSERT INTO execution_config (key, value, updated_at) VALUES (?, ?, unixepoch())")
      .run("token:mint-a:realized_vol_24h_pct", String(input.volatility));
  }

  return {
    engine,
    convergence: {
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
    },
    trades: [{ amount_usd: 30_000 } as TradeRow]
  };
}
