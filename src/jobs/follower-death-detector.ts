import type { AppDatabase } from "../storage/database.js";
import type { WalletModel } from "../storage/models/wallets.js";
import { logger } from "../utils/logger.js";

const DAY_SECONDS = 24 * 60 * 60;

export function checkFollowerWalletDeaths(
  db: AppDatabase,
  wallets: WalletModel,
  options: { now?: number; dormantAfterDays?: number } = {}
): { checked: number; dormant: string[] } {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const cutoff = now - (options.dormantAfterDays ?? 4) * DAY_SECONDS;
  const dormant: string[] = [];
  const pinned = wallets.listPinned();
  for (const wallet of pinned) {
    const row = db
      .prepare(
        `SELECT MAX(block_time) AS lastBuy
         FROM trades
         WHERE wallet_address = ? AND trade_type = 'BUY'`
      )
      .get(wallet.address) as { lastBuy: number | null };
    // A freshly enrolled wallet has no local trade history yet (ingestion
    // only starts at enrollment — and can miss days during a webhook outage,
    // observed live 2026-07-10→12). Grace-period on added_at, otherwise the
    // first detector run muzzles every new wallet on sight.
    const lastSeen = row.lastBuy ?? wallet.added_at;
    if (lastSeen < cutoff) {
      wallets.update(wallet.address, { state: "DORMANT", active: false, monitorPolicy: "pinned" });
      dormant.push(wallet.address);
      logger.warn({ wallet: wallet.address, lastBuy: row.lastBuy, dormantAfterDays: options.dormantAfterDays ?? 4 }, "follower wallet marked DORMANT");
    }
  }
  return { checked: pinned.length, dormant };
}
