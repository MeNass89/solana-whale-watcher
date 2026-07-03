/**
 * Shortlist trial CLI — the discovery shortlist faces the m=1 harness.
 *
 *   npx tsx src/discovery/shortlist-cli.ts run      # signals → candles → report
 *   npx tsx src/discovery/shortlist-cli.ts report   # re-render from existing data
 *
 * `run` is resumable: harvested wallets are skipped (harvest_state), the
 * candle fetch skips tokens already in fetch_state, the report is pure read.
 */
import { DEFAULT_CANDLE_DB } from "../backtest/candle-store.js";
import { runFetch } from "../backtest/fetcher.js";
import { openDiscoveryDb } from "./db.js";
import { harvestSignals, runShortlistReport, tokensToFetch } from "./shortlist.js";

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command !== "run" && command !== "report") {
    console.log("Usage: shortlist-cli.ts <run|report>");
    process.exitCode = command ? 1 : 0;
    return;
  }
  const db = openDiscoveryDb();
  if (command === "run") {
    await harvestSignals(db);
    const tokens = tokensToFetch(db, Math.floor(Date.now() / 1000));
    console.log(`[shortlist] ${tokens.size} tokens to fetch candles for`);
    await runFetch(DEFAULT_CANDLE_DB, undefined, tokens);
  }
  runShortlistReport(db);
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
