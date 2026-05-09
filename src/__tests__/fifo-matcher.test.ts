import { describe, expect, it } from "vitest";
import { matchFifo, type ClosedCycle, type OpenPosition, type RawTrade } from "../engine/fifo-matcher.js";

function buy(input: Partial<RawTrade> = {}): RawTrade {
  return {
    wallet: "wallet-a",
    mint: "mint-a",
    type: "BUY",
    block_time: 1,
    amount_token: 100,
    amount_sol: 1,
    amount_usd: 100,
    ...input
  };
}

function sell(input: Partial<RawTrade> = {}): RawTrade {
  return {
    wallet: "wallet-a",
    mint: "mint-a",
    type: "SELL",
    block_time: 2,
    amount_token: 100,
    amount_sol: 1.5,
    amount_usd: 150,
    ...input
  };
}

function expectCycle(cycle: ClosedCycle, input: Partial<ClosedCycle>): void {
  if (input.wallet != null) expect(cycle.wallet).toBe(input.wallet);
  if (input.mint != null) expect(cycle.mint).toBe(input.mint);
  if (input.closed_at != null) expect(cycle.closed_at).toBe(input.closed_at);
  if (input.hold_time_s != null) expect(cycle.hold_time_s).toBe(input.hold_time_s);
  if (input.cost_sol != null) expect(cycle.cost_sol).toBeCloseTo(input.cost_sol);
  if (input.cost_usd != null) expect(cycle.cost_usd).toBeCloseTo(input.cost_usd);
  if (input.proceeds_sol != null) expect(cycle.proceeds_sol).toBeCloseTo(input.proceeds_sol);
  if (input.proceeds_usd != null) expect(cycle.proceeds_usd).toBeCloseTo(input.proceeds_usd);
  if (input.pnl_sol != null) expect(cycle.pnl_sol).toBeCloseTo(input.pnl_sol);
  if (input.pnl_usd != null) expect(cycle.pnl_usd).toBeCloseTo(input.pnl_usd);
}

function expectOpen(position: OpenPosition, input: Partial<OpenPosition>): void {
  if (input.wallet != null) expect(position.wallet).toBe(input.wallet);
  if (input.mint != null) expect(position.mint).toBe(input.mint);
  if (input.locked_sol != null) expect(position.locked_sol).toBeCloseTo(input.locked_sol);
  if (input.locked_usd != null) expect(position.locked_usd).toBeCloseTo(input.locked_usd);
  if (input.locked_tok != null) expect(position.locked_tok).toBeCloseTo(input.locked_tok);
  if (input.oldest_buy_time != null) expect(position.oldest_buy_time).toBe(input.oldest_buy_time);
}

