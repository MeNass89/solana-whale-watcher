/**
 * Shortlist trial — the discovery shortlist must survive the same m=1
 * backtest that killed the original 144-wallet list before anything gets
 * wired to the tracker: harvest each shortlisted wallet's recent buys
 * on-chain, fetch candles for a deterministic sample of the tokens they
 * touched, then measure what FOLLOWING their entries (+60s latency,
 * slippage) would have returned.
 *
 * Signal caveat: "first buy" means first buy inside the harvest window —
 * a re-entry into an older position counts as a signal too, which matches
 * how live following would behave anyway.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { CandleStore, DEFAULT_CANDLE_DB } from "../backtest/candle-store.js";
import { HORIZONS } from "../backtest/horizon-study.js";
import { computeMetrics } from "../backtest/replay.js";
import { simulateTrade, type ExitRule, type SimTrade } from "../backtest/simulator.js";
import { median, winRate, winsorizedMean } from "../backtest/stats.js";
import { fetchParsedBatched, signaturesBackTo, toSwapView } from "./chain.js";

const HOUR = 3600;
const DAY = 86400;
const REPORT_PATH = "backtest/SHORTLIST-REPORT.md";
const ICLOUD_COPY = path.join(
  os.homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/temp/whale-shortlist-report.md"
);

/** Majors/stables are swap legs, not signals. */
const IGNORED_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" // USDT
]);

/** Per-wallet harvest budget: page up to this many signatures... */
const MAX_SIG_PAGES = 10;
/** ...and parse at most this many txs, stopping early at MAX_TOKENS. */
const MAX_PARSED_TXS = 5000;
const MAX_TOKENS_PER_WALLET = 220;
const PARSE_SLICE = 250;
/** Signals younger than this lack forward candle room for 12h horizons. */
const MIN_SIGNAL_AGE_SECONDS = DAY;
/** Global candle-fetch budget (GeckoTerminal ~24h at 2000 tokens). */
const MAX_FETCH_TOKENS = 2000;

export function ensureShortlistTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS m1_signals (
      wallet TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      buy_ts INTEGER NOT NULL,
      sol_spent REAL NOT NULL,
      PRIMARY KEY (wallet, token_mint)
    );
    CREATE TABLE IF NOT EXISTS harvest_state (
      wallet TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      n_txs INTEGER NOT NULL DEFAULT 0,
      n_tokens INTEGER NOT NULL DEFAULT 0,
      harvested_at INTEGER NOT NULL
    );
  `);
}

/** The 12: slow positives plus recurrent, clearly net-positive snipers. */
export function shortlistWallets(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT wallet FROM audits
         WHERE (verdict = 'positive' AND net_sol >= 5)
            OR (verdict = 'hyperactive' AND net_sol > 15 AND winners_hit >= 3)
         ORDER BY net_sol DESC`
      )
      .all() as Array<{ wallet: string }>
  ).map((r) => r.wallet);
}

export async function harvestSignals(db: Database.Database): Promise<void> {
  ensureShortlistTables(db);
  const nowTs = Math.floor(Date.now() / 1000);
  const wallets = shortlistWallets(db).filter(
    (w) => !db.prepare(`SELECT 1 FROM harvest_state WHERE wallet=? AND status='done'`).get(w)
  );
  console.log(`[shortlist] harvesting signals for ${wallets.length} wallets`);

  const insert = db.prepare(
    `INSERT INTO m1_signals (wallet, token_mint, buy_ts, sol_spent) VALUES (?, ?, ?, ?)
     ON CONFLICT(wallet, token_mint) DO UPDATE SET
       buy_ts = MIN(buy_ts, excluded.buy_ts),
       sol_spent = sol_spent + excluded.sol_spent`
  );
  const setState = db.prepare(
    `INSERT OR REPLACE INTO harvest_state (wallet, status, n_txs, n_tokens, harvested_at) VALUES (?, ?, ?, ?, ?)`
  );

  for (const wallet of wallets) {
    try {
      const { sigs } = await signaturesBackTo(wallet, nowTs - 30 * DAY, MAX_SIG_PAGES);
      const usable = sigs
        .filter((s) => s.blockTime != null && !s.err)
        .slice(0, MAX_PARSED_TXS)
        .map((s) => s.signature);

      const tokens = new Set<string>();
      let parsedCount = 0;
      for (let i = 0; i < usable.length && tokens.size < MAX_TOKENS_PER_WALLET; i += PARSE_SLICE) {
        const slice = usable.slice(i, i + PARSE_SLICE);
        const parsed = await fetchParsedBatched(slice);
        parsedCount += slice.length;
        for (const tx of parsed) {
          const view = toSwapView(tx);
          if (!view || view.feePayer !== wallet) continue;
          if (view.solDelta > -0.001) continue;
          for (const [mint, delta] of view.tokenDeltas) {
            if (delta <= 0 || IGNORED_MINTS.has(mint)) continue;
            insert.run(wallet, mint, view.blockTime, -view.solDelta);
            tokens.add(mint);
          }
        }
      }
      setState.run(wallet, "done", parsedCount, tokens.size, nowTs);
      console.log(`[shortlist] ${wallet.slice(0, 6)}… ${parsedCount} txs parsed → ${tokens.size} tokens`);
    } catch (error) {
      setState.run(wallet, "error", 0, 0, nowTs);
      console.error(`[shortlist] ${wallet.slice(0, 6)}… failed:`, error instanceof Error ? error.message : error);
    }
  }
}

export interface ShortlistSignal {
  wallet: string;
  tokenMint: string;
  ts: number;
  solSpent: number;
  isPump: boolean;
}

