export type Chain = "solana";
export type TradeType = "BUY" | "SELL";
export type WalletSource = "manual" | "axiom" | "nansen" | "dune" | "discovered" | "co-buyer";
export type WalletState = "NEW" | "PROBATION" | "ACTIVE" | "DORMANT" | "DEMOTED" | "PRUNED" | "ARCHIVED";
export type AlertTier = "CRITICAL" | "NOTABLE" | "WATCH";

export interface ITradeEvent {
  chain: Chain;
  walletAddress: string;
  tokenMint: string;
  txSignature: string;
  amountToken?: number;
  amountSol?: number;
  amountUsd?: number;
  dexSource?: string;
  tradeType: TradeType;
  blockTime: number;
}

export interface IChainMonitor {
  registerWebhook(addresses: string[], webhookUrl: string): Promise<string>;
  updateWebhook(webhookId: string, addresses: string[], webhookUrl: string): Promise<void>;
}

export interface TokenMetadata {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  imageUrl?: string;
  liquidityUsd?: number;
  isVerified?: boolean;
  createdAt?: number;
  updatedAt?: number;
}
