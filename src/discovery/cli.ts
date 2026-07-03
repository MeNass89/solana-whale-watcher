/**
 * Wallet-discovery CLI.
 *
 *   npx tsx src/discovery/cli.ts run [--mult 5] [--min-volume 1000]
 *                                    [--max-winners 200] [--min-winners 2]
 *                                    [--max-audits 400]
 *   npx tsx src/discovery/cli.ts report
 *
 * `run` is fully resumable: winners keep a status column, audits are
 * insert-once. Re-running continues where the last run stopped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditCandidates,
  auditResults,
  candidates,
  harvestEarlyBuyers,
  openDiscoveryDb,
  seedWinners
} from "./pipeline.js";

const REPORT_PATH = "backtest/DISCOVERY-REPORT.md";
const ICLOUD_COPY = path.join(
  os.homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/temp/whale-discovery-report.md"
);

function argValue(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  return index >= 0 ? Number(args[index + 1]) : fallback;
}

function report(): void {
  const db = openDiscoveryDb();
  const winners = db.prepare(`SELECT status, COUNT(*) c FROM winners GROUP BY status`).all() as Array<{
    status: string;
    c: number;
  }>;
  const results = auditResults(db);
  const cands = candidates(db, 2);

  const lines: string[] = [];
  lines.push(`# Wallet discovery — early buyers of proven pump winners`);
  lines.push("");
  lines.push(
    `Winners: ${winners.map((w) => `${w.status}=${w.c}`).join(", ")}. ` +
      `Candidates (early on ≥2 winners): ${cands.length}. Audited: ${results.length}.`
  );
  lines.push("");
  lines.push(`## Audited candidates (realized SOL flow, last 60d, ≤400 txs)`);
  lines.push("");
  lines.push(`| wallet | winners hit | swaps | buy SOL | sell SOL | net SOL | span d | verdict |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const a of results) {
    lines.push(
      `| \`${a.wallet}\` | ${a.winners_hit} | ${a.n_swaps} | ${a.buy_sol.toFixed(1)} | ${a.sell_sol.toFixed(1)} | ` +
        `**${a.net_sol.toFixed(1)}** | ${a.span_days.toFixed(1)} | ${a.verdict} |`
    );
  }
  lines.push("");
  lines.push(
    `_net SOL = realized flow only (open positions not valued). "hyperactive" = tx cadence too ` +
      `high for the 400-tx audit slice to represent P&L — likely bots, judge separately._`
  );
  lines.push("");
  const text = lines.join("\n");
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, text);
  console.log(`[discovery] wrote ${REPORT_PATH}`);
  try {
    fs.copyFileSync(REPORT_PATH, ICLOUD_COPY);
    console.log(`[discovery] copied to ${ICLOUD_COPY}`);
  } catch (error) {
    console.warn(`[discovery] iCloud copy failed: ${error instanceof Error ? error.message : error}`);
  }
  db.close();
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "report") {
    report();
    return;
  }
  if (command !== "run") {
    console.log("Usage: cli.ts <run|report> [--mult 5] [--min-volume 1000] [--max-winners 200] [--min-winners 2] [--max-audits 400]");
    process.exitCode = command ? 1 : 0;
    return;
  }
  const db = openDiscoveryDb();
  const seeded = seedWinners(db, argValue(args, "--mult", 5), argValue(args, "--min-volume", 1000));
  console.log(`[discovery] seeded ${seeded} new winners`);
  await harvestEarlyBuyers(db, argValue(args, "--max-winners", 200));
  await auditCandidates(db, argValue(args, "--min-winners", 2), argValue(args, "--max-audits", 400));
  db.close();
  report();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
