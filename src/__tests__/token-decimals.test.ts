import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/index.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import { TokenDecimalsResolver, UnknownTokenDecimalsError } from "../blockchain/token-decimals.js";
import { PositionManager } from "../execution/position-manager.js";
import { TradeExecutor } from "../execution/trade-executor.js";

const databases: AppDatabase[] = [];
const executionEnabled = config.execution.enabled;

afterEach(() => {
  (config.execution as { enabled: boolean }).enabled = executionEnabled;
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): AppDatabase {
  const db = new Database(":memory:") as AppDatabase;
  databases.push(db);
  runMigrations(db);
  return db;
}

describe("shared token decimals resolution (#6)", () => {
  it("throws UnknownTokenDecimalsError instead of guessing when no source knows the mint", async () => {
    const resolver = new TokenDecimalsResolver();
    resolver.configure({ db: freshDb(), fetchOnChain: async () => null });

    await expect(resolver.resolve("mint-unknown")).rejects.toBeInstanceOf(UnknownTokenDecimalsError);
  });

  it("resolves well-known mints without any lookup", async () => {
    const resolver = new TokenDecimalsResolver();
    resolver.configure({ db: freshDb(), fetchOnChain: async () => null });

    await expect(resolver.resolve("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).resolves.toBe(6);
    await expect(resolver.resolve("So11111111111111111111111111111111111111112")).resolves.toBe(9);
    // Canonical USDT mint (the old jupiter-client constant was wrong).
    await expect(resolver.resolve("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")).resolves.toBe(6);
  });

  it("reads decimals from the tokens table", async () => {
    const db = freshDb();
    db.prepare("INSERT INTO tokens (mint, decimals) VALUES ('mint-a', 7)").run();
    const resolver = new TokenDecimalsResolver();
    resolver.configure({ db, fetchOnChain: async () => null });

    await expect(resolver.resolve("mint-a")).resolves.toBe(7);
  });

  it("falls back to the on-chain fetcher and persists the result", async () => {
    const db = freshDb();
    const fetchOnChain = vi.fn(async () => 5);
    const resolver = new TokenDecimalsResolver();
    resolver.configure({ db, fetchOnChain });

    await expect(resolver.resolve("mint-b")).resolves.toBe(5);
    // Persisted for the next process; cached for this one.
    expect(db.prepare("SELECT decimals FROM tokens WHERE mint = 'mint-b'").get()).toEqual({ decimals: 5 });
    await expect(resolver.resolve("mint-b")).resolves.toBe(5);
    expect(fetchOnChain).toHaveBeenCalledTimes(1);
  });

  it("fails the position exit (no swap attempted) when decimals are unresolvable", async () => {
    (config.execution as { enabled: boolean }).enabled = true;
    const db = freshDb();
    db.prepare(
      `INSERT INTO positions (token_mint, token_symbol, amount_token, entry_price_usd, tier, status)
       VALUES ('mint-unknown', 'UNK', 1000, 1, 'CRITICAL', 'OPEN')`
    ).run();
    const positions = new PositionManager();
    positions.configure({ db });
    const decimals = new TokenDecimalsResolver();
    decimals.configure({ db, fetchOnChain: async () => null });
    const executeSwap = vi.fn();
    const executor = new TradeExecutor();
    executor.configure({
      db,
      swaps: { getPriceUsd: async () => 1, slippageBpsForLiquidity: () => 100, executeSwap } as any,
      risk: { tokenLiquidityLive: async () => 1_000_000, recordFailedTransaction: vi.fn() } as any,
      positions,
      decimals,
      discord: { send: vi.fn(async () => true) } as any
    });

    const sold = await executor.exitPosition(positions.findById(1)!, "TEST_EXIT", 100);

    expect(sold).toBe(false);
    expect(executeSwap).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
    expect(positions.findById(1)!.status).toBe("OPEN");
  });
});
