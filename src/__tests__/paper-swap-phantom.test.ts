import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/index.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import { JupiterClient, USDC_MINT } from "../execution/jupiter-client.js";
import { TokenDecimalsResolver } from "../blockchain/token-decimals.js";
import { PositionManager } from "../execution/position-manager.js";
import { RiskEngine } from "../execution/risk-engine.js";
import { TradeExecutor } from "../execution/trade-executor.js";

class QuoteFailingJupiter extends JupiterClient {
  override async getQuote(): Promise<never> {
    throw new Error("429 rate limited");
  }
}

class TestRiskEngine extends RiskEngine {
  override async tokenLiquidityLive(): Promise<number | null> {
    return 1_000_000;
  }

  override async tokenAgeLive(): Promise<number | null> {
    return null;
  }
}

const databases: AppDatabase[] = [];
const executionEnabled = config.execution.enabled;

afterEach(() => {
  (config.execution as { enabled: boolean }).enabled = executionEnabled;
  for (const db of databases.splice(0)) db.close();
});

describe("paper swap phantom fill removal (#3)", () => {
  it("rejects the paper swap instead of synthesizing a fill when the quote fails", async () => {
    const client = new QuoteFailingJupiter();

    await expect(
      client.executeSwap({
        inputMint: USDC_MINT,
        outputMint: "mint-a",
        amountLamports: 1_000_000n,
        slippageBps: 100,
        tier: "CRITICAL"
      })
    ).rejects.toThrow(/refusing to synthesize a fill/);
  });

  it("keeps the position open and the balance untouched when the exit swap fails", async () => {
    (config.execution as { enabled: boolean }).enabled = true;
    const db = new Database(":memory:") as AppDatabase;
    databases.push(db);
    runMigrations(db);
    db.prepare("INSERT INTO tokens (mint, decimals) VALUES ('mint-a', 6)").run();
    db.prepare(
      `INSERT INTO execution_config (key, value, updated_at) VALUES ('paper_balance_usd', '10000', unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
    db.prepare(
      `INSERT INTO positions (token_mint, token_symbol, amount_token, entry_price_usd, tier, status)
       VALUES ('mint-a', 'MINTA', 1000, 1, 'CRITICAL', 'OPEN')`
    ).run();

    const risk = new TestRiskEngine();
    risk.configure(db);
    const positions = new PositionManager();
    positions.configure({ db });
    const decimals = new TokenDecimalsResolver();
    decimals.configure({ db, fetchOnChain: async () => null });
    const executor = new TradeExecutor();
    executor.configure({
      db,
      swaps: {
        getPriceUsd: async () => 1,
        slippageBpsForLiquidity: () => 100,
        executeSwap: vi.fn(async () => {
          throw new Error("Jupiter paper quote unavailable; refusing to synthesize a fill: 429");
        })
      } as any,
      risk,
      positions,
      decimals,
      discord: { send: vi.fn(async () => true) } as any
    });

    const position = positions.findById(1)!;
    const sold = await executor.exitPosition(position, "TEST_EXIT", 100);

    expect(sold).toBe(false);
    const execution = db.prepare("SELECT direction, status FROM executions").all();
    expect(execution).toEqual([{ direction: "SELL", status: "FAILED" }]);
    const balance = db.prepare("SELECT value FROM execution_config WHERE key = 'paper_balance_usd'").get() as { value: string };
    expect(Number(balance.value)).toBe(10_000);
    const after = positions.findById(1)!;
    expect(after.status).toBe("OPEN");
    expect(after.amount_token).toBe(1000);
  });
});
