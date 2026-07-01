/**
 * `replay` command — re-derives convergence events from raw `trades` with a
 * parameterized detector, simulates entries/exits on stored candles, and
 * evaluates a config grid with a walk-forward split (calibrate on the first
 * half of the time range, validate on the second half).
 *
 * Results are written to backtest/replay-results.json for the `report`
 * command to render.
 */
import fs from "node:fs";
import path from "node:path";
import { CandleStore } from "./candle-store.js";
import { detectConvergences, type DetectionParams, type PumpFilter } from "./detector.js";
import { allBuyAndSellTrades, openLiveReadonly, tradesTimeRange } from "./live-db.js";
import { SolPriceTable } from "./sol-price.js";
import { simulateTrade, type ExitRule, type SimTrade } from "./simulator.js";
import { maxDrawdown, mean, median, winRate, winsorizedMean } from "./stats.js";

export interface ConfigMetrics {
  nTrades: number;
  medianReturnPct: number;
  meanReturnPct: number;
  winsorizedMeanReturnPct: number;
  winRate: number;
  totalPnlUsd: number;
  maxDrawdownUsd: number;
  avgHoldHours: number;
}

export interface ConfigResult {
  detection: DetectionParams;
  exit: ExitRule;
  latencySeconds: number;
  sizeUsd: number;
  overall: ConfigMetrics;
  train: ConfigMetrics;
  valid: ConfigMetrics;
  trainRank?: number;
  validRank?: number;
  overfitFlag?: boolean;
}

export interface ReplayOutput {
  generatedAt: number;
  splitTs: number;
  timeRange: { min: number; max: number };
  eventsSimulatedNote: string;
  configs: ConfigResult[];
}

const HOUR = 3600;

export function computeMetrics(trades: SimTrade[]): ConfigMetrics {
  const rets = trades.map((t) => t.returnPct * 100);
  const pnls = [...trades].sort((a, b) => a.entryTs - b.entryTs).map((t) => t.pnlUsd);
  return {
    nTrades: trades.length,
    medianReturnPct: median(rets),
    meanReturnPct: mean(rets),
    winsorizedMeanReturnPct: winsorizedMean(rets),
    winRate: winRate(rets),
    totalPnlUsd: pnls.reduce((a, b) => a + b, 0),
    maxDrawdownUsd: maxDrawdown(pnls),
    avgHoldHours: mean(trades.map((t) => t.holdSeconds / HOUR))
  };
}

export function defaultDetectionGrid(): DetectionParams[] {
  const grid: DetectionParams[] = [];
  for (const windowMinutes of [10, 30]) {
    for (const minWallets of [2, 3]) {
      for (const minTradeUsd of [0, 500]) {
        for (const pumpFilter of ["pump", "nonpump"] as PumpFilter[]) {
          grid.push({ windowMinutes, minWallets, minTradeUsd, pumpFilter });
        }
      }
    }
  }
  return grid;
}

export function defaultExitGrid(): ExitRule[] {
  const grid: ExitRule[] = [];
  // Memecoin whale plays resolve in minutes: the horizon curve shows returns
  // peaking at ~15m and win rate hitting 0% past 12h, so nothing beyond 12h
  // belongs in the grid. 5m is the shortest hold walkable on minute candles.
  for (const takeProfitPct of [0.2, 0.5, 1.0]) {
    for (const stopLossPct of [0.15, 0.3]) {
      for (const maxHoldSeconds of [300, 900, 1800, 1 * HOUR, 2 * HOUR, 6 * HOUR, 12 * HOUR]) {
        const holdLabel = maxHoldSeconds < HOUR ? `${maxHoldSeconds / 60}m` : `${maxHoldSeconds / HOUR}h`;
        grid.push({
          takeProfitPct,
          stopLossPct,
          maxHoldSeconds,
          label: `TP+${takeProfitPct * 100}%/SL-${stopLossPct * 100}%/${holdLabel}`
        });
      }
    }
  }
  return grid;
}

