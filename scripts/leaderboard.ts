import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import DatabaseConstructor from "better-sqlite3";
import { config } from "../src/config/index.js";
import { matchFifo, type RawTrade } from "../src/engine/fifo-matcher.js";

const DB_PATH = path.resolve(process.cwd(), config.databasePath);
const OUTPUT_PATH = path.resolve(process.cwd(), "data/leaderboard.json");
const WINDOW_DAYS = 30;
const WINDOW_SEC = WINDOW_DAYS * 86400;
const CONFIRMED_LOSER_ADDRESSES = new Set([
  "Hq3GSgr27vEQ8WNCAvsrCT5Kap1CcX6kpbDJYPgvcy9D",
  "9jyqFiLnruggwNn4EQwBNFXwpbLM9hrA4hV59ytyAVVz"
]);

export interface WalletMetrics {
  wallet: string;
  class: "alpha" | "loser" | "accumulation_bot" | "incomplete";
  realized_usd: number;
  realized_sol: number;
  win_rate: number | null;
  wins: number;
  avg_hold_time_s: number | null;
  locked_sol: number;
  n_trades: number;
  n_buys: number;
  n_sells: number;
  n_closed: number;
  n_open: number;
  n_partial: number;
}

export interface WalletMetricsResult {
  metrics: WalletMetrics[];
  unmatched_sells: number;
}

function truncWallet(wallet: string): string {
  return `${wallet.slice(0, 10)}...${wallet.slice(-4)}`;
}

function fmtUsd(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function fmtSol(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4, minimumFractionDigits: 4 });
}

