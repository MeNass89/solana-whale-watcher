import type { AppDatabase } from "../storage/database.js";
import { jupiterClient } from "../execution/jupiter-client.js";
import { unixNow } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

interface PendingConvergence {
  id: number;
  token_mint: string;
  price_at_detection: number | null;
  first_trade_at: number;
  price_1h: number | null;
  price_24h: number | null;
  price_7d: number | null;
}

const RECENT_WINDOW_SECONDS = 8 * 24 * 60 * 60;
// Bounded batch of rows older than the recent window, oldest first, so the
// historical PENDING backlog drains a slice per run instead of being ignored
// forever by the age cutoff.
const BACKLOG_BATCH_SIZE = 100;

// A live spot price is only an honest sample of "price at detection + N" while
// the clock is still near N. Outside these tolerances the sample must come from
// historical candles (the offline BACKFILL resolver), never from today's spot —
// stamping today's price into price_1h on a two-month-old row poisons every
// downstream forward-return statistic.
const SAMPLE_WINDOWS = {
  h1: { after: 3600, until: 3 * 3600 },
  h24: { after: 86400, until: 2 * 86400 },
  d7: { after: 7 * 86400, until: 8 * 86400 }
} as const;

export async function runPriceTracker(db: AppDatabase): Promise<void> {
  const now = unixNow();
  const recent = db
    .prepare(
      `SELECT id, token_mint, price_at_detection, first_trade_at, price_1h, price_24h, price_7d
       FROM convergences
       WHERE outcome = 'PENDING' AND first_trade_at > ?`
    )
    .all(now - RECENT_WINDOW_SECONDS) as PendingConvergence[];

  const backlog = db
    .prepare(
      `SELECT id, token_mint, price_at_detection, first_trade_at, price_1h, price_24h, price_7d
       FROM convergences
       WHERE outcome = 'PENDING' AND first_trade_at <= ?
       ORDER BY first_trade_at ASC
       LIMIT ?`
    )
    .all(now - RECENT_WINDOW_SECONDS, BACKLOG_BATCH_SIZE) as PendingConvergence[];

  const rows = [...recent, ...backlog];
  if (rows.length === 0) return;

  const uniqueMints = [...new Set(rows.map((r) => r.token_mint))];
  const priceMap = new Map<string, number | null>();
  const CHUNK = 5;
  for (let i = 0; i < uniqueMints.length; i += CHUNK) {
    const chunk = uniqueMints.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map((m) => jupiterClient.getPriceUsd(m)));
    chunk.forEach((m, j) => priceMap.set(m, results[j]));
    if (i + CHUNK < uniqueMints.length) await new Promise((r) => setTimeout(r, 200));
  }

  let updated = 0;
  let markedDead = 0;
  let queuedBackfill = 0;

  for (const row of rows) {
    const age = now - row.first_trade_at;
    const price = priceMap.get(row.token_mint) ?? null;
    const pastWindow = age > RECENT_WINDOW_SECONDS;

    if (price === null || price <= 0) {
      // Backlog rows with no fetchable price are unresolvable: mark DEAD so
      // the backlog actually drains instead of retrying the same corpses.
      // Recent rows keep retrying on later runs.
      if (pastWindow) {
        db.prepare("UPDATE convergences SET outcome = 'DEAD' WHERE id = ?").run(row.id);
        markedDead++;
      }
      continue;
    }

    if (!row.price_at_detection) {
      if (pastWindow) {
        // No baseline was ever captured; a forward return cannot be computed
        // honestly this far after detection. Fabricating one from today's
        // price would grade every stale row FLAT.
        db.prepare("UPDATE convergences SET outcome = 'DEAD' WHERE id = ?").run(row.id);
        markedDead++;
        continue;
      }
      db.prepare("UPDATE convergences SET price_at_detection = ? WHERE id = ?").run(price, row.id);
    }

    if (pastWindow) {
      // Alive token, legit baseline, but every sampling window has passed:
      // hand the row to the offline historical resolver instead of lying.
      db.prepare("UPDATE convergences SET outcome = 'BACKFILL' WHERE id = ?").run(row.id);
      queuedBackfill++;
      continue;
    }

    const detection = row.price_at_detection ?? price;

    if (!row.price_1h && age >= SAMPLE_WINDOWS.h1.after && age <= SAMPLE_WINDOWS.h1.until) {
      db.prepare("UPDATE convergences SET price_1h = ? WHERE id = ?").run(price, row.id);
      updated++;
    }
    if (!row.price_24h && age >= SAMPLE_WINDOWS.h24.after && age <= SAMPLE_WINDOWS.h24.until) {
      db.prepare("UPDATE convergences SET price_24h = ? WHERE id = ?").run(price, row.id);
      updated++;
    }
    if (!row.price_7d && age >= SAMPLE_WINDOWS.d7.after && age <= SAMPLE_WINDOWS.d7.until) {
      db.prepare("UPDATE convergences SET price_7d = ? WHERE id = ?").run(price, row.id);
      const pnlPct = ((price - detection) / detection) * 100;
      const outcome = pnlPct >= 10 ? "WIN" : pnlPct <= -20 ? "LOSS" : "FLAT";
      db.prepare("UPDATE convergences SET outcome = ? WHERE id = ?").run(outcome, row.id);
      updated++;
    }
  }

  if (updated > 0 || markedDead > 0 || queuedBackfill > 0) {
    logger.info(
      { pending: rows.length, backlog: backlog.length, updated, markedDead, queuedBackfill },
      "price-tracker: snapshots recorded"
    );
  }
}
