/**
 * Horizon curve — forward returns at fine-grained horizons (1m → 12h) computed
 * directly from candles, NOT from the coarse price_1h/24h/7d columns.
 *
 * Rationale: whale plays on memecoins resolve in minutes-to-hours; judging the
 * signal at a fixed 24h window measures the wrong thing. The curve shows WHERE
 * the edge peaks and WHEN it dies, per wallet-count × pump bucket.
 *
 * Minute candles only cover [detection−1h, detection+2h] (fetcher window), so
 * horizons ≤2h read minute candles and the rest read hourly ones.
 */
import { CandleStore, DEFAULT_CANDLE_DB, type Timeframe } from "./candle-store.js";
import { openLiveReadonly } from "./live-db.js";
import { median, winRate, winsorizedMean } from "./stats.js";

interface Horizon {
  label: string;
  seconds: number;
  timeframe: Timeframe;
  toleranceSeconds: number;
}

// Nothing beyond 12h: memecoin whale plays resolve in minutes, the long tail
// is pure decay (measured: win rate 0% at 12-24h). 1m is the data floor —
// GeckoTerminal's finest candle is 1 minute, so 30s horizons are unmeasurable,
// and our own entry latency (~60s) makes them untradeable anyway.
export const HORIZONS: Horizon[] = [
  { label: "1m", seconds: 60, timeframe: "minute", toleranceSeconds: 45 },
  { label: "2m", seconds: 120, timeframe: "minute", toleranceSeconds: 60 },
  { label: "5m", seconds: 300, timeframe: "minute", toleranceSeconds: 120 },
  { label: "10m", seconds: 600, timeframe: "minute", toleranceSeconds: 180 },
  { label: "15m", seconds: 900, timeframe: "minute", toleranceSeconds: 180 },
  { label: "30m", seconds: 1800, timeframe: "minute", toleranceSeconds: 300 },
  { label: "1h", seconds: 3600, timeframe: "minute", toleranceSeconds: 600 },
  { label: "2h", seconds: 7200, timeframe: "minute", toleranceSeconds: 600 },
  { label: "4h", seconds: 4 * 3600, timeframe: "hour", toleranceSeconds: 3600 },
  { label: "8h", seconds: 8 * 3600, timeframe: "hour", toleranceSeconds: 3600 },
  { label: "12h", seconds: 12 * 3600, timeframe: "hour", toleranceSeconds: 5400 }
];

interface CurveRow {
  token_mint: string;
  wallet_count: number;
  last_trade_at: number;
  is_pump: number;
}

function walletBucket(count: number): string {
  if (count <= 2) return "2";
  if (count === 3) return "3";
  if (count === 4) return "4";
  return "5+";
}

function fmt(x: number | undefined | null, digits = 1): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return x.toFixed(digits);
}

function pct(x: number | undefined | null): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return (x * 100).toFixed(0) + "%";
}

export function buildHorizonStudy(candleDbPath = DEFAULT_CANDLE_DB, liveDbPath?: string): string {
  const live = openLiveReadonly(liveDbPath);
  // t0 = last_trade_at: the convergence is only DETECTABLE when the Nth
  // wallet trades. Anchoring at first_trade_at (avg gap: >1h for 5+ wallets)
  // would credit the curve with the whales' own pump — uncapturable.
  const allRows = live
    .prepare(
      `SELECT token_mint, wallet_count, last_trade_at,
              CASE WHEN token_mint LIKE '%pump' THEN 1 ELSE 0 END AS is_pump
       FROM convergences
       ORDER BY last_trade_at ASC`
    )
    .all() as CurveRow[];
  live.close();

  // Dedupe: the live detector writes escalating rows as wallets pile in
  // (565 rows for only 24 unique 5+ pump tokens). Keep the FIRST trigger per
  // (token, wallet-bucket) — you trade the first signal, not every escalation.
  const seen = new Set<string>();
  const rows = allRows.filter((row) => {
    const key = `${row.token_mint}|${walletBucket(row.wallet_count)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const store = new CandleStore(candleDbPath);
  // bucketKey -> horizonLabel -> returns[]
  const buckets = new Map<string, Map<string, number[]>>();
  let sampled = 0;

  for (const row of rows) {
    if (!store.hasCandles(row.token_mint)) continue;
    // Baseline from candles at detection time — the stored price_at_detection
    // is unreliable for backlogged rows (stamped hours/days late, often
    // post-collapse, which fabricates phantom +1000% returns).
    const baseline =
      store.closestClose(row.token_mint, "minute", row.last_trade_at, 600)?.close ??
      store.closestClose(row.token_mint, "hour", row.last_trade_at, 1800)?.close;
    if (!baseline || baseline <= 0) continue;
    const key = `${walletBucket(row.wallet_count)}|${row.is_pump ? "pump" : "non-pump"}`;
    let byHorizon = buckets.get(key);
    if (!byHorizon) {
      byHorizon = new Map();
      buckets.set(key, byHorizon);
    }
    let contributed = false;
    for (const h of HORIZONS) {
      const candle = store.closestClose(
        row.token_mint,
        h.timeframe,
        row.last_trade_at + h.seconds,
        h.toleranceSeconds
      );
      if (!candle || candle.close <= 0) continue;
      const ret = ((candle.close - baseline) / baseline) * 100;
      let arr = byHorizon.get(h.label);
      if (!arr) {
        arr = [];
        byHorizon.set(h.label, arr);
      }
      arr.push(ret);
      contributed = true;
    }
    if (contributed) sampled++;
  }
  store.close();

  const lines: string[] = [];
  lines.push(`## Horizon curve — candle-based forward returns, 1m → 12h`);
  lines.push("");
  lines.push(
    `Anchor t0 = last_trade_at (the trigger trade — the earliest moment the signal is ` +
      `detectable); baseline = candle close at t0 (stored price_at_detection is NOT used). ` +
      `Deduped to the first trigger per token × wallet-bucket: **${rows.length}** unique signals ` +
      `from ${allRows.length} rows, **${sampled}** with candle coverage. ` +
      `med = median %, wm = winsorized mean % (1/99), wr = share > 0.`
  );
  lines.push("");

  const sortedKeys = [...buckets.keys()].sort();
  for (const key of sortedKeys) {
    const byHorizon = buckets.get(key)!;
    const [wallets, pump] = key.split("|");
    lines.push(`### ${wallets} wallets, ${pump}`);
    lines.push("");
    lines.push(`| horizon | n | med % | wm % | wr |`);
    lines.push(`|---|---|---|---|---|`);
    for (const h of HORIZONS) {
      const rets = byHorizon.get(h.label);
      if (!rets || rets.length === 0) continue;
      lines.push(
        `| ${h.label} | ${rets.length} | ${fmt(median(rets))} | ${fmt(winsorizedMean(rets))} | ${pct(winRate(rets))} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