function fmtWinRate(value: number | null): string {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function printRanked(title: string, rows: WalletMetrics[]): void {
  console.log(`\n=== ${title} ===`);
  console.log("rank | wallet | realized_usd | realized_sol | win% | n_closed | locked_sol | n_trades");
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  rows.forEach((row, index) => {
    console.log(
      `${index + 1} | ${truncWallet(row.wallet)} | ${fmtUsd(row.realized_usd)} | ${fmtSol(row.realized_sol)} | ${fmtWinRate(
        row.win_rate
      )} | ${row.n_closed} | ${fmtSol(row.locked_sol)} | ${row.n_trades}`
    );
  });
}

function printBots(rows: WalletMetrics[]): void {
  console.log("\n=== ACCUMULATION BOTS (excluded from rank) ===");
  console.log("wallet | n_trades | n_buys | n_sells | locked_sol");
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  for (const row of rows) {
    console.log(`${truncWallet(row.wallet)} | ${row.n_trades} | ${row.n_buys} | ${row.n_sells} | ${fmtSol(row.locked_sol)}`);
  }
}

export function buildWalletMetrics(activeWallets: string[], trades: RawTrade[]): WalletMetricsResult {
  const metrics = new Map<string, WalletMetrics>();
  for (const address of activeWallets) {
    metrics.set(address, {
      wallet: address,
      class: "incomplete",
      realized_usd: 0,
      realized_sol: 0,
      win_rate: null,
      wins: 0,
      avg_hold_time_s: null,
      locked_sol: 0,
      n_trades: 0,
      n_buys: 0,
      n_sells: 0,
      n_closed: 0,
      n_open: 0,
      n_partial: 0
    });
  }

  for (const trade of trades) {
    const wallet = metrics.get(trade.wallet);
    if (!wallet) continue;
    wallet.n_trades += 1;
    if (trade.type === "BUY") wallet.n_buys += 1;
    else wallet.n_sells += 1;
  }

  const matched = matchFifo(trades);
  const holdTimesByWallet = new Map<string, number[]>();
  const partialKeys = new Set<string>();
  for (const cycle of matched.cycles) {
    const wallet = metrics.get(cycle.wallet);
    if (!wallet) continue;

    partialKeys.add(`${cycle.wallet}\0${cycle.mint}`);
    wallet.n_closed += 1;
    wallet.realized_sol += cycle.pnl_sol;
    wallet.realized_usd += cycle.pnl_usd;
    if (cycle.pnl_sol > 0) wallet.wins += 1;

    const holdTimes = holdTimesByWallet.get(cycle.wallet) ?? [];
    holdTimes.push(cycle.hold_time_s);
    holdTimesByWallet.set(cycle.wallet, holdTimes);
  }

  for (const position of matched.open) {
    const wallet = metrics.get(position.wallet);
    if (!wallet) continue;
    wallet.n_open += 1;
    wallet.locked_sol += position.locked_sol;
    if (partialKeys.has(`${position.wallet}\0${position.mint}`)) {
      wallet.n_partial += 1;
    }
  }

  for (const wallet of metrics.values()) {
    wallet.win_rate = wallet.n_closed > 0 ? wallet.wins / wallet.n_closed : null;
    const holdTimes = holdTimesByWallet.get(wallet.wallet) ?? [];
    wallet.avg_hold_time_s =
      holdTimes.length > 0 ? holdTimes.reduce((sum, holdTime) => sum + holdTime, 0) / holdTimes.length : null;

    const sellBuyRatio = wallet.n_sells / Math.max(wallet.n_buys, 1);
    if (wallet.n_closed === 0 && wallet.n_trades >= 50 && sellBuyRatio < 0.05) {
      wallet.class = "accumulation_bot";
    } else if (wallet.n_closed === 0) {
      wallet.class = "incomplete";
    } else if (wallet.realized_sol < 0) {
      wallet.class = "loser";
    } else {
      wallet.class = "alpha";
    }
  }

  return { metrics: [...metrics.values()], unmatched_sells: matched.unmatched_sells };
}

function main(): void {
  const applyPrune = process.argv.includes("--apply-prune");
  const generatedAt = Math.floor(Date.now() / 1000);
  const cutoff = generatedAt - WINDOW_SEC;

  const db = new DatabaseConstructor(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const activeWallets = db.prepare("SELECT address FROM wallets WHERE active = 1 ORDER BY address").all() as Array<{ address: string }>;
  const trades = db
    .prepare(
      `SELECT wallet_address AS wallet,
              token_mint AS mint,
              trade_type AS type,
              block_time,
              COALESCE(amount_token, 0) AS amount_token,
              COALESCE(amount_sol, 0) AS amount_sol,
              COALESCE(amount_usd, 0) AS amount_usd
       FROM trades
       WHERE (block_time > ? OR (block_time <= ? AND trade_type = 'BUY'))
         AND wallet_address IN (SELECT address FROM wallets WHERE active = 1)
       ORDER BY wallet_address, token_mint, block_time, id`
    )
    .all(cutoff, cutoff) as RawTrade[];

  const { metrics, unmatched_sells } = buildWalletMetrics(
    activeWallets.map((row) => row.address),
    trades
  );
  console.log(`FIFO unmatched sells skipped: ${unmatched_sells}`);

  const all = metrics;
  const alpha = all.filter((row) => row.class === "alpha").sort((a, b) => b.realized_sol - a.realized_sol);
  const losers = all.filter((row) => row.class === "loser").sort((a, b) => a.realized_sol - b.realized_sol);
  const accumulationBots = all
    .filter((row) => row.class === "accumulation_bot")
    .sort((a, b) => b.locked_sol - a.locked_sol || b.n_trades - a.n_trades);
  const incomplete = all
    .filter((row) => row.class === "incomplete")
    .sort((a, b) => b.locked_sol - a.locked_sol || b.n_trades - a.n_trades);

  printRanked("ALPHA WALLETS (ranked by realized_sol desc)", alpha);
  printRanked("LOSERS (realized_sol < 0)", losers);
  printBots(accumulationBots);

  const output = {
    generated_at: generatedAt,
    window_days: WINDOW_DAYS,
    alpha,
    losers,
    accumulation_bots: accumulationBots.map((row) => ({
      wallet: row.wallet,
      n_trades: row.n_trades,
      n_buys: row.n_buys,
      n_sells: row.n_sells,
      locked_sol: row.locked_sol,
      realized_usd: row.realized_usd,
      realized_sol: row.realized_sol,
      class: row.class
    })),
    incomplete: incomplete.map((row) => ({
      wallet: row.wallet,
      n_open: row.n_open,
      n_partial: row.n_partial,
      locked_sol: row.locked_sol,
      n_trades: row.n_trades,
      class: row.class
    }))
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nJSON written to ${path.relative(process.cwd(), OUTPUT_PATH)}`);

  const updateMetrics = db.prepare(
    `UPDATE wallets
     SET realized_sol_30d = ?, n_closed_30d = ?, wallet_class = ?
     WHERE address = ?`
  );
  const writeBack = db.transaction((rows: WalletMetrics[]) => {
    for (const row of rows) {
      updateMetrics.run(row.realized_sol, row.n_closed, row.class, row.wallet);
    }
  });
  writeBack(all);
  console.log(`wallets metrics updated: ${all.length}`);

  const pruneCandidates = losers.filter(
    (row) => row.realized_sol < 0 && row.n_closed >= 3 && CONFIRMED_LOSER_ADDRESSES.has(row.wallet)
  );
  if (applyPrune) {
    const updateWallet = db.prepare("UPDATE wallets SET active = 0 WHERE address = ? AND active = 1");
    const disabled: WalletMetrics[] = [];
    const tx = db.transaction((rows: WalletMetrics[]) => {
      for (const row of rows) {
        if (updateWallet.run(row.wallet).changes > 0) disabled.push(row);
      }
    });
    tx(pruneCandidates);

    console.log("\nDisabled wallets:");
    if (disabled.length === 0) {
      console.log("(none)");
    } else {
      for (const row of disabled) {
        console.log(`${row.wallet} | realized_sol=${fmtSol(row.realized_sol)} | n_closed=${row.n_closed}`);
      }
    }
  } else {
    console.log("\nPrune candidates (run with --apply-prune to disable):");
    if (pruneCandidates.length === 0) {
      console.log("(none)");
    } else {
      for (const row of pruneCandidates) {
        console.log(`${row.wallet} | realized_sol=${fmtSol(row.realized_sol)} | n_closed=${row.n_closed}`);
      }
    }
  }

  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
