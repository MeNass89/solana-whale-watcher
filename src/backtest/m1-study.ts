/**
 * m=1 study — "enter on the FIRST whale buy of a token", the pivot the
 * convergence verdict pointed at: convergence detection fires after the pump
 * (avg >1h behind the first trade), so followers are exit liquidity. Here the
 * signal is the first tracked-wallet BUY per token — detectable in seconds
 * via webhook, no waiting for an Nth wallet.
 *
 * Honesty constraints:
 *  - Universe = deterministic uniform sample of ALL first-buy tokens (not
 *    just tokens that later converged — that would be lookahead). The SAME
 *    sample function drives the candle fetch and the study.
 *  - Wallet quality is selected walk-forward: wallets are ranked on the
 *    train half only, their signals evaluated on the valid half. Today's
 *    wallet scores are never applied to yesterday's trades.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { CandleStore, DEFAULT_CANDLE_DB } from "./candle-store.js";
import { isPumpMint, type DetectionEvent } from "./detector.js";
import { HORIZONS } from "./horizon-study.js";
import { openLiveReadonly } from "./live-db.js";
import { computeMetrics } from "./replay.js";
import { simulateTrade, type ExitRule, type SimTrade } from "./simulator.js";
import { median, winRate, winsorizedMean } from "./stats.js";

const HOUR = 3600;
const DAY = 86400;

export const M1_DEFAULT_SAMPLE = 2000;
const M1_REPORT_PATH = "backtest/M1-REPORT.md";
const M1_ICLOUD_COPY = path.join(
  os.homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/temp/whale-m1-report.md"
);

export interface M1Signal {
  tokenMint: string;
  wallet: string;
  ts: number; // block_time of the first tracked-wallet BUY
  usd: number | null;
  isPump: boolean;
}

/** First tracked-wallet BUY per token, oldest first. Signals younger than
 * one day are excluded (the 12h horizon needs settled forward candles). */
export function loadM1Signals(live: Database.Database, nowTs: number): M1Signal[] {
  const rows = live
    .prepare(
      `SELECT token_mint, wallet_address, block_time, amount_usd
       FROM trades t
       WHERE trade_type = 'BUY'
         AND block_time < ?
         AND block_time = (
           SELECT MIN(block_time) FROM trades
           WHERE token_mint = t.token_mint AND trade_type = 'BUY'
         )
       GROUP BY token_mint
       ORDER BY block_time ASC`
    )
    .all(nowTs - DAY) as Array<{
    token_mint: string;
    wallet_address: string;
    block_time: number;
    amount_usd: number | null;
  }>;
  return rows.map((r) => ({
    tokenMint: r.token_mint,
    wallet: r.wallet_address,
    ts: r.block_time,
    usd: r.amount_usd,
    isPump: isPumpMint(r.token_mint)
  }));
}

/**
 * Deterministic uniform sample without RNG: sort by a mid-substring of the
 * mint (base58 hash material — uncorrelated with time, wallet, or outcome)
 * and take the first n. Reproducible across fetch and study runs.
 */
export function deterministicSample(signals: M1Signal[], n: number): M1Signal[] {
  return [...signals]
    .sort((a, b) => a.tokenMint.slice(5, 17).localeCompare(b.tokenMint.slice(5, 17)))
    .slice(0, n)
    .sort((a, b) => a.ts - b.ts);
}

/** Token map for the fetcher: mint → [signal ts], from the SAME sample. */
export function m1TokensToFetch(liveDbPath: string | undefined, sampleSize: number): Map<string, number[]> {
  const live = openLiveReadonly(liveDbPath);
  const signals = deterministicSample(loadM1Signals(live, Math.floor(Date.now() / 1000)), sampleSize);
  live.close();
  const map = new Map<string, number[]>();
  for (const s of signals) map.set(s.tokenMint, [s.ts]);
  return map;
}

export interface WalletTrainStats {
  wallet: string;
  n: number;
  median15m: number;
}

/** Rank wallets on train-half signals by median 15m candle return.
 * Elite = top quartile of wallets with >= minSignals train signals. */
