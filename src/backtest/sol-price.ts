/**
 * SOL/USD approximation.
 *
 * Most `trades` rows carry amount_sol but not amount_usd, so trade sizes in
 * USD are approximated as amount_sol × SOL_price(day). The per-day SOL price
 * comes from GeckoTerminal DAILY candles for wrapped SOL (WSOL), stored in
 * candles.sqlite under token_mint = WSOL_MINT / timeframe = 'day'.
 * If a day has no candle we use the nearest available day; if the table is
 * empty entirely we fall back to a documented constant.
 */
import type { CandleStore } from "./candle-store.js";
import { WSOL_MINT } from "./gecko.js";

/**
 * Fallback when no WSOL daily candles exist at all. $78 matches both the live
 * GeckoTerminal quote and the mean amount_usd/amount_sol ratio observed in the
 * trades table (77.76) at build time.
 */
export const SOL_USD_FALLBACK = 78;

const DAY = 86400;

export class SolPriceTable {
  private readonly byDay = new Map<number, number>();
  private sortedDays: number[] = [];

  constructor(store?: CandleStore) {
    if (!store) return;
    const rows = store.candlesBetween(WSOL_MINT, "day", 0, Number.MAX_SAFE_INTEGER);
    for (const row of rows) this.byDay.set(Math.floor(row.ts / DAY), row.close);
    this.sortedDays = [...this.byDay.keys()].sort((a, b) => a - b);
  }

  /** For tests. */
  static fromEntries(entries: Array<[dayTs: number, price: number]>): SolPriceTable {
    const table = new SolPriceTable();
    for (const [ts, price] of entries) table.byDay.set(Math.floor(ts / DAY), price);
    table.sortedDays = [...table.byDay.keys()].sort((a, b) => a - b);
    return table;
  }

  priceAt(ts: number): number {
    if (this.sortedDays.length === 0) return SOL_USD_FALLBACK;
    const day = Math.floor(ts / DAY);
    const exact = this.byDay.get(day);
    if (exact !== undefined) return exact;
    // nearest available day
    let best = this.sortedDays[0];
    for (const d of this.sortedDays) {
      if (Math.abs(d - day) < Math.abs(best - day)) best = d;
    }
    return this.byDay.get(best) ?? SOL_USD_FALLBACK;
  }

  get size(): number {
    return this.sortedDays.length;
  }
}

/** USD size of a trade: real amount_usd if present, else SOL leg × SOL/USD. */
export function tradeUsd(
  trade: { amount_usd: number | null; amount_sol: number | null; block_time: number },
  solPrices: SolPriceTable
): number {
  if (trade.amount_usd !== null && trade.amount_usd > 0) return trade.amount_usd;
  if (trade.amount_sol !== null && trade.amount_sol > 0) {
    return trade.amount_sol * solPrices.priceAt(trade.block_time);
  }
  return 0;
}
