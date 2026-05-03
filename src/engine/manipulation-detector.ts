import type { TradeRow } from "../storage/models/trades.js";
import type { WalletModel } from "../storage/models/wallets.js";
import type { AppDatabase } from "../storage/database.js";

export interface ManipulationSignals {
  timeClusteringScore: number;
  sellPressureRatio: number;
  freshWalletFraction: number;
  coOccurrenceScore: number;
}

export function computeManipulationSignals(
  buys: TradeRow[],
  sells: TradeRow[],
  walletModel: WalletModel,
  db: AppDatabase
): ManipulationSignals {
  return {
    timeClusteringScore: computeTimeClustering(buys),
    sellPressureRatio: computeSellPressure(buys, sells),
    freshWalletFraction: computeFreshWalletFraction(buys, walletModel),
    coOccurrenceScore: computeCoOccurrence(buys, db),
  };
}

function computeTimeClustering(buys: TradeRow[]): number {
  if (buys.length < 3) return 0;
  const times = buys.map((b) => b.block_time);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const variance = times.reduce((s, t) => s + (t - mean) ** 2, 0) / times.length;
  const stddev = Math.sqrt(variance);
  if (stddev >= 600) return 0;
  if (stddev <= 30) return 1;
  return 1 - (stddev - 30) / (600 - 30);
}

function computeSellPressure(buys: TradeRow[], sells: TradeRow[]): number {
  const total = buys.length + sells.length;
  if (total === 0) return 0;
  return sells.length / total;
}

function computeFreshWalletFraction(buys: TradeRow[], walletModel: WalletModel): number {
  const wallets = [...new Set(buys.map((b) => b.wallet_address))];
  if (wallets.length === 0) return 0;
  const fourteenDaysAgo = Math.floor(Date.now() / 1000) - 14 * 86400;
  let freshCount = 0;
  for (const addr of wallets) {
    const w = walletModel.find(addr);
    if (!w) { freshCount++; continue; }
    if (w.added_at > fourteenDaysAgo || w.total_trades < 15) freshCount++;
  }
  return freshCount / wallets.length;
}

function computeCoOccurrence(buys: TradeRow[], db: AppDatabase): number {
  const wallets = [...new Set(buys.map((b) => b.wallet_address))];
  if (wallets.length < 3) return 0;

  const placeholders = wallets.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT ct.convergence_id, t.wallet_address
    FROM convergence_trades ct
    JOIN trades t ON t.id = ct.trade_id
    WHERE t.wallet_address IN (${placeholders})
  `).all(...wallets) as Array<{ convergence_id: number; wallet_address: string }>;

  const byConv = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!byConv.has(row.convergence_id)) byConv.set(row.convergence_id, new Set());
    byConv.get(row.convergence_id)!.add(row.wallet_address);
  }

  let pairCoCount = 0;
  let totalPairs = 0;
  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      totalPairs++;
      let coCount = 0;
      for (const [, wSet] of byConv) {
        if (wSet.has(wallets[i]) && wSet.has(wallets[j])) coCount++;
      }
      if (coCount >= 3) pairCoCount++;
    }
  }
  return totalPairs > 0 ? pairCoCount / totalPairs : 0;
}
