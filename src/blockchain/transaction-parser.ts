import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { ITradeEvent, TradeType } from "./types.js";

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

export function parseEnhancedTransactions(payload: unknown, monitoredWallets: Set<string>): ITradeEvent[] {
  const transactions = Array.isArray(payload) ? payload : [payload];
  return transactions.flatMap((transaction) => parseEnhancedTransaction(transaction, monitoredWallets));
}

export function parseEnhancedTransaction(payload: unknown, monitoredWallets: Set<string>): ITradeEvent[] {
  const tx = payload as EnhancedTransaction;
  if (!tx.signature || !tx.tokenTransfers?.length) return [];

  const wallets = new Set<string>();
  for (const transfer of tx.tokenTransfers) {
    if (transfer.fromUserAccount && monitoredWallets.has(transfer.fromUserAccount)) wallets.add(transfer.fromUserAccount);
    if (transfer.toUserAccount && monitoredWallets.has(transfer.toUserAccount)) wallets.add(transfer.toUserAccount);
  }

  return [...wallets].flatMap((wallet) => parseWalletTrade(tx, wallet));
}

function parseWalletTrade(tx: EnhancedTransaction, wallet: string): ITradeEvent[] {
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
  return relevant.map((transfer) => ({
    chain: "solana",
    walletAddress: wallet,
    tokenMint: transfer.mint!,
    txSignature: tx.signature!,
    amountToken: transfer.tokenAmount,
    amountSol: totalSol / relevant.length,
    dexSource: tx.source,
    tradeType,
    blockTime: tx.timestamp ?? Math.floor(Date.now() / 1000)
  }));
}

function sumLamports(transfers: EnhancedNativeTransfer[]): number {
  return transfers.reduce((sum, transfer) => sum + (transfer.amount ?? 0), 0);
}
