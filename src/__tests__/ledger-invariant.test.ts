import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/index.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import type { ConvergenceRow } from "../storage/models/convergences.js";
import type { TradeRow } from "../storage/models/trades.js";
import { TokenDecimalsResolver } from "../blockchain/token-decimals.js";
import { PositionManager } from "../execution/position-manager.js";
import { RiskEngine } from "../execution/risk-engine.js";
import { TradeExecutor } from "../execution/trade-executor.js";

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

const INITIAL_BALANCE = 10_000;
// Buy delivers 500 tokens for the ~$100 entry; sells settle 20% above entry.
const BUY_TOKENS = 500;
const EXIT_PRICE = 0.24;

describe("paper ledger invariant (entry + exits through the real executor)", () => {
  it("keeps balance + open cost basis === initial + realized pnl at every step", async () => {
    (config.execution as { enabled: boolean }).enabled = true;
    const db = new Database(":memory:") as AppDatabase;
    databases.push(db);
    runMigrations(db);
    db.prepare("INSERT INTO tokens (mint, decimals) VALUES ('mint-a', 6)").run();
    // Satisfy the executions.convergence_id foreign key.
    db.prepare(
      "INSERT INTO convergences (id, token_mint, token_symbol, score, tier, wallet_count, first_trade_at, last_trade_at) VALUES (1, 'mint-a', 'MINTA', 90, 'CRITICAL', 3, unixepoch(), unixepoch())"
    ).run();
    db.prepare(
      `INSERT INTO execution_config (key, value, updated_at) VALUES ('paper_balance_usd', ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(INITIAL_BALANCE));
    db.prepare(
      `INSERT INTO execution_config (key, value, updated_at) VALUES ('token:mint-a:realized_vol_24h_pct', '50', unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
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
        executeSwap: async (params: { isExitSwap?: boolean; amountLamports: bigint }) => {
          if (params.isExitSwap) {
            const tokens = Number(params.amountLamports) / 1e6;
            return { txSignature: "paper-sell", inputAmount: tokens, outputAmount: tokens * EXIT_PRICE, priceImpactPct: 0, executedAt: Date.now() };
          }
          return { txSignature: "paper-buy", inputAmount: Number(params.amountLamports), outputAmount: BUY_TOKENS, priceImpactPct: 0, executedAt: Date.now() };
        }
      } as any,
      risk,
      positions,
      decimals,
      discord: { send: vi.fn(async () => true) } as any
    });

    const balance = () =>
      Number((db.prepare("SELECT value FROM execution_config WHERE key = 'paper_balance_usd'").get() as { value: string }).value);
    const realizedPnl = () =>
      (db.prepare("SELECT COALESCE(SUM(pnl_usd), 0) AS pnl FROM executions WHERE direction = 'SELL' AND status = 'FILLED'").get() as { pnl: number }).pnl;
    const openCostBasis = () =>
      (db.prepare("SELECT COALESCE(SUM(amount_token * entry_price_usd), 0) AS usd FROM positions WHERE status IN ('OPEN','PARTIAL')").get() as { usd: number }).usd;
    const invariant = () => balance() + openCostBasis() - realizedPnl();

    // Entry
    const now = Math.floor(Date.now() / 1000);
    const conv = {
      id: 1,
      token_mint: "mint-a",
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
    // No amount_sol keeps sizing on the offline fallback path.
    await executor.onConvergence(conv, [{ amount_usd: 30_000, trade_type: "BUY" } as TradeRow]);

    const opened = positions.findOpenByMint("mint-a");
    expect(opened).not.toBeNull();
    const costBasis = opened!.amount_token * opened!.entry_price_usd;
    expect(balance()).toBeCloseTo(INITIAL_BALANCE - costBasis, 6);
    expect(invariant()).toBeCloseTo(INITIAL_BALANCE, 6);

    // Partial exit (50%)
    expect(await executor.exitPosition(opened!, "TEST_PARTIAL", 50)).toBe(true);
    const partial = positions.findById(opened!.id)!;
    expect(partial.status).toBe("PARTIAL");
    expect(invariant()).toBeCloseTo(INITIAL_BALANCE, 6);

    // Full exit of the remainder
    expect(await executor.exitPosition(partial, "TEST_FULL", 100)).toBe(true);
    const closed = positions.findById(opened!.id)!;
    expect(closed.status).toBe("CLOSED");
    expect(openCostBasis()).toBe(0);
    expect(realizedPnl()).toBeGreaterThan(0); // sells settled 20% above entry
    expect(invariant()).toBeCloseTo(INITIAL_BALANCE, 6);
    expect(balance()).toBeCloseTo(INITIAL_BALANCE + realizedPnl(), 6);
  });
});
