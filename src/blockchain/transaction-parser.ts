import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { ITradeEvent, TradeType } from "./types.js";

const RAPID_REVERSAL_WINDOW_SEC = 60;
const recentTrades = new Map<string, { tradeType: TradeType; blockTime: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const cleanupInterval = setInterval(() => {
  const cutoff = Date.now() / 1000 - RAPID_REVERSAL_WINDOW_SEC * 2;
  for (const [key, entry] of recentTrades) {
    if (entry.blockTime < cutoff) recentTrades.delete(key);
  }
}, CACHE_TTL_MS);

export function stopRecentTradesCleanup(): void {
  clearInterval(cleanupInterval);
  recentTrades.clear();
}

export function isRapidReversal(trade: ITradeEvent): boolean {
  const key = `${trade.walletAddress}:${trade.tokenMint}`;
  const previous = recentTrades.get(key);

  // Only advance the cache for trades that are newer than the cached entry —
  // an out-of-order webhook delivery (older blockTime arriving after a newer
  // one) must not overwrite the newer entry, otherwise the next legitimate
  // event compares against stale data.
  if (!previous || trade.blockTime > previous.blockTime) {
    recentTrades.set(key, { tradeType: trade.tradeType, blockTime: trade.blockTime });
  }

  if (!previous) return false;
  const oppositeType = trade.tradeType === "BUY" ? "SELL" : "BUY";
  if (previous.tradeType !== oppositeType) return false;
  // Only count as reversal when the new trade is strictly later than the
  // previous one within the window.
  if (trade.blockTime <= previous.blockTime) return false;
  return (trade.blockTime - previous.blockTime) < RAPID_REVERSAL_WINDOW_SEC;
}

interface EnhancedTokenTransfer {
  mint?: string;
  tokenAmount?: number;
  fromUserAccount?: string;
  toUserAccount?: string;
}

interface EnhancedNativeTransfer {
  amount?: number;
  fromUserAccount?: string;
  toUserAccount?: string;
}

interface EnhancedTransaction {
  signature?: string;
  source?: string;
  type?: string;
  timestamp?: number;
  tokenTransfers?: EnhancedTokenTransfer[];
  nativeTransfers?: EnhancedNativeTransfer[];
}

export function parseEnhancedTransactions(payload: unknown, monitoredWallets: Set<string>, solPriceUsd?: number | null): ITradeEvent[] {
  const transactions = Array.isArray(payload) ? payload : [payload];
  return transactions.flatMap((transaction) => parseEnhancedTransaction(transaction, monitoredWallets, solPriceUsd));
}

export function parseEnhancedTransaction(payload: unknown, monitoredWallets: Set<string>, solPriceUsd?: number | null): ITradeEvent[] {
  const tx = payload as EnhancedTransaction;
  if (!tx.signature || !tx.tokenTransfers?.length) return [];

  const wallets = new Set<string>();
  for (const transfer of tx.tokenTransfers) {
    if (transfer.fromUserAccount && monitoredWallets.has(transfer.fromUserAccount)) wallets.add(transfer.fromUserAccount);
    if (transfer.toUserAccount && monitoredWallets.has(transfer.toUserAccount)) wallets.add(transfer.toUserAccount);
  }

  return [...wallets].flatMap((wallet) => parseWalletTrade(tx, wallet, solPriceUsd));
}

function parseWalletTrade(tx: EnhancedTransaction, wallet: string, solPriceUsd?: number | null): ITradeEvent[] {
  const tokenTransfers = tx.tokenTransfers ?? [];
  const received = tokenTransfers.filter((transfer) => transfer.toUserAccount === wallet && transfer.mint);
  const sent = tokenTransfers.filter((transfer) => transfer.fromUserAccount === wallet && transfer.mint);
  const solReceived = sumLamports((tx.nativeTransfers ?? []).filter((transfer) => transfer.toUserAccount === wallet));
  const solSent = sumLamports((tx.nativeTransfers ?? []).filter((transfer) => transfer.fromUserAccount === wallet));

  const tradeType: TradeType | null =
    received.length > 0 && solSent > 0 ? "BUY" : sent.length > 0 && solReceived > 0 ? "SELL" : null;
  if (!tradeType) return [];

  const relevant = tradeType === "BUY" ? received : sent;
  const totalSol = (tradeType === "BUY" ? solSent : solReceived) / LAMPORTS_PER_SOL;
  const perTransferSol = totalSol / relevant.length;
  // amount_usd is populated at ingest so the MIN_TRADE_USD convergence filter
  // has something to filter on; left NULL the filter is permanently inert.
  const amountUsd = solPriceUsd && solPriceUsd > 0 ? perTransferSol * solPriceUsd : undefined;
  return relevant.map((transfer) => ({
    chain: "solana",
    walletAddress: wallet,
    tokenMint: transfer.mint!,
    txSignature: tx.signature!,
    amountToken: transfer.tokenAmount,
    amountSol: perTransferSol,
    amountUsd,
    dexSource: tx.source,
    tradeType,
    blockTime: tx.timestamp ?? Math.floor(Date.now() / 1000)
  }));
}

function sumLamports(transfers: EnhancedNativeTransfer[]): number {
  return transfers.reduce((sum, transfer) => sum + (transfer.amount ?? 0), 0);
}
