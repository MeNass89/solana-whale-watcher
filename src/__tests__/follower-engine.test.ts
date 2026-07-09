import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { FollowerEngine } from "../engine/follower.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import { TradeModel } from "../storage/models/trades.js";
import { WalletModel } from "../storage/models/wallets.js";

function setup(): { db: AppDatabase; trades: TradeModel; wallets: WalletModel } {
  const db = new Database(":memory:") as AppDatabase;
  runMigrations(db);
  const wallets = new WalletModel(db);
  wallets.upsert({
    address: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
    source: "discovered",
    state: "ACTIVE",
    monitorPolicy: "pinned"
  });
  return { db, trades: new TradeModel(db), wallets };
}

describe("FollowerEngine", () => {
  it("opens one follower position from a pinned BUY and dedups while open", async () => {
    const { db, trades, wallets } = setup();
    const swaps = {
      executeSwap: vi.fn().mockResolvedValue({ txSignature: "paper-entry", inputAmount: 1000, outputAmount: 2000, priceImpactPct: 0.5, executedAt: 1 }),
      getExitPriceUsd: vi.fn()
    };
    const engine = new FollowerEngine({ db, wallets, swaps: swaps as any });
    const first = trades.insert({
      chain: "solana",
      walletAddress: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      tokenMint: "mint-pump",
      txSignature: "sig-1",
      amountToken: 10,
      tradeType: "BUY",
      blockTime: 100
    })!;
    const second = trades.insert({
      chain: "solana",
      walletAddress: first.wallet_address,
      tokenMint: first.token_mint,
      txSignature: "sig-2",
      amountToken: 10,
      tradeType: "BUY",
      blockTime: 101
    })!;

    await engine.onTrade(first, 110);
    await engine.onTrade(second, 111);

    expect(swaps.executeSwap).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM follower_signals").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM follower_positions WHERE status = 'OPEN'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM convergences").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT value FROM execution_config WHERE key = 'paper_balance_usd'").get()).toBeUndefined();
  });

  it("records a skip when the entry quote fails instead of synthesizing a fill", async () => {
    const { db, trades, wallets } = setup();
    const swaps = { executeSwap: vi.fn().mockRejectedValue(new Error("Jupiter quote failed: 429")), getExitPriceUsd: vi.fn() };
    const engine = new FollowerEngine({ db, wallets, swaps: swaps as any });
    const trade = trades.insert({
      chain: "solana",
      walletAddress: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      tokenMint: "mint-pump",
      txSignature: "sig-skip",
      amountToken: 10,
      tradeType: "BUY",
      blockTime: 100
    })!;

    await engine.onTrade(trade, 110);

    const signal = db.prepare("SELECT status, skip_reason, fill_price_usd FROM follower_signals").get() as { status: string; skip_reason: string; fill_price_usd: number | null };
    const execution = db.prepare("SELECT status, reason FROM follower_executions").get() as { status: string; reason: string };
    expect(signal.status).toBe("SKIPPED");
    expect(signal.skip_reason).toMatch(/429/);
    expect(signal.fill_price_usd).toBeNull();
    expect(execution.status).toBe("SKIPPED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM follower_positions").get()).toEqual({ count: 0 });
  });

  it("closes follower positions using recipe TP, SL, and max-hold rules", async () => {
    const { db, trades, wallets } = setup();
    const swaps = {
      executeSwap: vi.fn().mockResolvedValue({ txSignature: "paper-entry", inputAmount: 1000, outputAmount: 1000, priceImpactPct: 0, executedAt: 1 }),
      getPriceUsd: vi.fn().mockResolvedValue(999),
      getExitPriceUsd: vi.fn().mockResolvedValue(2)
    };
    const engine = new FollowerEngine({ db, wallets, swaps: swaps as any });
    const trade = trades.insert({
      chain: "solana",
      walletAddress: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      tokenMint: "mint-tp",
      txSignature: "sig-tp",
      amountToken: 10,
      tradeType: "BUY",
      blockTime: 100
    })!;

    await engine.onTrade(trade, 110);
    await engine.checkOpenPositions(120);

    const position = db.prepare("SELECT status, exit_reason, pnl_pct FROM follower_positions").get() as { status: string; exit_reason: string; pnl_pct: number };
    expect(position.status).toBe("CLOSED");
    expect(position.exit_reason).toBe("TAKE_PROFIT");
    expect(position.pnl_pct).toBeCloseTo(100);
    expect(swaps.getExitPriceUsd).toHaveBeenCalledWith("mint-tp", 1000);
    expect(swaps.getPriceUsd).not.toHaveBeenCalled();
  });

  it("marks exit checks degraded after a failed quote and closes degraded on the next successful quote", async () => {
    const { db, trades, wallets } = setup();
    const swaps = {
      executeSwap: vi.fn().mockResolvedValue({ txSignature: "paper-entry", inputAmount: 1000, outputAmount: 1000, priceImpactPct: 0, executedAt: 1 }),
      getExitPriceUsd: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(2)
    };
    const engine = new FollowerEngine({ db, wallets, swaps: swaps as any });
    const trade = trades.insert({
      chain: "solana",
      walletAddress: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      tokenMint: "mint-degraded",
      txSignature: "sig-degraded",
      amountToken: 10,
      tradeType: "BUY",
      blockTime: 100
    })!;

    await engine.onTrade(trade, 110);
    await engine.checkOpenPositions(120);
    expect(db.prepare("SELECT exit_check_failed_at FROM follower_positions").get()).toEqual({ exit_check_failed_at: 120 });

    await engine.checkOpenPositions(130);
    const position = db.prepare("SELECT status, exit_degraded FROM follower_positions").get() as { status: string; exit_degraded: number };
    expect(position.status).toBe("CLOSED");
    expect(position.exit_degraded).toBe(1);
  });

  it("records a concurrency-cap skip before quoting when a survivor already has three open positions", async () => {
    const { db, trades, wallets } = setup();
    const existingTrade = trades.insert({
      chain: "solana",
      walletAddress: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      tokenMint: "mint-existing",
      txSignature: "sig-existing",
      amountToken: 10,
      tradeType: "BUY",
      blockTime: 99
    })!;
    const signalIds: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const signal = db.prepare(
        `INSERT INTO follower_signals
          (trade_id, source_tx_signature, wallet_address, token_mint, recipe_id, block_time, webhook_received_at, status)
         VALUES (?, ?, ?, ?, 'survivor-a-tp100-sl30-1h-1000', 100, 110, 'FILLED')`
      ).run(existingTrade.id, `open-sig-${i}`, "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg", `mint-open-${i}`);
      signalIds.push(Number(signal.lastInsertRowid));
      db.prepare(
        `INSERT INTO follower_positions
          (signal_id, recipe_id, wallet_address, token_mint, amount_token, entry_price_usd, take_profit_price, stop_loss_price, max_hold_at)
         VALUES (?, 'survivor-a-tp100-sl30-1h-1000', ?, ?, 1, 1, 2, 0.7, 9999)`
      ).run(signalIds[i], "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg", `mint-open-${i}`);
    }
    const swaps = { executeSwap: vi.fn(), getExitPriceUsd: vi.fn() };
    const engine = new FollowerEngine({ db, wallets, swaps: swaps as any });
    const trade = trades.insert({
      chain: "solana",
      walletAddress: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      tokenMint: "mint-cap",
      txSignature: "sig-cap",
      amountToken: 10,
      tradeType: "BUY",
      blockTime: 100
    })!;

    await engine.onTrade(trade, 110);

    expect(swaps.executeSwap).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status, skip_reason FROM follower_signals WHERE token_mint = 'mint-cap'").get()).toEqual({
      status: "SKIPPED",
      skip_reason: "CONCURRENCY_CAP"
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM follower_executions").get()).toEqual({ count: 0 });
  });

  it("prevents double close from creating a second SELL execution", async () => {
    const { db, trades, wallets } = setup();
    const swaps = {
      executeSwap: vi.fn().mockResolvedValue({ txSignature: "paper-entry", inputAmount: 1000, outputAmount: 1000, priceImpactPct: 0, executedAt: 1 }),
      getExitPriceUsd: vi.fn().mockResolvedValue(2)
    };
    const engine = new FollowerEngine({ db, wallets, swaps: swaps as any });
    const trade = trades.insert({
      chain: "solana",
      walletAddress: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      tokenMint: "mint-race",
      txSignature: "sig-race",
      amountToken: 10,
      tradeType: "BUY",
      blockTime: 100
    })!;

    await engine.onTrade(trade, 110);
    await engine.checkOpenPositions(120);
    await engine.checkOpenPositions(121);

    expect(db.prepare("SELECT COUNT(*) AS count FROM follower_executions WHERE direction = 'SELL'").get()).toEqual({ count: 1 });
  });

  it("does not trigger entries for dormant pinned wallets", async () => {
    const { db, trades, wallets } = setup();
    wallets.update("CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg", { state: "DORMANT", active: false });
    const swaps = { executeSwap: vi.fn(), getExitPriceUsd: vi.fn() };
    const engine = new FollowerEngine({ db, wallets, swaps: swaps as any });
    const trade = trades.insert({
      chain: "solana",
      walletAddress: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      tokenMint: "mint-dormant",
      txSignature: "sig-dormant",
      amountToken: 10,
      tradeType: "BUY",
      blockTime: 100
    })!;

    await engine.onTrade(trade, 110);

    expect(swaps.executeSwap).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM follower_signals").get()).toEqual({ count: 0 });
  });
});
