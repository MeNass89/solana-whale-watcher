import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CandleStore, type Candle } from "../candle-store.js";
import type { ConvergenceRow } from "../live-db.js";
import { classifyOutcome, resolveRow, TOLERANCE_1H, TOLERANCE_24H, TOLERANCE_7D } from "../resolver.js";

const HOUR = 3600;
const DAY = 86400;
const FT = 1_000_000; // first_trade_at

function row(overrides: Partial<ConvergenceRow> = {}): ConvergenceRow {
  return {
    id: 1,
    token_mint: "tok",
    token_symbol: null,
    tier: "NOTABLE",
    wallet_count: 2,
    total_usd: null,
    first_trade_at: FT,
    last_trade_at: FT,
    window_minutes: 10,
    price_at_detection: null,
    price_1h: null,
    price_24h: null,
    price_7d: null,
    outcome: "BACKFILL",
    ...overrides
  };
}

function candle(ts: number, close: number, timeframe: "minute" | "hour"): Candle {
  return { token_mint: "tok", pool_address: "p", ts, open: close, high: close, low: close, close, volume: 1000, timeframe };
}

describe("classifyOutcome", () => {
  it("applies the ±10%/−20% thresholds on 7d return", () => {
    expect(classifyOutcome(1.0, 1.10)).toBe("WIN");
    expect(classifyOutcome(1.0, 1.09)).toBe("FLAT");
    expect(classifyOutcome(1.0, 0.80)).toBe("LOSS");
    expect(classifyOutcome(1.0, 0.81)).toBe("FLAT");
  });
});

describe("resolveRow", () => {
  let store: CandleStore;
  beforeEach(() => {
    store = new CandleStore(":memory:");
  });
  afterEach(() => store.close());

  it("marks tokens with no candle data DEAD", () => {
    expect(resolveRow(row(), store).outcome).toBe("DEAD");
  });

  it("resolves baseline from candles at detection, IGNORING the stored price_at_detection", () => {
    store.upsertCandles([
      candle(FT + 120, 2.0, "minute"), // baseline candidate, 2 min after ft
      candle(FT + HOUR, 2.2, "minute"),
      candle(FT + DAY, 2.4, "hour"),
      candle(FT + 7 * DAY, 2.5, "hour")
    ]);
    const fromCandles = resolveRow(row(), store);
    expect(fromCandles.price_at_detection).toBe(2.0);
    expect(fromCandles.outcome).toBe("WIN"); // 2.5/2.0 = +25%

    // Stored price stamped late (post-collapse) must NOT poison the baseline:
    // same candle baseline, same outcome, stored value overwritten.
    const staleStored = resolveRow(row({ price_at_detection: 0.002 }), store);
    expect(staleStored.price_at_detection).toBe(2.0);
    expect(staleStored.outcome).toBe("WIN");
  });

  it("falls back to an hourly baseline (±30 min) when no minute candle is near detection", () => {
    store.upsertCandles([
      candle(FT + 20 * 60, 2.0, "hour"), // within ±30 min hourly fallback
      candle(FT + 7 * DAY, 2.5, "hour")
    ]);
    const res = resolveRow(row(), store);
    expect(res.price_at_detection).toBe(2.0);
    expect(res.outcome).toBe("WIN");
  });

  it("respects tolerances: nearest within window, NULL outside", () => {
    store.upsertCandles([
      candle(FT, 1.0, "minute"),
      // 1h target: two candles, nearer one at +9 min must win
      candle(FT + HOUR + 9 * 60, 1.5, "minute"),
      candle(FT + HOUR - 10 * 60, 1.2, "minute"),
      // 24h target: candle just OUTSIDE ±2h
      candle(FT + DAY + TOLERANCE_24H + 60, 9.9, "hour"),
      // 7d target: candle just INSIDE ±6h
      candle(FT + 7 * DAY - TOLERANCE_7D + 60, 1.3, "hour")
    ]);
    const res = resolveRow(row(), store);
    expect(res.price_1h).toBe(1.5);
    expect(res.price_24h).toBeNull();
    expect(res.price_7d).toBe(1.3);
    expect(res.outcome).toBe("WIN"); // 1.3/1.0 = +30%
    expect(TOLERANCE_1H).toBe(600);
  });

  it("marks rows DEAD when candles exist but no 7d close within ±6h (market died)", () => {
    store.upsertCandles([candle(FT, 1.0, "minute"), candle(FT + HOUR, 1.1, "minute")]);
    const res = resolveRow(row(), store);
    expect(res.price_7d).toBeNull();
    expect(res.outcome).toBe("DEAD");
  });

  it("marks rows DEAD when no baseline is resolvable", () => {
    store.upsertCandles([candle(FT + 7 * DAY, 1.0, "hour")]); // nothing near ft
    expect(resolveRow(row(), store).outcome).toBe("DEAD");
  });
});
