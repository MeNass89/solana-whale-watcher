/**
 * Horizon curve — forward returns at fine-grained horizons (5m → 7d) computed
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

export const HORIZONS: Horizon[] = [
  { label: "5m", seconds: 300, timeframe: "minute", toleranceSeconds: 120 },
  { label: "15m", seconds: 900, timeframe: "minute", toleranceSeconds: 180 },
  { label: "30m", seconds: 1800, timeframe: "minute", toleranceSeconds: 300 },
  { label: "1h", seconds: 3600, timeframe: "minute", toleranceSeconds: 600 },
  { label: "2h", seconds: 7200, timeframe: "minute", toleranceSeconds: 600 },
  { label: "4h", seconds: 4 * 3600, timeframe: "hour", toleranceSeconds: 3600 },
  { label: "8h", seconds: 8 * 3600, timeframe: "hour", toleranceSeconds: 3600 },
  { label: "12h", seconds: 12 * 3600, timeframe: "hour", toleranceSeconds: 5400 },
  { label: "24h", seconds: 24 * 3600, timeframe: "hour", toleranceSeconds: 7200 },
  { label: "48h", seconds: 48 * 3600, timeframe: "hour", toleranceSeconds: 7200 },
  { label: "7d", seconds: 7 * 24 * 3600, timeframe: "hour", toleranceSeconds: 21600 }
];

interface CurveRow {
  token_mint: string;
  wallet_count: number;
  first_trade_at: number;
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
  const rows = live
    .prepare(
      `SELECT token_mint, wallet_count, first_trade_at,
              CASE WHEN token_mint LIKE '%pump' THEN 1 ELSE 0 END AS is_pump
       FROM convergences`
    )
    .all() as CurveRow[];
  live.close();

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
      store.closestClose(row.token_mint, "minute", row.first_trade_at, 600)?.close ??
      store.closestClose(row.token_mint, "hour", row.first_trade_at, 1800)?.close;
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
        row.first_trade_at + h.seconds,
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
  lines.push(`## Horizon curve — candle-based forward returns, 5m → 7d`);
  lines.push("");
  lines.push(
    `Baseline = candle close at detection time (stored price_at_detection is NOT used — ` +
      `it was stamped late for backlogged rows). **${sampled}** of ${rows.length} convergences ` +
      `have candle coverage. med = median %, wm = winsorized mean % (1/99), wr = share > 0.`
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
