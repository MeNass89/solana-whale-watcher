/**
 * `fetch` command — pulls GeckoTerminal candles for every token appearing in
 * convergences with outcome BACKFILL/PENDING and first_trade_at older than 8
 * days. Per token:
 *   - minute candles covering [first_trade_at − 1h, first_trade_at + 2h] for
 *     each qualifying convergence (overlapping windows merged),
 *   - hourly candles covering [min(first_trade_at), max(first_trade_at) + 8d].
 * Resumable via fetch_state (skip status=done). Progress logged every 25
 * tokens. Also seeds WSOL daily candles for the SOL/USD approximation table.
 */
import type Database from "better-sqlite3";
import { CandleStore, type Candle, type Timeframe } from "./candle-store.js";
import { fetchOhlcv, fetchTopPool, WSOL_MINT, type OhlcvBar } from "./gecko.js";
import { openLiveReadonly, tokensNeedingCandles, tradesTimeRange } from "./live-db.js";

const HOUR = 3600;
const DAY = 86400;
const EIGHT_DAYS = 8 * DAY;

interface Interval {
  start: number;
  end: number;
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else merged.push({ ...cur });
  }
  return merged;
}

function toCandles(bars: OhlcvBar[], tokenMint: string, poolAddress: string, timeframe: Timeframe): Candle[] {
  return bars.map((bar) => ({
    token_mint: tokenMint,
    pool_address: poolAddress,
    ts: bar.ts,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    timeframe
  }));
}

/** Page backwards with before_timestamp until interval start is covered. */
async function fetchRange(
  poolAddress: string,
  tokenMint: string,
  timeframe: Timeframe,
  startTs: number,
  endTs: number
): Promise<OhlcvBar[]> {
  const step = timeframe === "minute" ? 60 : timeframe === "hour" ? HOUR : DAY;
  const all: OhlcvBar[] = [];
  let before = endTs + step; // before_timestamp is exclusive-ish; pad one bucket
  for (let page = 0; page < 12; page++) {
    const needed = Math.ceil((before - startTs) / step) + 2;
    const bars = await fetchOhlcv(poolAddress, timeframe, before, needed, tokenMint);
    if (bars.length === 0) break;
    all.push(...bars);
    const oldest = bars[0].ts;
    if (oldest <= startTs || bars.length < Math.min(1000, needed)) break;
    before = oldest;
  }
  return all.filter((bar) => bar.ts >= startTs - step && bar.ts <= endTs + step);
}

export async function ensureSolDailyCandles(store: CandleStore, live: Database.Database): Promise<void> {
  const range = tradesTimeRange(live);
  const existing = store.candlesBetween(WSOL_MINT, "day", range.min - DAY, range.max + DAY);
  const daysNeeded = Math.ceil((range.max - range.min) / DAY) + 2;
  if (existing.length >= daysNeeded - 2) return;
  const pool = await fetchTopPool(WSOL_MINT);
  if (!pool) {
    console.warn("[fetch] no WSOL pool found — SOL/USD will use the constant fallback");
    return;
  }
  const bars = await fetchRange(pool.address, WSOL_MINT, "day", range.min - DAY, range.max + DAY);
  store.upsertCandles(toCandles(bars, WSOL_MINT, pool.address, "day"));
  console.log(`[fetch] WSOL daily candles: ${bars.length} bars stored`);
}

export async function runFetch(candleDbPath: string, liveDbPath?: string): Promise<void> {
  const store = new CandleStore(candleDbPath);
  const live = openLiveReadonly(liveDbPath);
  const nowTs = Math.floor(Date.now() / 1000);

  await ensureSolDailyCandles(store, live);

  const tokens = tokensNeedingCandles(live, nowTs);
  console.log(`[fetch] ${tokens.size} tokens to cover`);

  let index = 0;
  let done = 0;
  let skipped = 0;
  let noData = 0;
  let errors = 0;

  for (const [mint, detectionTimes] of tokens) {
    index++;
    const state = store.getFetchState(mint);
    if (state?.status === "done") {
      skipped++;
    } else {
      try {
        const pool = await fetchTopPool(mint);
        if (!pool) {
          store.setFetchState(mint, null, "no_data");
          noData++;
        } else {
          // minute windows: [ft − 1h, ft + 2h] per convergence, merged
          const minuteWindows = mergeIntervals(
            detectionTimes.map((ft) => ({ start: ft - HOUR, end: ft + 2 * HOUR }))
          );
          const allMinute: Candle[] = [];
          for (const win of minuteWindows) {
            const bars = await fetchRange(pool.address, mint, "minute", win.start, win.end);
            allMinute.push(...toCandles(bars, mint, pool.address, "minute"));
          }
          // hourly: [min(ft), max(ft) + 8d]
          const hourStart = Math.min(...detectionTimes);
          const hourEnd = Math.max(...detectionTimes) + EIGHT_DAYS;
          const hourBars = await fetchRange(pool.address, mint, "hour", hourStart, hourEnd);

          if (allMinute.length === 0 && hourBars.length === 0) {
            store.setFetchState(mint, pool.address, "no_data");
            noData++;
          } else {
            store.upsertCandles(allMinute);
            store.upsertCandles(toCandles(hourBars, mint, pool.address, "hour"));
            store.setFetchState(mint, pool.address, "done");
            done++;
          }
        }
      } catch (error) {
        store.setFetchState(mint, null, "error");
        errors++;
        console.error(`[fetch] ${mint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (index % 25 === 0 || index === tokens.size) {
      console.log(
        `[fetch] progress ${index}/${tokens.size} — done=${done} skipped=${skipped} no_data=${noData} errors=${errors}`
      );
    }
  }

  console.log(`[fetch] complete. status counts:`, store.countByStatus());
  live.close();
  store.close();
}
