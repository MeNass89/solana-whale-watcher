export interface RawTrade {
  wallet: string;
  mint: string;
  type: "BUY" | "SELL";
  block_time: number;
  amount_token: number;
  amount_sol: number;
  amount_usd: number;
}

export interface ClosedCycle {
  wallet: string;
  mint: string;
  cost_sol: number;
  cost_usd: number;
  proceeds_sol: number;
  proceeds_usd: number;
  pnl_sol: number;
  pnl_usd: number;
  hold_time_s: number;
  closed_at: number;
}

export interface OpenPosition {
  wallet: string;
  mint: string;
  locked_sol: number;
  locked_usd: number;
  locked_tok: number;
  oldest_buy_time: number;
}

export interface FifoMatchResult {
  cycles: ClosedCycle[];
  open: OpenPosition[];
  unmatched_sells: number;
}

interface Lot {
  tok: number;
  sol: number;
  usd: number;
  time: number;
}

const LOT_EMPTY_EPSILON = 1e-9;

export function matchFifo(trades: RawTrade[]): FifoMatchResult {
  const lotsByPair = new Map<string, { wallet: string; mint: string; lots: Lot[] }>();
  const cycles: ClosedCycle[] = [];
  let unmatched_sells = 0;

  for (const trade of trades) {
    const key = `${trade.wallet}\0${trade.mint}`;
    let pair = lotsByPair.get(key);
    if (!pair) {
      pair = { wallet: trade.wallet, mint: trade.mint, lots: [] };
      lotsByPair.set(key, pair);
    }

    if (trade.type === "BUY") {
      if (trade.amount_token > 0) {
        pair.lots.push({
          tok: trade.amount_token,
          sol: trade.amount_sol,
          usd: trade.amount_usd,
          time: trade.block_time
        });
      }
      continue;
    }

    let remaining = trade.amount_token;
    const sellSol = trade.amount_sol;
    const sellUsd = trade.amount_usd;
    let matchedTok = 0;
    let cycleCostSol = 0;
    let cycleCostUsd = 0;
    let oldestBuyTime: number | null = null;

    while (remaining > LOT_EMPTY_EPSILON && pair.lots.length > 0) {
      const lot = pair.lots[0];
      const take = Math.min(remaining, lot.tok);
      const ratio = take / lot.tok;
      const takeSol = lot.sol * ratio;
      const takeUsd = lot.usd * ratio;

      cycleCostSol += takeSol;
      cycleCostUsd += takeUsd;
      if (oldestBuyTime == null) oldestBuyTime = lot.time;

      lot.tok -= take;
      lot.sol -= takeSol;
      lot.usd -= takeUsd;
      matchedTok += take;
      remaining -= take;

      if (Math.abs(lot.tok) < LOT_EMPTY_EPSILON) pair.lots.shift();
    }

    if (matchedTok > 0 && oldestBuyTime != null) {
      const proceedsRatio = matchedTok / trade.amount_token;
      const proceedsSol = sellSol * proceedsRatio;
      const proceedsUsd = sellUsd * proceedsRatio;
      cycles.push({
        wallet: trade.wallet,
        mint: trade.mint,
        cost_sol: cycleCostSol,
        cost_usd: cycleCostUsd,
        proceeds_sol: proceedsSol,
        proceeds_usd: proceedsUsd,
        pnl_sol: proceedsSol - cycleCostSol,
        pnl_usd: proceedsUsd - cycleCostUsd,
        hold_time_s: Math.max(0, trade.block_time - oldestBuyTime),
        closed_at: trade.block_time
      });
    }

    if (remaining > LOT_EMPTY_EPSILON) unmatched_sells += 1;
  }

  const open: OpenPosition[] = [];
  for (const pair of lotsByPair.values()) {
    if (pair.lots.length === 0) continue;
    open.push({
      wallet: pair.wallet,
      mint: pair.mint,
      locked_sol: pair.lots.reduce((sum, lot) => sum + lot.sol, 0),
      locked_usd: pair.lots.reduce((sum, lot) => sum + lot.usd, 0),
      locked_tok: pair.lots.reduce((sum, lot) => sum + lot.tok, 0),
      oldest_buy_time: pair.lots.reduce((oldest, lot) => Math.min(oldest, lot.time), pair.lots[0].time)
    });
  }

  return { cycles, open, unmatched_sells };
}