export function rankWalletsOnTrain(
  signals: M1Signal[],
  ret15m: (s: M1Signal) => number | null,
  splitTs: number,
  minSignals = 5
): { elite: Set<string>; table: WalletTrainStats[] } {
  const byWallet = new Map<string, number[]>();
  for (const s of signals) {
    if (s.ts >= splitTs) continue;
    const r = ret15m(s);
    if (r === null) continue;
    const list = byWallet.get(s.wallet) ?? [];
    list.push(r);
    byWallet.set(s.wallet, list);
  }
  const table: WalletTrainStats[] = [...byWallet.entries()]
    .filter(([, rets]) => rets.length >= minSignals)
    .map(([wallet, rets]) => ({ wallet, n: rets.length, median15m: median(rets) }))
    .sort((a, b) => b.median15m - a.median15m);
  const eliteCount = Math.max(1, Math.floor(table.length / 4));
  const elite = new Set(table.slice(0, eliteCount).map((w) => w.wallet));
  return { elite, table };
}

function fmt(x: number | undefined | null, digits = 1): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return x.toFixed(digits);
}

function pct(x: number | undefined | null): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return (x * 100).toFixed(0) + "%";
}

function curveTable(
  label: string,
  signals: M1Signal[],
  retAt: (s: M1Signal, horizonLabel: string) => number | null
): string[] {
  const lines: string[] = [];
  lines.push(`### ${label}`);
  lines.push("");
  lines.push(`| horizon | n | med % | wm % | wr |`);
  lines.push(`|---|---|---|---|---|`);
  for (const h of HORIZONS) {
    const rets = signals.map((s) => retAt(s, h.label)).filter((r): r is number => r !== null);
    if (rets.length === 0) continue;
    lines.push(
      `| ${h.label} | ${rets.length} | ${fmt(median(rets))} | ${fmt(winsorizedMean(rets))} | ${pct(winRate(rets))} |`
    );
  }
  lines.push("");
  return lines;
}

