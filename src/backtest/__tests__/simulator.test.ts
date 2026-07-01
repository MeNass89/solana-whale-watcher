import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CandleStore, type Candle } from "../candle-store.js";
import type { DetectionEvent } from "../detector.js";
import { K_SLIPPAGE, MAX_SLIPPAGE_BPS, simulateTrade, slippageBps, type SimParams } from "../simulator.js";

describe("slippageBps", () => {
  it("scales with size over candle volume, k=10000", () => {
    // size = 1% of volume → 100 bps
    expect(slippageBps(1000, 100_000 - 1)).toBeCloseTo(100, 5);
    expect(slippageBps(500, 100_000 - 1)).toBeCloseTo(50, 5);
    expect(K_SLIPPAGE).toBe(10_000);
  });

  it("caps at 300 bps, including zero-volume candles", () => {
    expect(slippageBps(1000, 0)).toBe(MAX_SLIPPAGE_BPS);
    expect(slippageBps(1_000_000, 1000)).toBe(MAX_SLIPPAGE_BPS);
  });
});

describe("simulateTrade", () => {
  let store: CandleStore;

  beforeEach(() => {
    store = new CandleStore(":memory:");
  });
  afterEach(() => store.close());

  const MINT = "tok";
  function candle(ts: number, o: number, h: number, l: number, c: number, volume = 1e9): Candle {
    return { token_mint: MINT, pool_address: "p", ts, open: o, high: h, low: l, close: c, volume, timeframe: "minute" };
  }
  const event: DetectionEvent = { tokenMint: MINT, detectedAt: 10_000, walletCount: 2, totalUsd: 5000, isPump: true };
  const params = (exit: Partial<SimParams["exit"]>): SimParams => ({
    latencySeconds: 60,
    sizeUsd: 1000,
    exit: { takeProfitPct: 0.5, stopLossPct: 0.3, maxHoldSeconds: 3600, label: "t", ...exit }
  });

  it("enters at the close of the candle at-or-before entry ts (no future candle)", () => {
    store.upsertCandles([
      candle(10_020, 1, 1, 1, 1.0), // ≤ entryTs 10_060 → entry candle
      candle(10_080, 2, 2, 2, 2.0), // future — must NOT price the entry
      candle(10_140, 2, 2, 2, 2.0)
    ]);
    const sim = simulateTrade(event, store, params({}));
    expect(sim).not.toBeNull();
    expect(sim!.entryPrice).toBeCloseTo(1.0, 3); // huge volume → ~0 slippage
  });

  it("checks SL before TP within the same candle (conservative)", () => {
    store.upsertCandles([
      candle(10_060, 1, 1, 1, 1.0),
      // one candle that touches BOTH sl (0.7) and tp (1.5) → SL wins
      candle(10_120, 1.0, 2.0, 0.5, 1.8)
    ]);
    const sim = simulateTrade(event, store, params({}))!;
    expect(sim.exitReason).toBe("SL");
    expect(sim.exitPrice).toBeCloseTo(0.7, 3);
  });

  it("fills gap-through stops at the candle open (worse price)", () => {
    store.upsertCandles([
      candle(10_060, 1, 1, 1, 1.0),
      candle(10_120, 0.4, 0.45, 0.35, 0.4) // opens far below the 0.7 stop
    ]);
    const sim = simulateTrade(event, store, params({}))!;
    expect(sim.exitReason).toBe("SL");
    expect(sim.exitPrice).toBeCloseTo(0.4, 3);
  });

  it("takes profit at the TP price when only TP is touched", () => {
    store.upsertCandles([candle(10_060, 1, 1, 1, 1.0), candle(10_120, 1.1, 1.9, 1.05, 1.6)]);
    const sim = simulateTrade(event, store, params({}))!;
    expect(sim.exitReason).toBe("TP");
    expect(sim.exitPrice).toBeCloseTo(1.5, 3);
  });

  it("time-exits at the close of the last candle within max hold", () => {
    store.upsertCandles([
      candle(10_060, 1, 1, 1, 1.0),
      candle(10_120, 1.0, 1.1, 0.95, 1.05),
      candle(10_180, 1.05, 1.1, 1.0, 1.08),
      candle(20_000, 3, 3, 3, 3) // beyond maxHold 3600 → ignored
    ]);
    const sim = simulateTrade(event, store, params({}))!;
    expect(sim.exitReason).toBe("TIME");
    expect(sim.exitTs).toBe(10_180);
    expect(sim.exitPrice).toBeCloseTo(1.08, 3);
  });

  it("skips trades with no entry candle or no post-entry candles", () => {
    expect(simulateTrade(event, store, params({}))).toBeNull();
    store.upsertCandles([candle(10_060, 1, 1, 1, 1.0)]); // entry only, nothing after
    expect(simulateTrade(event, store, params({}))).toBeNull();
  });

  it("applies slippage on both legs", () => {
    // volume such that $1000 = 1% → 100 bps each side
    store.upsertCandles([
      candle(10_060, 1, 1, 1, 1.0, 100_000 - 1),
      candle(10_120, 1.0, 1.05, 0.98, 1.0, 100_000 - 1)
    ]);
    const sim = simulateTrade(event, store, params({ maxHoldSeconds: 120 }))!;
    expect(sim.entryPrice).toBeCloseTo(1.01, 5);
    expect(sim.exitPrice).toBeCloseTo(1.0 * 0.99, 5);
    expect(sim.returnPct).toBeCloseTo(0.99 / 1.01 - 1, 5);
  });
});
