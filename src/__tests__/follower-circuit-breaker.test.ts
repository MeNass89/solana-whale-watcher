import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { FollowerEngine } from "../engine/follower.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import { TradeModel } from "../storage/models/trades.js";
import { WalletModel } from "../storage/models/wallets.js";

const WALLET = "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg";
const RECIPE = "survivor-a-tp100-sl30-1h-1000";
const NOW = 1_800_000_000;

function setup(): { db: AppDatabase; trades: TradeModel; wallets: WalletModel } {
  const db = new Database(":memory:") as AppDatabase;
  runMigrations(db);
  const wallets = new WalletModel(db);
  wallets.upsert({ address: WALLET, source: "discovered", state: "ACTIVE", monitorPolicy: "pinned" });
  return { db, trades: new TradeModel(db), wallets };
}

function insertPosition(
  db: AppDatabase,
  input: { openedAt: number; closed?: { at: number; reason: string } },
  index: number
): void {
  const trade = db
    .prepare(
      `INSERT INTO trades (wallet_address, token_mint, tx_signature, amount_token, trade_type, block_time)
       VALUES (?, 'mint-' || ?, 'sig-seed-' || ?, 10, 'BUY', ?)`
    )
    .run(WALLET, index, index, input.openedAt);
  const signal = db
    .prepare(
      `INSERT INTO follower_signals
        (trade_id, source_tx_signature, wallet_address, token_mint, recipe_id, block_time, webhook_received_at)
       VALUES (?, 'sig-seed-' || ?, ?, 'mint-' || ?, ?, ?, ?)`
    )
    .run(Number(trade.lastInsertRowid), index, WALLET, index, RECIPE, input.openedAt, input.openedAt);
  db.prepare(
    `INSERT INTO follower_positions
      (signal_id, recipe_id, wallet_address, token_mint, amount_token, entry_price_usd,
       take_profit_price, stop_loss_price, max_hold_at, status, exit_reason, opened_at, closed_at)
     VALUES (?, ?, ?, 'mint-' || ?, 100, 1, 2, 0.7, ?, ?, ?, ?, ?)`
  ).run(
    Number(signal.lastInsertRowid),
    RECIPE,
    WALLET,
    index,
    input.openedAt + 3600,
    input.closed ? "CLOSED" : "OPEN",
    input.closed?.reason ?? null,
    input.openedAt,
    input.closed?.at ?? null
  );
}

function makeEngine(db: AppDatabase, wallets: WalletModel) {
  const swaps = {
    executeSwap: vi.fn().mockResolvedValue({ txSignature: "paper", inputAmount: 1000, outputAmount: 2000, priceImpactPct: 0.5, executedAt: NOW }),
    getExitPriceUsd: vi.fn()
  };
  const alerts = { send: vi.fn().mockResolvedValue(true) };
  const engine = new FollowerEngine({ db, wallets, swaps: swaps as any, alerts });
  return { engine, swaps, alerts };
}

function insertBuy(trades: TradeModel, signature: string) {
  return trades.insert({
    chain: "solana",
    walletAddress: WALLET,
    tokenMint: "mint-fresh",
    txSignature: signature,
    amountToken: 10,
    tradeType: "BUY",
    blockTime: NOW
  })!;
}