export function loadSignals(db: Database.Database, nowTs: number): ShortlistSignal[] {
  ensureShortlistTables(db);
  const rows = db
    .prepare(`SELECT wallet, token_mint, buy_ts, sol_spent FROM m1_signals WHERE buy_ts < ? ORDER BY buy_ts ASC`)
    .all(nowTs - MIN_SIGNAL_AGE_SECONDS) as Array<{
    wallet: string;
    token_mint: string;
    buy_ts: number;
    sol_spent: number;
  }>;
  return rows.map((r) => ({
    wallet: r.wallet,
    tokenMint: r.token_mint,
    ts: r.buy_ts,
    solSpent: r.sol_spent,
    isPump: r.token_mint.endsWith("pump")
  }));
}

/** Deterministic token sample for the candle fetch (mint-substring order —
 * same trick as the m=1 study; reproducible, uncorrelated with outcome). */
export function tokensToFetch(db: Database.Database, nowTs: number): Map<string, number[]> {
  const byToken = new Map<string, number[]>();
  for (const s of loadSignals(db, nowTs)) {
    const list = byToken.get(s.tokenMint) ?? [];
    list.push(s.ts);
    byToken.set(s.tokenMint, list);
  }
  const sampled = [...byToken.keys()]
    .sort((a, b) => a.slice(5, 17).localeCompare(b.slice(5, 17)))
    .slice(0, MAX_FETCH_TOKENS);
  return new Map(sampled.map((mint) => [mint, byToken.get(mint)!]));
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
  signals: ShortlistSignal[],
  retAt: (s: ShortlistSignal, horizonLabel: string) => number | null
): string[] {
  const lines = [`### ${label}`, "", `| horizon | n | med % | wm % | wr |`, `|---|---|---|---|---|`];
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

export function runShortlistReport(
  db: Database.Database,
  options: { candleDbPath?: string; latencySeconds?: number; sizeUsd?: number } = {}
): string {
  const latencySeconds = options.latencySeconds ?? 60;
  const sizeUsd = options.sizeUsd ?? 1000;
  const nowTs = Math.floor(Date.now() / 1000);
  const signals = loadSignals(db, nowTs);
  const store = new CandleStore(options.candleDbPath ?? DEFAULT_CANDLE_DB);

  const returns = new Map<string, Map<string, number>>();
  for (const s of signals) {
    const key = `${s.wallet}|${s.tokenMint}`;
    if (returns.has(key) || !store.hasCandles(s.tokenMint)) continue;
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
    if (byHorizon.size > 0) returns.set(key, byHorizon);
  }
  const usable = signals.filter((s) => returns.has(`${s.wallet}|${s.tokenMint}`));
  const retAt = (s: ShortlistSignal, horizon: string): number | null =>
    returns.get(`${s.wallet}|${s.tokenMint}`)?.get(horizon) ?? null;

  const lines: string[] = [];
  lines.push(`# Shortlist trial — following the discovered wallets' buys`);
  lines.push("");
  lines.push(
    `Signals: ${signals.length} (wallet × token first buys in harvest window); with candles+baseline: ` +
      `${usable.length}. Follow simulation: entry +${latencySeconds}s, $${sizeUsd}/trade, slippage both legs.`
  );
  lines.push("");
  lines.push(`## Horizon curves (candle returns, no execution costs)`);
  lines.push("");
  lines.push(...curveTable(`All shortlist signals (n=${usable.length})`, usable, retAt));

  lines.push(`## Per wallet`);
  lines.push("");
  const wallets = [...new Set(usable.map((s) => s.wallet))];
  const grid = exitGrid();
  const simSummary: string[] = [
    `| wallet | signals | best exit | n | med % | wr | PnL $ |`,
    `|---|---|---|---|---|---|---|`
  ];
  for (const wallet of wallets) {
    const own = usable.filter((s) => s.wallet === wallet);
    lines.push(...curveTable(`\`${wallet}\` (${own.length} signals)`, own, retAt));
    const events = own.map((s) => ({
      tokenMint: s.tokenMint,
      detectedAt: s.ts,
      walletCount: 1,
      totalUsd: 0,
      isPump: s.isPump
    }));
    let best: { exit: ExitRule; sims: SimTrade[]; pnl: number } | null = null;
    for (const exit of grid) {
      const sims = events
        .map((e) => simulateTrade(e, store, { latencySeconds, sizeUsd, exit }))
        .filter((t): t is SimTrade => t !== null);
      const pnl = sims.reduce((acc, t) => acc + t.pnlUsd, 0);
      if (!best || pnl > best.pnl) best = { exit, sims, pnl };
    }
    if (best && best.sims.length > 0) {
      const m = computeMetrics(best.sims);
      simSummary.push(
        `| \`${wallet.slice(0, 8)}…\` | ${own.length} | ${best.exit.label} | ${m.nTrades} | ` +
          `${fmt(m.medianReturnPct)} | ${pct(m.winRate)} | **${fmt(m.totalPnlUsd, 0)}** |`
      );
    }
  }

  lines.push(`## Simulated following, best exit per wallet`);
  lines.push("");
  lines.push(...simSummary);
  lines.push("");
  lines.push(
    `_Best-exit PnL is grid-optimistic (picked in hindsight): treat POSITIVE numbers as "worth paper-` +
      `tracking", not as expected returns. NEGATIVE numbers even here = do not follow._`
  );
  lines.push("");

  store.close();
  const text = lines.join("\n");
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, text);
  console.log(`[shortlist] wrote ${REPORT_PATH}`);
  try {
    fs.copyFileSync(REPORT_PATH, ICLOUD_COPY);
    console.log(`[shortlist] copied to ${ICLOUD_COPY}`);
  } catch (error) {
    console.warn(`[shortlist] iCloud copy failed: ${error instanceof Error ? error.message : error}`);
  }
  return text;
}