describe("matchFifo", () => {
  it("returns empty results for empty input", () => {
    const result = matchFifo([]);

    expect(result.cycles).toEqual([]);
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("keeps a single buy with no sell open", () => {
    const result = matchFifo([buy({ block_time: 1000, amount_token: 50, amount_sol: 2, amount_usd: 300 })]);

    expect(result.cycles).toEqual([]);
    expect(result.open).toHaveLength(1);
    expectOpen(result.open[0], {
      wallet: "wallet-a",
      mint: "mint-a",
      locked_tok: 50,
      locked_sol: 2,
      locked_usd: 300,
      oldest_buy_time: 1000
    });
    expect(result.unmatched_sells).toBe(0);
  });

  it("matches a single round-trip", () => {
    const result = matchFifo([buy({ amount_token: 100, amount_sol: 1, amount_usd: 100 }), sell({ amount_token: 100, amount_sol: 1.5, amount_usd: 150 })]);

    expect(result.cycles).toHaveLength(1);
    expectCycle(result.cycles[0], {
      wallet: "wallet-a",
      mint: "mint-a",
      cost_sol: 1,
      cost_usd: 100,
      proceeds_sol: 1.5,
      proceeds_usd: 150,
      pnl_sol: 0.5,
      pnl_usd: 50,
      hold_time_s: 1,
      closed_at: 2
    });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("records hold time for a round-trip", () => {
    const result = matchFifo([buy({ block_time: 1000 }), sell({ block_time: 4600 })]);

    expect(result.cycles).toHaveLength(1);
    expectCycle(result.cycles[0], { hold_time_s: 3600, cost_sol: 1, proceeds_sol: 1.5, pnl_sol: 0.5 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("emits two cycles for two round-trips on the same mint", () => {
    const result = matchFifo([
      buy({ block_time: 1, amount_token: 100, amount_sol: 1, amount_usd: 100 }),
      sell({ block_time: 2, amount_token: 100, amount_sol: 1.5, amount_usd: 150 }),
      buy({ block_time: 3, amount_token: 200, amount_sol: 3, amount_usd: 300 }),
      sell({ block_time: 4, amount_token: 200, amount_sol: 2, amount_usd: 200 })
    ]);

    expect(result.cycles).toHaveLength(2);
    expectCycle(result.cycles[0], { cost_sol: 1, proceeds_sol: 1.5, pnl_sol: 0.5, hold_time_s: 1, closed_at: 2 });
    expectCycle(result.cycles[1], { cost_sol: 3, proceeds_sol: 2, pnl_sol: -1, hold_time_s: 1, closed_at: 4 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("leaves the remaining lot open after a partial sell", () => {
    const result = matchFifo([
      buy({ block_time: 10, amount_token: 100, amount_sol: 1, amount_usd: 100 }),
      sell({ block_time: 20, amount_token: 40, amount_sol: 0.8, amount_usd: 80 })
    ]);

    expect(result.cycles).toHaveLength(1);
    expectCycle(result.cycles[0], { cost_sol: 0.4, cost_usd: 40, proceeds_sol: 0.8, proceeds_usd: 80, pnl_sol: 0.4, hold_time_s: 10 });
    expect(result.open).toHaveLength(1);
    expectOpen(result.open[0], { locked_tok: 60, locked_sol: 0.6, locked_usd: 60, oldest_buy_time: 10 });
    expect(result.unmatched_sells).toBe(0);
  });

  it("drops a sell with no preceding buy as pre-window inventory", () => {
    const result = matchFifo([sell({ block_time: 20, amount_token: 40, amount_sol: 0.8, amount_usd: 80 })]);

    expect(result.cycles).toEqual([]);
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(1);
  });

  it("matches multiple buys into a single sell", () => {
    const result = matchFifo([
      buy({ block_time: 1, amount_token: 50, amount_sol: 1, amount_usd: 100 }),
      buy({ block_time: 2, amount_token: 50, amount_sol: 2, amount_usd: 200 }),
      sell({ block_time: 3, amount_token: 100, amount_sol: 4, amount_usd: 400 })
    ]);

    expect(result.cycles).toHaveLength(1);
    expectCycle(result.cycles[0], { cost_sol: 3, cost_usd: 300, proceeds_sol: 4, proceeds_usd: 400, pnl_sol: 1, hold_time_s: 2 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("preserves FIFO ordering across buy lots", () => {
    const result = matchFifo([
      buy({ block_time: 1, amount_token: 100, amount_sol: 1, amount_usd: 100 }),
      buy({ block_time: 2, amount_token: 100, amount_sol: 2, amount_usd: 200 }),
      sell({ block_time: 3, amount_token: 100, amount_sol: 4, amount_usd: 400 })
    ]);

    expect(result.cycles).toHaveLength(1);
    expectCycle(result.cycles[0], { cost_sol: 1, cost_usd: 100, proceeds_sol: 4, proceeds_usd: 400, pnl_sol: 3, hold_time_s: 2 });
    expect(result.open).toHaveLength(1);
    expectOpen(result.open[0], { locked_tok: 100, locked_sol: 2, locked_usd: 200, oldest_buy_time: 2 });
    expect(result.unmatched_sells).toBe(0);
  });

  it("isolates cycles by mint for the same wallet", () => {
    const result = matchFifo([
      buy({ mint: "mint-a", block_time: 1, amount_token: 100, amount_sol: 1 }),
      buy({ mint: "mint-b", block_time: 2, amount_token: 100, amount_sol: 5 }),
      sell({ mint: "mint-a", block_time: 3, amount_token: 100, amount_sol: 2 }),
      sell({ mint: "mint-b", block_time: 4, amount_token: 100, amount_sol: 7 })
    ]);

    expect(result.cycles).toHaveLength(2);
    expectCycle(result.cycles[0], { mint: "mint-a", cost_sol: 1, proceeds_sol: 2, pnl_sol: 1 });
    expectCycle(result.cycles[1], { mint: "mint-b", cost_sol: 5, proceeds_sol: 7, pnl_sol: 2 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("isolates cycles by wallet", () => {
    const result = matchFifo([
      buy({ wallet: "wallet-a", block_time: 1, amount_token: 100, amount_sol: 1 }),
      buy({ wallet: "wallet-b", block_time: 2, amount_token: 100, amount_sol: 5 }),
      sell({ wallet: "wallet-a", block_time: 3, amount_token: 100, amount_sol: 2 }),
      sell({ wallet: "wallet-b", block_time: 4, amount_token: 100, amount_sol: 7 })
    ]);

    expect(result.cycles).toHaveLength(2);
    expectCycle(result.cycles[0], { wallet: "wallet-a", cost_sol: 1, proceeds_sol: 2, pnl_sol: 1 });
    expectCycle(result.cycles[1], { wallet: "wallet-b", cost_sol: 5, proceeds_sol: 7, pnl_sol: 2 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("matches available inventory and counts overflow when a sell exceeds inventory", () => {
    const result = matchFifo([
      buy({ block_time: 1, amount_token: 50, amount_sol: 1, amount_usd: 100 }),
      sell({ block_time: 2, amount_token: 100, amount_sol: 4, amount_usd: 400 })
    ]);

    expect(result.cycles).toHaveLength(1);
    expectCycle(result.cycles[0], { cost_sol: 1, cost_usd: 100, proceeds_sol: 2, proceeds_usd: 200, pnl_sol: 1, pnl_usd: 100 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(1);
  });

  it("treats tiny remaining token dust as fully consumed", () => {
    const result = matchFifo([
      buy({ block_time: 1, amount_token: 1, amount_sol: 1, amount_usd: 100 }),
      sell({ block_time: 2, amount_token: 0.9999999999, amount_sol: 1.2, amount_usd: 120 })
    ]);

    expect(result.cycles).toHaveLength(1);
    expectCycle(result.cycles[0], { cost_sol: 0.9999999999, proceeds_sol: 1.2, pnl_sol: 0.2000000001 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("uses non-negative sell amounts as stored", () => {
    const result = matchFifo([
      buy({ block_time: 1, amount_token: 100, amount_sol: 1, amount_usd: 100 }),
      sell({ block_time: 2, amount_token: 100, amount_sol: 1.5, amount_usd: 150 })
    ]);

    expect(result.cycles).toHaveLength(1);
    expectCycle(result.cycles[0], { cost_sol: 1, proceeds_sol: 1.5, pnl_sol: 0.5 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("sorts non-chronological input by block_time before matching", () => {
    const result = matchFifo([
      sell({ wallet: "w1", mint: "m1", amount_token: 10, amount_sol: 2, amount_usd: 200, block_time: 200 }),
      buy({ wallet: "w1", mint: "m1", amount_token: 10, amount_sol: 1, amount_usd: 100, block_time: 100 })
    ]);

    expect(result.cycles).toHaveLength(1);
    expectCycle(result.cycles[0], { wallet: "w1", mint: "m1", cost_sol: 1, proceeds_sol: 2, hold_time_s: 100 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });

  it("preserves input order for equal block_time", () => {
    const result = matchFifo([
      buy({ wallet: "w1", mint: "m1", amount_token: 5, amount_sol: 1, amount_usd: 100, block_time: 100 }),
      buy({ wallet: "w1", mint: "m1", amount_token: 5, amount_sol: 2, amount_usd: 200, block_time: 100 }),
      sell({ wallet: "w1", mint: "m1", amount_token: 5, amount_sol: 3, amount_usd: 300, block_time: 200 }),
      sell({ wallet: "w1", mint: "m1", amount_token: 5, amount_sol: 4, amount_usd: 400, block_time: 200 })
    ]);

    expect(result.cycles).toHaveLength(2);
    expectCycle(result.cycles[0], { cost_sol: 1, proceeds_sol: 3 });
    expectCycle(result.cycles[1], { cost_sol: 2, proceeds_sol: 4 });
    expect(result.open).toEqual([]);
    expect(result.unmatched_sells).toBe(0);
  });
});
