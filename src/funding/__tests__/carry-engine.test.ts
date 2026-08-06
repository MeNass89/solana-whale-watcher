import { describe, expect, it } from "vitest";
import {
  calculateExecutionCost,
  evaluateCarryPoll,
  type CarryConfig,
  type EnginePosition,
  type FundingSnapshot
} from "../carry-engine.js";
import {
  parseBinancePayload,
  parseBybitPayload,
  parseHyperliquidPayload
} from "../venues.js";
import { FundingStore } from "../store.js";
import { formatPollLine } from "../monitor.js";

const config: CarryConfig = {
  entryThresholdAnnualized: 10,
  exitThresholdAnnualized: 5,
  notionalUsd: 1_000,
  enabled: true
};

function snapshot(
  venue: FundingSnapshot["venue"],
  rateAnnualized: number,
  ts = 1_000,
  asset: FundingSnapshot["asset"] = "SOL"
): FundingSnapshot {
  return {
    ts,
    asset,
    venue,
    rateRaw: rateAnnualized / (venue === "hyperliquid" ? 24 * 365 * 100 : 3 * 365 * 100),
    rateAnnualized,
    markPrice: 150
  };
}

function position(overrides: Partial<EnginePosition> = {}): EnginePosition {
  return {
    id: 1,
    asset: "SOL",
    longVenue: "binance",
    shortVenue: "bybit",
    entryTs: 0,
    entrySpreadAnnualized: 20,
    entryThreshold: 10,
    notionalUsd: 1_000,
    entryCostUsd: 1.45,
    fundingAccruedUsd: 0,
    ...overrides
  };
}

describe("evaluateCarryPoll", () => {
  it("opens only when the spread is strictly above the entry threshold", () => {
    const atThreshold = evaluateCarryPoll(
      [snapshot("binance", 0), snapshot("bybit", 10)],
      [],
      config,
      0
    );
    expect(atThreshold.entries).toHaveLength(0);

    const aboveThreshold = evaluateCarryPoll(
      [snapshot("binance", 0), snapshot("bybit", 10.01)],
      [],
      config,
      0
    );
    expect(aboveThreshold.entries).toEqual([
      expect.objectContaining({
        asset: "SOL",
        longVenue: "binance",
        shortVenue: "bybit",
        entrySpreadAnnualized: 10.01,
        entryThreshold: 10,
        notionalUsd: 1_000
      })
    ]);
  });

  it("does not open a duplicate for an already-open asset and venue pair", () => {
    const result = evaluateCarryPoll(
      [snapshot("binance", 0), snapshot("bybit", 20)],
      [position()],
      config,
      0
    );

    expect(result.entries).toHaveLength(0);
    expect(result.exits).toHaveLength(0);
  });

  it("accrues both funding legs from current rates over the exact elapsed time", () => {
    const halfYearMs = (365 * 24 * 60 * 60 * 1_000) / 2;
    const result = evaluateCarryPoll(
      [snapshot("binance", 10), snapshot("bybit", 30)],
      [position()],
      config,
      halfYearMs
    );

    expect(result.accruals).toEqual([{ positionId: 1, amountUsd: 100 }]);
    expect(result.exits).toHaveLength(0);
  });

  it("exits when the short-minus-long spread flips negative", () => {
    const result = evaluateCarryPoll(
      [snapshot("binance", 20), snapshot("bybit", 10)],
      [position()],
      config,
      0
    );

    expect(result.exits).toEqual([
      expect.objectContaining({ positionId: 1, exitSpread: -10, exitReason: "sign_flip" })
    ]);
  });

  it("exits inside the strict hysteresis band", () => {
    const result = evaluateCarryPoll(
      [snapshot("binance", 2), snapshot("bybit", 6)],
      [position()],
      config,
      0
    );

    expect(result.exits).toEqual([
      expect.objectContaining({ positionId: 1, exitSpread: 4, exitReason: "hysteresis" })
    ]);
  });

  it("charges exact venue fees plus slippage on both legs at entry and exit", () => {
    expect(calculateExecutionCost("binance", "bybit", 1_000)).toBeCloseTo(1.45, 12);

    const entry = evaluateCarryPoll(
      [snapshot("binance", 0), snapshot("bybit", 20)],
      [],
      config,
      0
    ).entries[0];
    expect(entry.entryCostUsd).toBeCloseTo(1.45, 12);

    const exit = evaluateCarryPoll(
      [snapshot("binance", 20), snapshot("bybit", 10)],
      [position({ fundingAccruedUsd: 10 })],
      config,
      0
    ).exits[0];
    expect(exit.exitCostUsd).toBeCloseTo(1.45, 12);
    expect(exit.netPnlUsd).toBeCloseTo(7.1, 12);
  });
});

