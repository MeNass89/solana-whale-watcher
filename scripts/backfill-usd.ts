import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { setTimeout as sleep } from "node:timers/promises";
import { birdEyeClient, type HistoricalPrice } from "../src/blockchain/birdeye-client.js";
import { config } from "../src/config/index.js";

const DB_PATH = path.resolve(process.cwd(), config.databasePath);
const CANDLE_TOLERANCE_SEC = 300;
const HISTORY_PADDING_SEC = 600;
const RATE_LIMIT_DELAY_MS = 1000;

interface TokenRangeRow {
  mint: string;
  minTs: number;
  maxTs: number;
  nullTrades: number;
}

interface TradeRow {
  id: number;
  token_mint: string;
  amount_token: number | null;
  amount_sol: number | null;
  block_time: number;
}

interface StillNullReason {
  id: number;
  mint: string;
  reason: string;
}

interface CachedSolPrice {
  unixTime: number;
  value: number | null;
}

function nearestCandle(prices: HistoricalPrice[], unixTime: number): HistoricalPrice | null {
  if (prices.length === 0) return null;

  let lo = 0;
  let hi = prices.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (prices[mid].unixTime < unixTime) lo = mid + 1;
    else hi = mid;
  }

  const candidates = [prices[lo], prices[lo - 1]].filter(Boolean) as HistoricalPrice[];
  let best: HistoricalPrice | null = null;
  for (const candidate of candidates) {
    if (!best || Math.abs(candidate.unixTime - unixTime) < Math.abs(best.unixTime - unixTime)) {
      best = candidate;
    }
  }

  if (!best || Math.abs(best.unixTime - unixTime) > CANDLE_TOLERANCE_SEC) return null;
  return best.value > 0 ? best : null;
}

async function main(): Promise<void> {
  if (!config.birdeye.apiKey) {
    throw new Error("BIRDEYE_API_KEY is not set; config.birdeye.apiKey is required for USD backfill");
  }

  const db = new DatabaseConstructor(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const tokenRanges = db
    .prepare(
      `SELECT token_mint AS mint,
              MIN(block_time) AS minTs,
              MAX(block_time) AS maxTs,
              COUNT(*) AS nullTrades
       FROM trades
       WHERE amount_usd IS NULL
       GROUP BY token_mint
       ORDER BY nullTrades DESC, mint`
    )
    .all() as TokenRangeRow[];
  const totalTradesTargeted = db.prepare("SELECT COUNT(*) AS count FROM trades WHERE amount_usd IS NULL").get() as { count: number };

  const selectNullTradesForMint = db
    .prepare(
      `SELECT id, token_mint, amount_token, amount_sol, block_time
       FROM trades
       WHERE token_mint = ? AND amount_usd IS NULL
       ORDER BY block_time`
    );
  const updateUsd = db.prepare("UPDATE trades SET amount_usd = ? WHERE id = ? AND amount_usd IS NULL");

  let filledBirdeye = 0;
  let filledSolLeg = 0;
  const stillNull: StillNullReason[] = [];
  const solUsdCache = new Map<number, CachedSolPrice>();

  for (const [index, token] of tokenRanges.entries()) {
    console.log(`[${index + 1}/${tokenRanges.length}] ${token.mint} (${token.nullTrades} trades)`);

    let prices: HistoricalPrice[] = [];
    let historyError: string | null = null;
    try {
      prices = await birdEyeClient.getHistoricalPrices(token.mint, token.minTs - HISTORY_PADDING_SEC, token.maxTs + HISTORY_PADDING_SEC, "5m");
    } catch (error) {
      historyError = error instanceof Error ? error.message : String(error);
      console.log(`  history_price failed: ${historyError}`);
    }
    await sleep(RATE_LIMIT_DELAY_MS);

    const fallbackTrades: Array<{ trade: TradeRow; reason: string }> = [];
    const trades = selectNullTradesForMint.all(token.mint) as TradeRow[];
    for (const trade of trades) {
      const candle = nearestCandle(prices, trade.block_time);
      if (candle && trade.amount_token != null) {
        // Sells may be stored with negative amount_token; the absolute value
        // is what gets multiplied by the candle price, otherwise every exit
        // trade ends up with a negative USD that the > 0 guard discards.
        const usd = Math.abs(trade.amount_token) * candle.value;
        if (Number.isFinite(usd) && usd > 0 && updateUsd.run(usd, trade.id).changes > 0) {
          filledBirdeye += 1;
          continue;
        }
      }

      fallbackTrades.push({
        trade,
        reason: historyError ?? (prices.length === 0 ? "empty history_price response" : "no candle within +/-300s")
      });
    }

    for (const { trade, reason } of fallbackTrades) {
      if (trade.amount_sol == null) {
        stillNull.push({ id: trade.id, mint: trade.token_mint, reason: `${reason}; missing amount_sol for SOL fallback` });
        continue;
      }

      const bucket = Math.floor(trade.block_time / 3600);
      let cached = solUsdCache.get(bucket);
      if (!cached) {
        const unixTime = trade.block_time;
        const value = await birdEyeClient.getSolUsdAt(unixTime);
        cached = { unixTime, value };
        solUsdCache.set(bucket, cached);
        await sleep(RATE_LIMIT_DELAY_MS);
      }

      if (cached.value == null) {
        stillNull.push({ id: trade.id, mint: trade.token_mint, reason: `${reason}; SOL/USD fallback unavailable` });
        continue;
      }

      const usd = Math.abs(trade.amount_sol) * cached.value;
      if (Number.isFinite(usd) && usd > 0 && updateUsd.run(usd, trade.id).changes > 0) {
        filledSolLeg += 1;
      } else {
        stillNull.push({ id: trade.id, mint: trade.token_mint, reason: `${reason}; invalid SOL fallback amount` });
      }
    }
  }

  const stillNullCount = (db.prepare("SELECT COUNT(*) AS count FROM trades WHERE amount_usd IS NULL").get() as { count: number }).count;
  console.log("\nTrades still NULL after backfill:");
  if (stillNull.length === 0) {
    console.log("  none logged in this run");
  } else {
    for (const item of stillNull.slice(0, 200)) {
      console.log(`  id=${item.id} mint=${item.mint} reason=${item.reason}`);
    }
    if (stillNull.length > 200) console.log(`  ... ${stillNull.length - 200} additional rows omitted`);
  }

  console.log("\nCoverage report:");
  console.log(
    JSON.stringify(
      {
        total_trades_targeted: totalTradesTargeted.count,
        filled_birdeye: filledBirdeye,
        filled_solleg: filledSolLeg,
        still_null: stillNullCount
      },
      null,
      2
    )
  );

  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