describe("follower circuit breaker", () => {
  it("trips on entry-cadence overflow and marks the wallet DORMANT", async () => {
    const { db, trades, wallets } = setup();
    for (let i = 0; i < 12; i++) {
      insertPosition(db, { openedAt: NOW - 3600, closed: { at: NOW - 1800, reason: i % 2 ? "STOP_LOSS" : "TIME_STOP" } }, i);
    }
    const { engine, swaps, alerts } = makeEngine(db, wallets);

    await engine.onTrade(insertBuy(trades, "sig-cadence"), NOW);

    expect(swaps.executeSwap).not.toHaveBeenCalled();
    expect(wallets.find(WALLET)?.state).toBe("DORMANT");
    expect(alerts.send).toHaveBeenCalledTimes(1);
    const skipped = db
      .prepare("SELECT status, skip_reason FROM follower_signals WHERE source_tx_signature = 'sig-cadence'")
      .get();
    expect(skipped).toEqual({ status: "SKIPPED", skip_reason: "CIRCUIT_BREAKER" });
  });

  it("trips on consecutive stop-losses even at low cadence", async () => {
    const { db, trades, wallets } = setup();
    for (let i = 0; i < 8; i++) {
      // Spread over 8 days so the cadence check stays quiet.
      insertPosition(db, { openedAt: NOW - (i + 2) * 86_400, closed: { at: NOW - (i + 2) * 86_400 + 60, reason: "STOP_LOSS" } }, i);
    }
    const { engine, swaps, alerts } = makeEngine(db, wallets);

    await engine.onTrade(insertBuy(trades, "sig-stops"), NOW);

    expect(swaps.executeSwap).not.toHaveBeenCalled();
    expect(wallets.find(WALLET)?.state).toBe("DORMANT");
    expect(alerts.send).toHaveBeenCalledTimes(1);
  });

  it("allows the entry just under the cadence cap", async () => {
    const { db, trades, wallets } = setup();
    for (let i = 0; i < 11; i++) {
      insertPosition(db, { openedAt: NOW - 3600, closed: { at: NOW - 1800, reason: i % 2 ? "STOP_LOSS" : "TIME_STOP" } }, i);
    }
    const { engine, swaps } = makeEngine(db, wallets);

    await engine.onTrade(insertBuy(trades, "sig-under-cap"), NOW);

    expect(swaps.executeSwap).toHaveBeenCalledTimes(1);
    expect(wallets.find(WALLET)?.state).toBe("ACTIVE");
  });

  it("skips a fill that lands after the wallet went DORMANT mid-flight", async () => {
    const { db, trades, wallets } = setup();
    let releaseSwap: (value: unknown) => void;
    const swapGate = new Promise((resolve) => { releaseSwap = resolve; });
    const swaps = {
      executeSwap: vi.fn().mockImplementation(async () => {
        await swapGate;
        return { txSignature: "paper", inputAmount: 1000, outputAmount: 2000, priceImpactPct: 0.5, executedAt: NOW };
      }),
      getExitPriceUsd: vi.fn()
    };
    const engine = new FollowerEngine({ db, wallets, swaps: swaps as any });

    const entry = engine.onTrade(insertBuy(trades, "sig-inflight"), NOW);
    wallets.update(WALLET, { state: "DORMANT", active: false });
    releaseSwap!(null);
    await entry;

    expect(db.prepare("SELECT COUNT(*) AS count FROM follower_positions").get()).toEqual({ count: 0 });
    const skipped = db
      .prepare("SELECT status, skip_reason FROM follower_signals WHERE source_tx_signature = 'sig-inflight'")
      .get();
    expect(skipped).toEqual({ status: "SKIPPED", skip_reason: "CIRCUIT_BREAKER" });
  });

  it("stays quiet when a recent close is not a stop-loss", async () => {
    const { db, trades, wallets } = setup();
    for (let i = 0; i < 7; i++) {
      insertPosition(db, { openedAt: NOW - (i + 3) * 86_400, closed: { at: NOW - (i + 3) * 86_400 + 60, reason: "STOP_LOSS" } }, i);
    }
    insertPosition(db, { openedAt: NOW - 2 * 86_400, closed: { at: NOW - 2 * 86_400 + 60, reason: "TIME_STOP" } }, 7);
    const { engine, swaps } = makeEngine(db, wallets);

    await engine.onTrade(insertBuy(trades, "sig-ok"), NOW);

    expect(swaps.executeSwap).toHaveBeenCalledTimes(1);
    expect(wallets.find(WALLET)?.state).toBe("ACTIVE");
  });
});
