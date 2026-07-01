import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import { PositionManager } from "../execution/position-manager.js";

const databases: AppDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

interface Setup {
  db: AppDatabase;
  manager: PositionManager;
  exitHandler: ReturnType<typeof vi.fn>;
}

function setup(input: { priceUsd: number; openedSecondsAgo: number; exitResult: boolean }): Setup {
  const db = new Database(":memory:") as AppDatabase;
  databases.push(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO positions
      (token_mint, token_symbol, amount_token, entry_price_usd, tier, status, opened_at)
     VALUES ('mint-a', 'MINTA', 1000, 1, 'NOTABLE', 'OPEN', ?)`
  ).run(Math.floor(Date.now() / 1000) - input.openedSecondsAgo);
  const exitHandler = vi.fn(async () => input.exitResult);
  const manager = new PositionManager();
  manager.configure({
    db,
    priceClient: {
      getPriceUsd: async () => input.priceUsd,
      getExitQuoteUsd: async () => null
    } as any,
    decimals: { resolve: async () => 9 } as any,
    exitHandler
  });
  return { db, manager, exitHandler };
}

describe("FLAT_6H_EXIT latch (#1)", () => {
  it("fires the 50% flat trim exactly once across ticks after a successful exit", async () => {
    const { manager, exitHandler } = setup({ priceUsd: 1.02, openedSecondsAgo: 7 * 60 * 60, exitResult: true });

    await manager.checkOpenPositions();
    await manager.checkOpenPositions();
    await manager.checkOpenPositions();

    const flatCalls = exitHandler.mock.calls.filter((call) => call[1] === "FLAT_6H_EXIT");
    expect(flatCalls).toHaveLength(1);
    expect(flatCalls[0][2]).toBe(50);
  });

  it("does not set the latch when the exit fails, so it retries next tick", async () => {
    const { manager, exitHandler } = setup({ priceUsd: 1.02, openedSecondsAgo: 7 * 60 * 60, exitResult: false });

    await manager.checkOpenPositions();
    await manager.checkOpenPositions();

    const flatCalls = exitHandler.mock.calls.filter((call) => call[1] === "FLAT_6H_EXIT");
    expect(flatCalls).toHaveLength(2);
  });

  it("still fires the FLAT_24H full exit past 24h regardless of the latch", async () => {
    const { db, manager, exitHandler } = setup({ priceUsd: 1.02, openedSecondsAgo: 25 * 60 * 60, exitResult: true });
    // Simulate a latch left behind by an earlier 6h trim.
    db.prepare("INSERT INTO execution_config (key, value, updated_at) VALUES ('position:1:flat_6h_exit_done', '1', unixepoch())").run();

    await manager.checkOpenPositions();

    const calls = exitHandler.mock.calls.map((call) => call[1]);
    expect(calls).toContain("FLAT_24H_EXIT");
    expect(calls).not.toContain("FLAT_6H_EXIT");
  });
});

describe("take-profit rung burn (#5)", () => {
  it("keeps the rung unexecuted when the exit swap fails, then burns it on success", async () => {
    const { db, manager, exitHandler } = setup({ priceUsd: 1.6, openedSecondsAgo: 60 * 60, exitResult: false });

    await manager.checkOpenPositions();

    // Failed exit: rung must remain unburned (column may still be NULL when
    // the default ladder was never persisted, which also means "not executed").
    const rawAfterFail = (db.prepare("SELECT take_profit_prices FROM positions WHERE id = 1").get() as { take_profit_prices: string | null })
      .take_profit_prices;
    const levelsAfterFail = rawAfterFail
      ? (JSON.parse(rawAfterFail) as Array<{ targetPct: number; executed: boolean }>)
      : [];
    expect(exitHandler.mock.calls.filter((call) => call[1] === "TAKE_PROFIT_50")).toHaveLength(1);
    expect(levelsAfterFail.find((level) => level.targetPct === 50)?.executed ?? false).toBe(false);

    exitHandler.mockResolvedValue(true);
    await manager.checkOpenPositions();

    const levels = JSON.parse(
      (db.prepare("SELECT take_profit_prices FROM positions WHERE id = 1").get() as { take_profit_prices: string }).take_profit_prices
    ) as Array<{ targetPct: number; executed: boolean }>;
    expect(exitHandler.mock.calls.filter((call) => call[1] === "TAKE_PROFIT_50")).toHaveLength(2);
    expect(levels.find((level) => level.targetPct === 50)?.executed).toBe(true);
  });
});
