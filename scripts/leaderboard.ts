import fs from "node:fs";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { config } from "../src/config/index.js";

const DB_PATH = path.resolve(process.cwd(), config.databasePath);
const OUTPUT_PATH = path.resolve(process.cwd(), "data/leaderboard.json");
const WINDOW_DAYS = 30;
const WINDOW_SEC = WINDOW_DAYS * 86400;
const CONFIRMED_LOSER_ADDRESSES = new Set([
  "Hq3GSgr27vEQ8WNCAvsrCT5Kap1CcX6kpbDJYPgvcy9D",
  "9jyqFiLnruggwNn4EQwBNFXwpbLM9hrA4hV59ytyAVVz"
]);

interface CycleRow {
  wallet: string;
  token_mint: string;
  n_buys: number;
  n_sells: number;
  buy_sol: number;
  sell_sol: number;
  buy_tok: number;
  sell_tok: number;
  buy_usd: number;
  sell_usd: number;
  first_buy_time: number | null;
  last_sell_time: number | null;
}

interface WalletMetrics {
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

function main(): void {
  const applyPrune = process.argv.includes("--apply-prune");
  const generatedAt = Math.floor(Date.now() / 1000);
  const cutoff = generatedAt - WINDOW_SEC;

  const db = new DatabaseConstructor(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const activeWallets = db.prepare("SELECT address FROM wallets WHERE active = 1 ORDER BY address").all() as Array<{ address: string }>;
  const metrics = new Map<string, WalletMetrics>();
  for (const { address } of activeWallets) {
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

  const cycles = db
    .prepare(
      `SELECT wallet_address AS wallet,
              token_mint,
              SUM(CASE WHEN trade_type = 'BUY' THEN 1 ELSE 0 END) AS n_buys,
              SUM(CASE WHEN trade_type = 'SELL' THEN 1 ELSE 0 END) AS n_sells,
              SUM(CASE WHEN trade_type = 'BUY' THEN COALESCE(amount_sol, 0) ELSE 0 END) AS buy_sol,
              SUM(CASE WHEN trade_type = 'SELL' THEN COALESCE(amount_sol, 0) ELSE 0 END) AS sell_sol,
              SUM(CASE WHEN trade_type = 'BUY' THEN COALESCE(amount_token, 0) ELSE 0 END) AS buy_tok,
              SUM(CASE WHEN trade_type = 'SELL' THEN COALESCE(amount_token, 0) ELSE 0 END) AS sell_tok,
              SUM(CASE WHEN trade_type = 'BUY' THEN COALESCE(amount_usd, 0) ELSE 0 END) AS buy_usd,
              SUM(CASE WHEN trade_type = 'SELL' THEN COALESCE(amount_usd, 0) ELSE 0 END) AS sell_usd,
              MIN(CASE WHEN trade_type = 'BUY' THEN block_time END) AS first_buy_time,
              MAX(CASE WHEN trade_type = 'SELL' THEN block_time END) AS last_sell_time
       FROM trades
       WHERE block_time > ?
         AND wallet_address IN (SELECT address FROM wallets WHERE active = 1)
       GROUP BY wallet_address, token_mint`
    )
    .all(cutoff) as CycleRow[];

  const holdTimesByWallet = new Map<string, number[]>();
  for (const cycle of cycles) {
    const wallet = metrics.get(cycle.wallet);
    if (!wallet) continue;

    wallet.n_buys += cycle.n_buys;
    wallet.n_sells += cycle.n_sells;
    wallet.n_trades += cycle.n_buys + cycle.n_sells;

    if (cycle.sell_tok >= cycle.buy_tok * 0.95) {
      wallet.n_closed += 1;
      wallet.realized_sol += cycle.sell_sol - cycle.buy_sol;
      wallet.realized_usd += cycle.sell_usd - cycle.buy_usd;
      if (cycle.sell_sol > cycle.buy_sol) wallet.wins += 1;
      if (cycle.first_buy_time != null && cycle.last_sell_time != null) {
        const holdTime = Math.max(0, cycle.last_sell_time - cycle.first_buy_time);
        const holdTimes = holdTimesByWallet.get(cycle.wallet) ?? [];
        holdTimes.push(holdTime);
        holdTimesByWallet.set(cycle.wallet, holdTimes);
      }
    } else if (cycle.sell_tok === 0) {
      wallet.n_open += 1;
      wallet.locked_sol += cycle.buy_sol;
    } else {
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

  const all = [...metrics.values()];
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

main();
