import { describe, expect, it } from "vitest";
import { detectConvergences, type DetectionParams } from "../detector.js";
import type { TradeRow } from "../live-db.js";
import { SolPriceTable } from "../sol-price.js";

const SOL = SolPriceTable.fromEntries([[0, 100]]); // flat $100/SOL

function buy(wallet: string, mint: string, ts: number, sol = 20): TradeRow {
  return {
    wallet_address: wallet,
    token_mint: mint,
    amount_token: 1000,
    amount_sol: sol,
    amount_usd: null,
    trade_type: "BUY",
    block_time: ts
  };
}

const PARAMS: DetectionParams = {
  windowMinutes: 10,
  minWallets: 2,
  minTradeUsd: 0,
  pumpFilter: "both"
};

describe("detectConvergences", () => {
  it("emits when distinct wallets in window reach the threshold", () => {
    const trades = [buy("A", "mint1pump", 1000), buy("B", "mint1pump", 1200)];
    const events = detectConvergences(trades, PARAMS, SOL);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tokenMint: "mint1pump", detectedAt: 1200, walletCount: 2, isPump: true });
  });

  it("does not emit for repeated buys from the same wallet", () => {
    const trades = [buy("A", "m", 1000), buy("A", "m", 1200), buy("A", "m", 1400)];
    expect(detectConvergences(trades, PARAMS, SOL)).toHaveLength(0);
  });

  it("evicts buys older than the window", () => {
    const trades = [buy("A", "m", 1000), buy("B", "m", 1000 + 11 * 60)];
    expect(detectConvergences(trades, PARAMS, SOL)).toHaveLength(0);
  });

  it("suppresses re-emission during the cooldown, re-arms after", () => {
    const trades = [
      buy("A", "m", 1000),
      buy("B", "m", 1060), // emit #1
      buy("C", "m", 1120), // within cooldown → suppressed
      buy("A", "m", 3000),
      buy("B", "m", 3060) // past cooldown (1060+600=1660) → emit #2
    ];
    const events = detectConvergences(trades, PARAMS, SOL);
    expect(events.map((e) => e.detectedAt)).toEqual([1060, 3060]);
  });

  it("applies the pump filter", () => {
    const trades = [buy("A", "aaapump", 1000), buy("B", "aaapump", 1010), buy("A", "bbb", 1000), buy("B", "bbb", 1010)];
    expect(detectConvergences(trades, { ...PARAMS, pumpFilter: "pump" }, SOL)[0].tokenMint).toBe("aaapump");
    expect(detectConvergences(trades, { ...PARAMS, pumpFilter: "nonpump" }, SOL)[0].tokenMint).toBe("bbb");
  });

  it("applies min_trade_usd using the SOL/USD approximation", () => {
    // 20 SOL × $100 = $2,000 per buy
    const trades = [buy("A", "m", 1000), buy("B", "m", 1010)];
    expect(detectConvergences(trades, { ...PARAMS, minTradeUsd: 2500 }, SOL)).toHaveLength(0);
    expect(detectConvergences(trades, { ...PARAMS, minTradeUsd: 1500 }, SOL)).toHaveLength(1);
  });

  it("ignores SELL trades", () => {
    const trades: TradeRow[] = [buy("A", "m", 1000), { ...buy("B", "m", 1010), trade_type: "SELL" }];
    expect(detectConvergences(trades, PARAMS, SOL)).toHaveLength(0);
  });

  it("NO LOOKAHEAD: truncating the feed at any detection time yields identical events", () => {
    // busy synthetic tape: 3 tokens, interleaved, multiple emissions
    const trades: TradeRow[] = [];
    const wallets = ["A", "B", "C", "D"];
    for (let i = 0; i < 200; i++) {
      const mint = ["t1pump", "t2", "t3pump"][i % 3];
      trades.push(buy(wallets[i % 4], mint, 1000 + i * 97 + (i % 7) * 13));
    }
    const full = detectConvergences(trades, PARAMS, SOL);
    expect(full.length).toBeGreaterThan(2);

    for (const event of full) {
      const truncated = trades.filter((t) => t.block_time <= event.detectedAt);
      const replayed = detectConvergences(truncated, PARAMS, SOL);
      const expected = full.filter((e) => e.detectedAt <= event.detectedAt);
      // identical events (same order, same fields) — detector used no future data
      expect(replayed).toEqual(expected);
    }
  });
});
