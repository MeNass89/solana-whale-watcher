import { describe, it, expect } from "vitest";
import { computeWalletMetrics } from "../engine/scorer.js";
import type { TradeRow } from "../storage/models/trades.js";

function makeTrade(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    id: 1, wallet_address: "wallet1", token_mint: "tokenA", tx_signature: "sig1",
    amount_token: 1000, amount_sol: 1, amount_usd: 150, dex_source: "Jupiter",
    trade_type: "BUY", block_time: 1700000000, created_at: 1700000000, ...overrides
  };
}

describe("MEV detection in computeWalletMetrics", () => {
  it("flags wallet as MEV when median hold time < 30s", () => {
    const trades: TradeRow[] = [
      makeTrade({ id: 1, trade_type: "BUY", token_mint: "tokenA", block_time: 1700000000, amount_sol: 1 }),
      makeTrade({ id: 2, trade_type: "SELL", token_mint: "tokenA", block_time: 1700000005, amount_sol: 1.01 }),
      makeTrade({ id: 3, trade_type: "BUY", token_mint: "tokenB", block_time: 1700000100, amount_sol: 2 }),
      makeTrade({ id: 4, trade_type: "SELL", token_mint: "tokenB", block_time: 1700000110, amount_sol: 2.02 }),
      makeTrade({ id: 5, trade_type: "BUY", token_mint: "tokenC", block_time: 1700000200, amount_sol: 3 }),
      makeTrade({ id: 6, trade_type: "SELL", token_mint: "tokenC", block_time: 1700000220, amount_sol: 3.03 }),
    ];
    const metrics = computeWalletMetrics(trades, [], "wallet1");
    expect(metrics.isMev).toBe(true);
    expect(metrics.state).toBe("DEMOTED");
  });

  it("does not flag wallet when hold times are normal", () => {
    const trades: TradeRow[] = [
      makeTrade({ id: 1, trade_type: "BUY", token_mint: "tokenA", block_time: 1700000000, amount_sol: 1 }),
      makeTrade({ id: 2, trade_type: "SELL", token_mint: "tokenA", block_time: 1700003600, amount_sol: 1.5 }),
    ];
    const metrics = computeWalletMetrics(trades, [], "wallet1");
    expect(metrics.isMev).toBe(false);
  });

  it("flags wash trading when >20% of trades are buy+sell same token within 5min", () => {
    const trades: TradeRow[] = [];
    for (let i = 0; i < 10; i++) {
      trades.push(makeTrade({ id: i * 2 + 1, trade_type: "BUY", token_mint: `token${i}`, block_time: 1700000000 + i * 600, amount_sol: 1 }));
      trades.push(makeTrade({ id: i * 2 + 2, trade_type: "SELL", token_mint: `token${i}`, block_time: 1700000000 + i * 600 + (i < 5 ? 120 : 7200), amount_sol: 1.01 }));
    }
    const metrics = computeWalletMetrics(trades, [], "wallet1");
    expect(metrics.isWashTrader).toBe(true);
  });
});
