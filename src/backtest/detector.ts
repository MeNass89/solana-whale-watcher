/**
 * Parameterized convergence detector for replay. Recomputes signals straight
 * from the raw `trades` table — it never reads the live `convergences` table.
 *
 * NO-LOOKAHEAD GUARANTEE: the detector consumes trades strictly in block_time
 * order and every emitted event at detection ts T depends only on trades with
 * block_time ≤ T. This is proven by the truncation test in __tests__.
 *
 * Dedup: after a token emits an event, that token is suppressed for
 * `window_minutes` (cooldown) so one burst of buying produces one signal, as
 * the live alerting effectively does.
 */
import type { TradeRow } from "./live-db.js";
import { tradeUsd, type SolPriceTable } from "./sol-price.js";

export type PumpFilter = "pump" | "nonpump" | "both";

export interface DetectionParams {
  windowMinutes: number;
  minWallets: number;
  minTradeUsd: number;
  pumpFilter: PumpFilter;
}

export interface DetectionEvent {
  tokenMint: string;
  detectedAt: number; // block_time of the triggering BUY
  walletCount: number;
  totalUsd: number;
  isPump: boolean;
}

export function isPumpMint(mint: string): boolean {
  return mint.toLowerCase().endsWith("pump");
}

interface WindowBuy {
  wallet: string;
  ts: number;
  usd: number;
}

/**
 * Runs detection over trades (must be sorted ascending by block_time — the
 * detector enforces this by sorting defensively).
 */
export function detectConvergences(
  trades: TradeRow[],
  params: DetectionParams,
  solPrices: SolPriceTable
): DetectionEvent[] {
  const windowSeconds = params.windowMinutes * 60;
  const sorted = [...trades].sort((a, b) => a.block_time - b.block_time);

  const windows = new Map<string, WindowBuy[]>();
  const cooldownUntil = new Map<string, number>();
  const events: DetectionEvent[] = [];

  for (const trade of sorted) {
    if (trade.trade_type !== "BUY") continue;
    const isPump = isPumpMint(trade.token_mint);
    if (params.pumpFilter === "pump" && !isPump) continue;
    if (params.pumpFilter === "nonpump" && isPump) continue;

    const usd = tradeUsd(trade, solPrices);
    if (usd < params.minTradeUsd) continue;

    const now = trade.block_time;
    let window = windows.get(trade.token_mint);
    if (!window) {
      window = [];
      windows.set(trade.token_mint, window);
    }
    window.push({ wallet: trade.wallet_address, ts: now, usd });
    // evict buys older than the window
    while (window.length > 0 && window[0].ts < now - windowSeconds) window.shift();

    const until = cooldownUntil.get(trade.token_mint) ?? 0;
    if (now < until) continue;

    const wallets = new Set(window.map((buy) => buy.wallet));
    if (wallets.size >= params.minWallets) {
      events.push({
        tokenMint: trade.token_mint,
        detectedAt: now,
        walletCount: wallets.size,
        totalUsd: window.reduce((sum, buy) => sum + buy.usd, 0),
        isPump
      });
      cooldownUntil.set(trade.token_mint, now + windowSeconds);
    }
  }

  return events;
}
