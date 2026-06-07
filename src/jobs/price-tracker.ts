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

export async function runPriceTracker(db: AppDatabase): Promise<void> {
  const now = unixNow();
  const rows = db
    .prepare(
      `SELECT id, token_mint, price_at_detection, first_trade_at, price_1h, price_24h, price_7d
       FROM convergences
       WHERE outcome = 'PENDING' AND first_trade_at > ?`
    )
    .all(now - 8 * 24 * 60 * 60) as PendingConvergence[];

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

  for (const row of rows) {
    const age = now - row.first_trade_at;
    const price = priceMap.get(row.token_mint) ?? null;
    if (price === null || price <= 0) continue;

    if (!row.price_at_detection) {
      db.prepare("UPDATE convergences SET price_at_detection = ? WHERE id = ?").run(price, row.id);
    }

    const detection = row.price_at_detection ?? price;

    if (!row.price_1h && age >= 3600) {
      db.prepare("UPDATE convergences SET price_1h = ? WHERE id = ?").run(price, row.id);
      updated++;
    }
    if (!row.price_24h && age >= 86400) {
      db.prepare("UPDATE convergences SET price_24h = ? WHERE id = ?").run(price, row.id);
      updated++;
    }
    if (!row.price_7d && age >= 7 * 86400) {
      db.prepare("UPDATE convergences SET price_7d = ? WHERE id = ?").run(price, row.id);
      const pnlPct = ((price - detection) / detection) * 100;
      const outcome = pnlPct >= 10 ? "WIN" : pnlPct <= -20 ? "LOSS" : "FLAT";
      db.prepare("UPDATE convergences SET outcome = ? WHERE id = ?").run(outcome, row.id);
      updated++;
    }
  }

  if (updated > 0) logger.info({ pending: rows.length, updated }, "price-tracker: snapshots recorded");
}
