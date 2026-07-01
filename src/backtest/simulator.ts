/**
 * Trade simulator. Long-only (no shorting on memecoin DEX pools — a "fade"
 * signal can only be used as a filter, never traded directly).
 *
 * Entry:
 *  - entry ts = detection ts + latencySeconds (default 60);
 *  - entry price = close of the nearest candle AT OR BEFORE entry ts
 *    (minute preferred, ±10 min; hourly fallback, ±2 h). No candle → skip.
 *  - slippage_bps = min(300, K_SLIPPAGE × size_usd / (candle USD volume + 1)),
 *    K_SLIPPAGE = 10 000 → a trade sized at 1 % of the candle's volume pays
 *    100 bps. Applied on BOTH entry (pay up) and exit (receive less).
 *
 * Exits, evaluated candle-by-candle strictly AFTER the entry candle
 * (conservative — the entry candle itself is never used to exit):
 *  - stop-loss checked BEFORE take-profit within any candle (if a candle's
 *    low breaches SL and its high breaches TP, the SL fills);
 *  - SL fill price = min(candle.open, sl_price) — gaps through the stop fill
 *    at the worse price;
 *  - TP fill price = tp_price exactly;
 *  - time exit at the close of the last candle with ts ≤ entry ts + maxHold.
 * Minute candles are used while available, hourly afterwards (double-count is
 * impossible: we walk minute first, and only hand over to hourly candles that
 * start after the last minute candle processed).
 */
import type { CandleStore } from "./candle-store.js";
import type { DetectionEvent } from "./detector.js";

export const K_SLIPPAGE = 10_000;
export const MAX_SLIPPAGE_BPS = 300;

export function slippageBps(sizeUsd: number, candleVolumeUsd: number): number {
  return Math.min(MAX_SLIPPAGE_BPS, (K_SLIPPAGE * sizeUsd) / (candleVolumeUsd + 1));
}

export interface ExitRule {
  takeProfitPct: number; // e.g. 0.5 = +50 %
  stopLossPct: number; // e.g. 0.3 = −30 %
  maxHoldSeconds: number;
  label: string;
}

export interface SimParams {
  latencySeconds: number;
  sizeUsd: number;
  exit: ExitRule;
}

export interface SimTrade {
  tokenMint: string;
  detectedAt: number;
  entryTs: number;
  entryPrice: number; // slippage-adjusted
  exitTs: number;
  exitPrice: number; // slippage-adjusted
  exitReason: "TP" | "SL" | "TIME";
  returnPct: number; // net, after both slippage legs
  pnlUsd: number;
  holdSeconds: number;
}

const MINUTE_TOL = 10 * 60;
const HOUR_TOL = 2 * 3600;

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  span: number;
}

export function simulateTrade(
  event: DetectionEvent,
  store: CandleStore,
  params: SimParams
): SimTrade | null {
  const entryTs = event.detectedAt + params.latencySeconds;

  const minuteEntry = store.closeAtOrBefore(event.tokenMint, "minute", entryTs, MINUTE_TOL);
  const hourEntry = minuteEntry
    ? undefined
    : store.closeAtOrBefore(event.tokenMint, "hour", entryTs, HOUR_TOL);
  const entryCandle = minuteEntry ?? hourEntry;
  if (!entryCandle || entryCandle.close <= 0) return null;

  const entrySlip = slippageBps(params.sizeUsd, entryCandle.volume) / 10_000;
  const entryPrice = entryCandle.close * (1 + entrySlip);

  const horizon = entryTs + params.exit.maxHoldSeconds;
  const minuteBars: Bar[] = store
    .candlesBetween(event.tokenMint, "minute", entryCandle.ts + 1, horizon)
    .map((c) => ({ ...c, span: 60 }));
  const lastMinuteTs = minuteBars.length > 0 ? minuteBars[minuteBars.length - 1].ts : entryCandle.ts;
  const hourBars: Bar[] = store
    .candlesBetween(event.tokenMint, "hour", lastMinuteTs + 1, horizon)
    .map((c) => ({ ...c, span: 3600 }));
  const bars = [...minuteBars, ...hourBars];
  if (bars.length === 0) return null; // no post-entry data → cannot price an exit

  const tpPrice = entryPrice * (1 + params.exit.takeProfitPct);
  const slPrice = entryPrice * (1 - params.exit.stopLossPct);

  let exitTs = bars[bars.length - 1].ts;
  let rawExit = bars[bars.length - 1].close;
  let exitReason: SimTrade["exitReason"] = "TIME";
  let exitVolume = bars[bars.length - 1].volume;

  for (const bar of bars) {
    if (bar.low <= slPrice) {
      // SL before TP within the candle, gap-through fills at the worse price
      exitTs = bar.ts;
      rawExit = Math.min(bar.open, slPrice);
      exitReason = "SL";
      exitVolume = bar.volume;
      break;
    }
    if (bar.high >= tpPrice) {
      exitTs = bar.ts;
      rawExit = tpPrice;
      exitReason = "TP";
      exitVolume = bar.volume;
      break;
    }
  }

  const exitSlip = slippageBps(params.sizeUsd, exitVolume) / 10_000;
  const exitPrice = rawExit * (1 - exitSlip);
  const returnPct = exitPrice / entryPrice - 1;

  return {
    tokenMint: event.tokenMint,
    detectedAt: event.detectedAt,
    entryTs,
    entryPrice,
    exitTs,
    exitPrice,
    exitReason,
    returnPct,
    pnlUsd: params.sizeUsd * returnPct,
    holdSeconds: Math.max(0, exitTs - entryTs)
  };
}