export interface ReplayOptions {
  candleDbPath: string;
  liveDbPath?: string;
  latencySeconds?: number;
  sizeUsd?: number;
  outPath?: string;
}

export function runReplay(options: ReplayOptions): ReplayOutput {
  const latencySeconds = options.latencySeconds ?? 60;
  const sizeUsd = options.sizeUsd ?? 1000;
  const store = new CandleStore(options.candleDbPath);
  const live = openLiveReadonly(options.liveDbPath);

  const solPrices = new SolPriceTable(store);
  console.log(`[replay] SOL/USD table: ${solPrices.size} daily points (fallback constant if 0)`);

  const trades = allBuyAndSellTrades(live);
  const range = tradesTimeRange(live);
  const splitTs = Math.floor((range.min + range.max) / 2);
  console.log(`[replay] ${trades.length} trades, split at ${new Date(splitTs * 1000).toISOString()}`);

  const hasCandlesCache = new Map<string, boolean>();
  const hasCandles = (mint: string): boolean => {
    let value = hasCandlesCache.get(mint);
    if (value === undefined) {
      value = store.hasCandles(mint);
      hasCandlesCache.set(mint, value);
    }
    return value;
  };

  const configs: ConfigResult[] = [];
  const detectionGrid = defaultDetectionGrid();
  const exitGrid = defaultExitGrid();
  let skippedNoCandle = 0;
  let simulated = 0;

  for (const detection of detectionGrid) {
    const events = detectConvergences(trades, detection, solPrices);
    const tradeable = events.filter((event) => hasCandles(event.tokenMint));
    skippedNoCandle += events.length - tradeable.length;

    for (const exit of exitGrid) {
      const sims: SimTrade[] = [];
      for (const event of tradeable) {
        const sim = simulateTrade(event, store, { latencySeconds, sizeUsd, exit });
        if (sim) sims.push(sim);
      }
      simulated += sims.length;
      const train = sims.filter((t) => t.detectedAt < splitTs);
      const valid = sims.filter((t) => t.detectedAt >= splitTs);
      configs.push({
        detection,
        exit,
        latencySeconds,
        sizeUsd,
        overall: computeMetrics(sims),
        train: computeMetrics(train),
        valid: computeMetrics(valid)
      });
    }
    console.log(
      `[replay] detection w=${detection.windowMinutes}m wallets≥${detection.minWallets} usd≥${detection.minTradeUsd} ${detection.pumpFilter}: ${events.length} events, ${tradeable.length} with candles`
    );
  }

  rankAndFlagOverfit(configs);

  const output: ReplayOutput = {
    generatedAt: Math.floor(Date.now() / 1000),
    splitTs,
    timeRange: range,
    eventsSimulatedNote: `${simulated} simulated fills across grid; ${skippedNoCandle} event-instances skipped for missing candles`,
    configs
  };

  const outPath = options.outPath ?? "backtest/replay-results.json";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[replay] wrote ${outPath} (${configs.length} configs)`);

  live.close();
  store.close();
  return output;
}

/** Rank by train total PnL; flag configs whose rank collapses in validation. */
export function rankAndFlagOverfit(configs: ConfigResult[]): void {
  const withTrades = configs.filter((c) => c.train.nTrades > 0);
  const byTrain = [...withTrades].sort((a, b) => b.train.totalPnlUsd - a.train.totalPnlUsd);
  const byValid = [...withTrades].sort((a, b) => b.valid.totalPnlUsd - a.valid.totalPnlUsd);
  byTrain.forEach((c, i) => (c.trainRank = i + 1));
  byValid.forEach((c, i) => (c.validRank = i + 1));
  const n = withTrades.length;
  for (const c of withTrades) {
    c.overfitFlag =
      c.trainRank !== undefined &&
      c.validRank !== undefined &&
      c.trainRank <= Math.ceil(n / 4) &&
      c.validRank > Math.ceil(n / 2);
  }
}