describe("venue payload normalization", () => {
  it("normalizes Binance and Bybit 8-hour rates to annualized percent", () => {
    expect(parseBinancePayload("SOL", { lastFundingRate: "0.0001", markPrice: "150" }, 123)).toEqual({
      ts: 123,
      asset: "SOL",
      venue: "binance",
      rateRaw: 0.0001,
      rateAnnualized: 10.95,
      markPrice: 150
    });
    expect(
      parseBybitPayload(
        "SOL",
        { retCode: 0, result: { list: [{ fundingRate: "0.0002", markPrice: "151" }] } },
        123
      )
    ).toEqual({
      ts: 123,
      asset: "SOL",
      venue: "bybit",
      rateRaw: 0.0002,
      rateAnnualized: 21.9,
      markPrice: 151
    });
  });

  it("joins Hyperliquid contexts by universe index and annualizes hourly rates", () => {
    const result = parseHyperliquidPayload(
      [
        { universe: [{ name: "BTC" }, { name: "SOL" }, { name: "ETH" }] },
        [
          { funding: "0.00001", markPx: "60000" },
          { funding: "0.00002", markPx: "150" },
          { funding: "-0.00001", markPx: "3000" }
        ]
      ],
      123
    );

    expect(result).toEqual([
      expect.objectContaining({ asset: "SOL", rateAnnualized: 17.52, markPrice: 150 }),
      expect.objectContaining({ asset: "BTC", rateAnnualized: 8.76, markPrice: 60000 }),
      expect.objectContaining({ asset: "ETH", rateAnnualized: -8.76, markPrice: 3000 })
    ]);
  });
});

describe("FundingStore", () => {
  it("creates the isolated schema and seeds the DEAD-verdict live-measurement defaults", () => {
    const store = new FundingStore(":memory:");
    try {
      expect(store.getConfig()).toEqual(config);
      const columns = store.database
        .prepare("PRAGMA table_info(carry_positions)")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "asset",
          "long_venue",
          "short_venue",
          "entry_cost_usd",
          "funding_accrued_usd",
          "net_pnl_usd"
        ])
      );
    } finally {
      store.close();
    }
  });

  it("persists one poll and exposes its open paper position", () => {
    const store = new FundingStore(":memory:");
    const snapshots = [snapshot("binance", 0, 123), snapshot("bybit", 20, 123)];
    const decision = evaluateCarryPoll(snapshots, [], config, 0);
    try {
      store.applyPoll(snapshots, decision);
      expect(store.getLatestSnapshotTs()).toBe(123);
      expect(store.getSnapshotCount()).toBe(2);
      expect(store.getOpenPositions()).toEqual([
        expect.objectContaining({
          asset: "SOL",
          longVenue: "binance",
          shortVenue: "bybit",
          entryCostUsd: 1.45,
          fundingAccruedUsd: 0
        })
      ]);
    } finally {
      store.close();
    }
  });
});

describe("monitor log formatting", () => {
  it("renders every pair spread plus open count and cumulative net PnL on one line", () => {
    const spreads = evaluateCarryPoll(
      [snapshot("hyperliquid", 15), snapshot("binance", 10), snapshot("bybit", 0)],
      [],
      config,
      0
    ).spreads;

    expect(formatPollLine(0, spreads, 2, -1.234)).toBe(
      "1970-01-01T00:00:00.000Z SOL HL-BIN=+5.00% HL-BYB=+15.00% BIN-BYB=+10.00% open=2 net=$-1.23"
    );
  });
});
