/**
 * `resolve` command — historical resolution of convergences with
 * outcome='BACKFILL' (plus PENDING rows older than 8 days) using stored
 * candles.
 *
 * Rules (documented in README):
 *  - anchor t0 = last_trade_at: the convergence is only DETECTABLE when the
 *    Nth wallet trades (avg first→last gap 58 min); anchoring at
 *    first_trade_at is lookahead — returns nobody could have captured;
 *  - baseline = minute-candle close nearest t0 (±10 min), hourly
 *    fallback (±30 min); the stored price_at_detection is IGNORED — for
 *    backlogged rows it was stamped hours/days after detection;
 *  - price_1h  = minute close nearest t0+1h  (±10 min);
 *  - price_24h = hourly close nearest t0+24h (±2 h);
 *  - price_7d  = hourly close nearest t0+7d  (±6 h);
 *  - outcome: WIN if 7d return ≥ +10 %, LOSS if ≤ −20 %, else FLAT;
 *  - token with no candle data at all, or no resolvable baseline/7d price →
 *    DEAD (no liquid market = untradeable).
 *
 * The UPDATEs here (plus the resolved_via migration) are the ONLY live-DB
 * writes in the harness. Batches of 200, one short transaction per batch.
 */
import { CandleStore } from "./candle-store.js";
import {
  applyResolutionBatch,
  ensureResolvedViaColumn,
  openLiveWritable,
  resolvableConvergences,
  type ConvergenceRow,
  type ResolutionUpdate
} from "./live-db.js";

const HOUR = 3600;
const DAY = 86400;

export const TOLERANCE_1H = 10 * 60; // ±10 min, minute candles
export const TOLERANCE_24H = 2 * HOUR; // ±2 h, hourly candles
export const TOLERANCE_7D = 6 * HOUR; // ±6 h, hourly candles

export const WIN_THRESHOLD = 0.10; // 7d return ≥ +10 %
export const LOSS_THRESHOLD = -0.20; // 7d return ≤ −20 %

const EPS = 1e-9; // float-safe threshold comparison

export function classifyOutcome(baseline: number, price7d: number): "WIN" | "LOSS" | "FLAT" {
  const ret = (price7d - baseline) / baseline;
  if (ret >= WIN_THRESHOLD - EPS) return "WIN";
  if (ret <= LOSS_THRESHOLD + EPS) return "LOSS";
  return "FLAT";
}

export interface CandleLookup {
  hasCandles(tokenMint: string): boolean;
  closestClose(
    tokenMint: string,
    timeframe: "minute" | "hour" | "day",
    targetTs: number,
    toleranceSeconds: number
  ): { ts: number; close: number } | undefined;
}

/** Pure resolution of one convergence row against the candle store. */
export function resolveRow(row: ConvergenceRow, candles: CandleLookup): ResolutionUpdate {
  const noUpdate = (outcome: string): ResolutionUpdate => ({
    id: row.id,
    price_at_detection: null,
    price_1h: null,
    price_24h: null,
    price_7d: null,
    outcome
  });

  if (!candles.hasCandles(row.token_mint)) return noUpdate("DEAD");

  // t0 = last_trade_at: the signal is only knowable once the Nth wallet has
  // traded. first_trade_at is lookahead (avg gap 58 min — quant audit
  // 2026-08-05 confirmed this leak inflates measured returns structurally).
  const ft = row.last_trade_at ?? row.first_trade_at;
  // Baseline MUST come from candles at detection time, never from the stored
  // price_at_detection: for backlogged rows that value was stamped whenever
  // the price tracker first processed the row — hours or days after detection,
  // often post-collapse. Dividing a true candle close by a stale baseline
  // fabricates phantom ±1000% returns (observed on the first smoke report).
  const baseline =
    candles.closestClose(row.token_mint, "minute", ft, TOLERANCE_1H)?.close ??
    candles.closestClose(row.token_mint, "hour", ft, 30 * 60)?.close ??
    null;

  const price1h = candles.closestClose(row.token_mint, "minute", ft + HOUR, TOLERANCE_1H)?.close ?? null;
  const price24h = candles.closestClose(row.token_mint, "hour", ft + DAY, TOLERANCE_24H)?.close ?? null;
  const price7d = candles.closestClose(row.token_mint, "hour", ft + 7 * DAY, TOLERANCE_7D)?.close ?? null;

  if (baseline === null || baseline <= 0 || price7d === null) {
    return {
      id: row.id,
      price_at_detection: baseline,
      price_1h: price1h,
      price_24h: price24h,
      price_7d: price7d,
      outcome: "DEAD"
    };
  }

  return {
    id: row.id,
    price_at_detection: baseline,
    price_1h: price1h,
    price_24h: price24h,
    price_7d: price7d,
    outcome: classifyOutcome(baseline, price7d)
  };
}

export interface ResolveOptions {
  candleDbPath: string;
  liveDbPath?: string;
  limit?: number; // smoke runs
  batchSize?: number;
  dryRun?: boolean;
}

export function runResolve(options: ResolveOptions): {
  processed: number;
  byOutcome: Record<string, number>;
} {
  const store = new CandleStore(options.candleDbPath);
  const live = openLiveWritable(options.liveDbPath);
  const batchSize = options.batchSize ?? 200;

  if (!options.dryRun) ensureResolvedViaColumn(live);

  const rows = resolvableConvergences(live, Math.floor(Date.now() / 1000));
  console.log(`[resolve] ${rows.length} convergences to resolve${options.dryRun ? " (dry run)" : ""}`);

  // Only tokens the fetcher has settled: 'done' resolves against candles,
  // 'no_data' means GeckoTerminal has never seen the token → DEAD. Tokens
  // still unfetched or in 'error' are skipped (retried on a later pass).
  // --limit bounds the rows actually resolved (smoke runs).
  let settled = rows.filter((row) => {
    const state = store.getFetchState(row.token_mint);
    return state?.status === "done" || state?.status === "no_data";
  });
  if (options.limit !== undefined) settled = settled.slice(0, Math.floor(options.limit));
  console.log(`[resolve] ${settled.length}/${rows.length} rows have settled candle fetch state`);

  const byOutcome: Record<string, number> = {};
  let processed = 0;
  for (let offset = 0; offset < settled.length; offset += batchSize) {
    const batch = settled.slice(offset, offset + batchSize);
    const updates = batch.map((row) => resolveRow(row, store));
    for (const update of updates) byOutcome[update.outcome] = (byOutcome[update.outcome] ?? 0) + 1;
    if (!options.dryRun) applyResolutionBatch(live, updates);
    processed += updates.length;
    if (processed % 1000 === 0 || processed === settled.length) {
      console.log(`[resolve] ${processed}/${settled.length}`, byOutcome);
    }
  }

  console.log(`[resolve] done.`, byOutcome);
  live.close();
  store.close();
  return { processed, byOutcome };
}