function exitGrid(): ExitRule[] {
  const grid: ExitRule[] = [];
  for (const takeProfitPct of [0.2, 0.5, 1.0]) {
    for (const stopLossPct of [0.15, 0.3]) {
      for (const maxHoldSeconds of [300, 900, 1800, 1 * HOUR, 2 * HOUR]) {
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

export function runM1Report(options: {
  candleDbPath?: string;
  liveDbPath?: string;
  sampleSize?: number;
  latencySeconds?: number;
  sizeUsd?: number;
} = {}): string {
  const sampleSize = options.sampleSize ?? M1_DEFAULT_SAMPLE;
  const latencySeconds = options.latencySeconds ?? 60;
  const sizeUsd = options.sizeUsd ?? 1000;
  const nowTs = Math.floor(Date.now() / 1000);

  const live = openLiveReadonly(options.liveDbPath);
  const universe = loadM1Signals(live, nowTs);
  live.close();
  const sampled = deterministicSample(universe, sampleSize);

  const store = new CandleStore(options.candleDbPath ?? DEFAULT_CANDLE_DB);
  const covered = sampled.filter((s) => store.hasCandles(s.tokenMint));

  // Precompute per-signal returns at every horizon (baseline = candle at ts).
  const returns = new Map<string, Map<string, number>>(); // tokenMint -> horizon -> ret%
  for (const s of covered) {
    const baseline =
      store.closestClose(s.tokenMint, "minute", s.ts, 600)?.close ??
      store.closestClose(s.tokenMint, "hour", s.ts, 1800)?.close;
    if (!baseline || baseline <= 0) continue;
    const byHorizon = new Map<string, number>();
    for (const h of HORIZONS) {
      const candle = store.closestClose(s.tokenMint, h.timeframe, s.ts + h.seconds, h.toleranceSeconds);
      if (!candle || candle.close <= 0) continue;
      byHorizon.set(h.label, ((candle.close - baseline) / baseline) * 100);
    }
    if (byHorizon.size > 0) returns.set(s.tokenMint, byHorizon);
  }
  const usable = covered.filter((s) => returns.has(s.tokenMint));
  const retAt = (s: M1Signal, horizon: string): number | null =>
    returns.get(s.tokenMint)?.get(horizon) ?? null;

  const times = usable.map((s) => s.ts);
  const splitTs = times.length > 0 ? Math.floor((times[0] + times[times.length - 1]) / 2) : nowTs;
  const train = usable.filter((s) => s.ts < splitTs);
  const valid = usable.filter((s) => s.ts >= splitTs);

  // Walk-forward wallet selection on 15m returns.
  const { elite, table } = rankWalletsOnTrain(usable, (s) => retAt(s, "15m"), splitTs);
  const validElite = valid.filter((s) => elite.has(s.wallet));
  const validRest = valid.filter((s) => !elite.has(s.wallet));

  const lines: string[] = [];
  lines.push(`# m=1 study — first whale buy per token`);
  lines.push("");
  lines.push(
    `Signal = first tracked-wallet BUY per token, anchored at the buy's block_time ` +
      `(detectable in seconds via webhook). Universe: ${universe.length} tokens; deterministic ` +
      `sample: ${sampled.length}; with candles: ${covered.length}; with baseline+returns: ${usable.length}. ` +
      `Walk-forward split at ${new Date(splitTs * 1000).toISOString().slice(0, 10)} ` +
      `(train ${train.length} / valid ${valid.length}).`
  );
  lines.push("");

  lines.push(`## Horizon curves (candle returns, no execution costs)`);
  lines.push("");
  lines.push(...curveTable(`All signals (n=${usable.length})`, usable, retAt));
  lines.push(...curveTable(`Pump tokens`, usable.filter((s) => s.isPump), retAt));
  lines.push(...curveTable(`Non-pump tokens`, usable.filter((s) => !s.isPump), retAt));
  lines.push(...curveTable(`Buy size ≥ $500`, usable.filter((s) => (s.usd ?? 0) >= 500), retAt));

  lines.push(`## Walk-forward wallet selection`);
  lines.push("");
  lines.push(
    `Wallets ranked on TRAIN half only (median 15m return, ≥5 signals): ${table.length} rankable, ` +
      `top quartile = ${elite.size} elite wallets. Their VALID-half signals vs the rest:`
  );
  lines.push("");
  lines.push(...curveTable(`Elite wallets, valid half (n=${validElite.length})`, validElite, retAt));
  lines.push(...curveTable(`Non-elite wallets, valid half (n=${validRest.length})`, validRest, retAt));

  lines.push(`## Simulated trades ($${sizeUsd}/trade, entry +${latencySeconds}s, slippage both legs)`);
  lines.push("");
  lines.push(`| cohort | exit | n | med % | wm % | wr | PnL $ |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  const cohorts: Array<[string, M1Signal[]]> = [
    ["all/train", train],
    ["all/valid", valid],
    ["elite/valid", validElite]
  ];
  for (const [name, cohortSignals] of cohorts) {
    const events: DetectionEvent[] = cohortSignals.map((s) => ({
      tokenMint: s.tokenMint,
      detectedAt: s.ts,
      walletCount: 1,
      totalUsd: s.usd ?? 0,
      isPump: s.isPump
    }));
    const results: Array<{ exit: ExitRule; sims: SimTrade[] }> = exitGrid().map((exit) => ({
      exit,
      sims: events
        .map((e) => simulateTrade(e, store, { latencySeconds, sizeUsd, exit }))
        .filter((t): t is SimTrade => t !== null)
    }));
    const top = results.sort((a, b) => sum(b.sims) - sum(a.sims)).slice(0, 3);
    for (const { exit, sims } of top) {
      const m = computeMetrics(sims);
      lines.push(
        `| ${name} | ${exit.label} | ${m.nTrades} | ${fmt(m.medianReturnPct)} | ` +
          `${fmt(m.winsorizedMeanReturnPct)} | ${pct(m.winRate)} | ${fmt(m.totalPnlUsd, 0)} |`
      );
    }
  }
  lines.push("");
  lines.push(
    `_Top-3 exits per cohort by total PnL. Anything positive on all/train must reappear on ` +
      `all/valid (and ideally sharpen on elite/valid) to count as signal rather than fit._`
  );
  lines.push("");

  store.close();
  const report = lines.join("\n");
  fs.mkdirSync(path.dirname(M1_REPORT_PATH), { recursive: true });
  fs.writeFileSync(M1_REPORT_PATH, report);
  console.log(`[m1-report] wrote ${M1_REPORT_PATH}`);
  try {
    fs.copyFileSync(M1_REPORT_PATH, M1_ICLOUD_COPY);
    console.log(`[m1-report] copied to ${M1_ICLOUD_COPY}`);
  } catch (error) {
    console.warn(`[m1-report] iCloud copy failed: ${error instanceof Error ? error.message : error}`);
  }
  return report;
}

function sum(sims: SimTrade[]): number {
  return sims.reduce((acc, t) => acc + t.pnlUsd, 0);
}
