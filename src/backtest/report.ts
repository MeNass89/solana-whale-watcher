/**
 * `report` command — renders backtest/REPORT.md:
 *  1. SIGNAL STUDY from resolved convergences in the live DB (read-only):
 *     forward returns bucketed by wallet_count × pump/non-pump × tier —
 *     validates/refutes the "2-wallet pump = +9%/24h, 3+ wallets = fade"
 *     early finding. Winsorized means included (memecoin skew).
 *  2. REPLAY results (if backtest/replay-results.json exists): per-config
 *     metrics, walk-forward train/valid comparison, overfit flags.
 * A copy is written to the iCloud temp dir for review.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLiveReadonly } from "./live-db.js";
import { buildHorizonStudy } from "./horizon-study.js";
import { mean, median, winRate, winsorizedMean } from "./stats.js";
import type { ConfigResult, ReplayOutput } from "./replay.js";

interface SignalRow {
  wallet_count: number;
  tier: string;
  is_pump: number;
  outcome: string | null;
  resolved_via: string | null;
  price_at_detection: number | null;
  price_1h: number | null;
  price_24h: number | null;
  price_7d: number | null;
}

interface Bucket {
  key: string;
  n: number;
  ret1h: number[];
  ret24h: number[];
  ret7d: number[];
  wins: number;
  losses: number;
  flats: number;
}

const REPORT_PATH = "backtest/REPORT.md";
const ICLOUD_COPY = path.join(
  os.homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/temp/whale-alpha-report.md"
);

function walletBucket(count: number): string {
  if (count <= 2) return "2";
  if (count === 3) return "3";
  if (count === 4) return "4";
  return "5+";
}

function fmt(x: number | undefined | null, digits = 2): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return x.toFixed(digits);
}

function pct(x: number | undefined | null): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return (x * 100).toFixed(1) + "%";
}

export function buildSignalStudy(liveDbPath?: string): string {
  const live = openLiveReadonly(liveDbPath);
  const rows = live
    .prepare(
      `SELECT wallet_count, tier,
              CASE WHEN token_mint LIKE '%pump' THEN 1 ELSE 0 END AS is_pump,
              outcome, resolved_via, price_at_detection, price_1h, price_24h, price_7d
       FROM convergences
       WHERE outcome IN ('WIN','LOSS','FLAT') AND price_at_detection > 0`
    )
    .all() as SignalRow[];
  live.close();

  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const key = `${walletBucket(row.wallet_count)}|${row.is_pump ? "pump" : "non-pump"}|${row.tier}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, n: 0, ret1h: [], ret24h: [], ret7d: [], wins: 0, losses: 0, flats: 0 };
      buckets.set(key, bucket);
    }
    bucket.n++;
    const base = row.price_at_detection!;
    if (row.price_1h !== null && row.price_1h > 0) bucket.ret1h.push(((row.price_1h - base) / base) * 100);
    if (row.price_24h !== null && row.price_24h > 0) bucket.ret24h.push(((row.price_24h - base) / base) * 100);
    if (row.price_7d !== null && row.price_7d > 0) bucket.ret7d.push(((row.price_7d - base) / base) * 100);
    if (row.outcome === "WIN") bucket.wins++;
    else if (row.outcome === "LOSS") bucket.losses++;
    else bucket.flats++;
  }

  const lines: string[] = [];
  lines.push(`## Signal study — forward returns by wallet_count × pump × tier`);
  lines.push("");
  lines.push(`Resolved convergences with a positive detection price: **${rows.length}**.`);
  lines.push(
    `Returns in %, relative to price_at_detection. "wmean" = winsorized mean (1%/99%). ` +
      `Win rate = share of returns > 0 at that horizon.`
  );
  lines.push("");
  lines.push(
    `| wallets | pump | tier | n | med 24h | mean 24h | wmean 24h | wr 24h | med 7d | mean 7d | wmean 7d | wr 7d | WIN/LOSS/FLAT |`
  );
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  const sorted = [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const b of sorted) {
    const [wallets, pump, tier] = b.key.split("|");
    lines.push(
      `| ${wallets} | ${pump} | ${tier} | ${b.n} | ${fmt(median(b.ret24h))} | ${fmt(mean(b.ret24h))} | ` +
        `${fmt(winsorizedMean(b.ret24h))} | ${pct(winRate(b.ret24h))} | ${fmt(median(b.ret7d))} | ` +
        `${fmt(mean(b.ret7d))} | ${fmt(winsorizedMean(b.ret7d))} | ${pct(winRate(b.ret7d))} | ` +
        `${b.wins}/${b.losses}/${b.flats} |`
    );
  }
  lines.push("");

  // Early-finding verdict: 2-wallet pump vs 3+ wallet convergences, 24h mean
  const twoPump = [...buckets.values()].filter((b) => b.key.startsWith("2|pump"));
  const threePlus = [...buckets.values()].filter((b) => !b.key.startsWith("2|"));
  const mean24 = (bs: Bucket[]) => mean(bs.flatMap((b) => b.ret24h));
  const wmean24 = (bs: Bucket[]) => winsorizedMean(bs.flatMap((b) => b.ret24h));
  lines.push(`### Early-finding check (2-wallet pump ≈ +9%/24h vs 3+ wallets ≈ −20…−66%)`);
  lines.push("");
  lines.push(
    `- 2-wallet pump: mean 24h = **${fmt(mean24(twoPump))}%** (wmean ${fmt(wmean24(twoPump))}%, n=${twoPump.reduce((s, b) => s + b.ret24h.length, 0)})`
  );
  lines.push(
    `- 3+ wallets (all): mean 24h = **${fmt(mean24(threePlus))}%** (wmean ${fmt(wmean24(threePlus))}%, n=${threePlus.reduce((s, b) => s + b.ret24h.length, 0)})`
  );
  lines.push(
    `- Interpretation: no shorting is possible on these pools, so a negative heavy-convergence signal is a **filter/avoid** rule, not a tradeable fade.`
  );
  lines.push("");
  return lines.join("\n");
}

function metricsRow(label: string, c: ConfigResult): string {
  const d = c.detection;
  const m = c.overall;
  return (
    `| ${label} | ${d.windowMinutes}m/${d.minWallets}w/$${d.minTradeUsd}/${d.pumpFilter} | ${c.exit.label} | ` +
    `${m.nTrades} | ${fmt(m.medianReturnPct)} | ${fmt(m.meanReturnPct)} | ${fmt(m.winsorizedMeanReturnPct)} | ` +
    `${pct(m.winRate)} | ${fmt(m.totalPnlUsd, 0)} | ${fmt(m.maxDrawdownUsd, 0)} | ${fmt(m.avgHoldHours, 1)} | ` +
    `${c.trainRank ?? "—"}→${c.validRank ?? "—"}${c.overfitFlag ? " ⚠️" : ""} |`
  );
}

export function buildReplaySection(replayResultsPath = "backtest/replay-results.json"): string {
  if (!fs.existsSync(replayResultsPath)) {
    return `## Replay backtest\n\n_Not yet run — execute \`npx tsx src/backtest/cli.ts replay\` once the candle fetch has finished, then re-run \`report\`._\n`;
  }
  const output = JSON.parse(fs.readFileSync(replayResultsPath, "utf8")) as ReplayOutput;
  const lines: string[] = [];
  lines.push(`## Replay backtest (parameterized detection, $${output.configs[0]?.sizeUsd ?? 1000}/trade)`);
  lines.push("");
  lines.push(
    `Time range ${new Date(output.timeRange.min * 1000).toISOString().slice(0, 10)} → ` +
      `${new Date(output.timeRange.max * 1000).toISOString().slice(0, 10)}, walk-forward split at ` +
      `${new Date(output.splitTs * 1000).toISOString().slice(0, 10)}. ${output.eventsSimulatedNote}.`
  );
  lines.push("");
  lines.push(
    `Ranks are train→validation by total PnL; ⚠️ = top-quartile on train collapsing below median in validation (overfit).`
  );
  lines.push("");
  lines.push(
    `| # | detection (win/minWallets/minUsd/pump) | exit | n | med % | mean % | wmean % | win rate | PnL $ | maxDD $ | hold h | rank |`
  );
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  const ranked = [...output.configs]
    .filter((c) => c.overall.nTrades > 0)
    .sort((a, b) => (a.validRank ?? 1e9) - (b.validRank ?? 1e9));
  const top = ranked.slice(0, 20);
  top.forEach((c, i) => lines.push(metricsRow(String(i + 1), c)));
  if (ranked.length > top.length) {
    lines.push("");
    lines.push(`_${ranked.length - top.length} more configs in backtest/replay-results.json._`);
  }
  lines.push("");
  return lines.join("\n");
}

export function runReport(options: { liveDbPath?: string } = {}): string {
  const parts: string[] = [];
  parts.push(`# Whale-convergence alpha report`);
  parts.push("");
  parts.push(`Generated ${new Date().toISOString()} by \`src/backtest\` harness (branch alpha-harness).`);
  parts.push(
    `Modeling assumptions (slippage, SOL/USD approximation, candle tolerances, no shorting) are documented in src/backtest/README.md.`
  );
  parts.push("");
  parts.push(buildSignalStudy(options.liveDbPath));
  parts.push(buildHorizonStudy(undefined, options.liveDbPath));
  parts.push(buildReplaySection());

  const report = parts.join("\n");
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);
  console.log(`[report] wrote ${REPORT_PATH}`);
  try {
    fs.mkdirSync(path.dirname(ICLOUD_COPY), { recursive: true });
    fs.copyFileSync(REPORT_PATH, ICLOUD_COPY);
    console.log(`[report] copied to ${ICLOUD_COPY}`);
  } catch (error) {
    console.warn(`[report] iCloud copy failed: ${error instanceof Error ? error.message : error}`);
  }
  return report;
}
