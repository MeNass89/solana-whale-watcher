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
  // Anchor freshness to the convergence's most-recent trade time (not Date.now())
  // so backtests/replays are stable across runs.
  const referenceTime = Math.max(...buys.map((b) => b.block_time));
  const fourteenDaysAgo = referenceTime - 14 * 86400;
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
  const maxBuyTime = Math.max(...buys.map((b) => b.block_time));

  const placeholders = wallets.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT ct.convergence_id, t.wallet_address
    FROM convergence_trades ct
    JOIN trades t ON t.id = ct.trade_id
    JOIN convergences c ON c.id = ct.convergence_id
    WHERE t.wallet_address IN (${placeholders})
      AND c.last_trade_at <= ?
  `).all(...wallets, maxBuyTime) as Array<{ convergence_id: number; wallet_address: string }>;

  const byConv = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!byConv.has(row.convergence_id)) byConv.set(row.convergence_id, new Set());
    byConv.get(row.convergence_id)!.add(row.wallet_address);
  }

  // Build pair counts per convergence instead of scanning every convergence
  // for every wallet pair. O(sum_c |W_c|^2) << O(|wallets|^2 * |convs|) when
  // most convergences only touch a handful of monitored wallets.
  const pairCounts = new Map<string, number>();
  for (const [, wSet] of byConv) {
    const inConv = [...wSet];
    if (inConv.length < 2) continue;
    inConv.sort();
    for (let i = 0; i < inConv.length; i++) {
      for (let j = i + 1; j < inConv.length; j++) {
        const key = `${inConv[i]}|${inConv[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const totalPairs = (wallets.length * (wallets.length - 1)) / 2;
  let pairCoCount = 0;
  for (const count of pairCounts.values()) {
    if (count >= 3) pairCoCount++;
  }
  return totalPairs > 0 ? pairCoCount / totalPairs : 0;
}
