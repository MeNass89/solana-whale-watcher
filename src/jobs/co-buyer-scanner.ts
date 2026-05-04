import type { AppDatabase } from "../storage/database.js";
import type { WalletModel } from "../storage/models/wallets.js";
import { logger } from "../utils/logger.js";

export async function discoverCoBuyers(
  db: AppDatabase,
  wallets: WalletModel,
  tokenMint: string,
  convergenceFirstTradeAt: number,
  windowMinutes: number
): Promise<number> {
  const since = convergenceFirstTradeAt - windowMinutes * 60;
  const until = convergenceFirstTradeAt + windowMinutes * 60;

  const rows = db
    .prepare(
      `SELECT DISTINCT wallet_address FROM trades
       WHERE token_mint = ? AND trade_type = 'BUY' AND block_time BETWEEN ? AND ?`
    )
    .all(tokenMint, since, until) as Array<{ wallet_address: string }>;

  let discovered = 0;
  for (const row of rows) {
    if (wallets.find(row.wallet_address)) continue;
    wallets.upsert({
      address: row.wallet_address,
      source: "co-buyer",
      state: "NEW",
      active: true
    });
    discovered++;
    logger.info({ address: row.wallet_address.substring(0, 12), tokenMint: tokenMint.substring(0, 12) }, "co-buyer-scanner: discovered new wallet");
  }

  if (discovered > 0) {
    logger.info({ tokenMint: tokenMint.substring(0, 12), discovered }, "co-buyer-scanner: batch complete");
  }
  return discovered;
}
