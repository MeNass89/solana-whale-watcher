import type { ConvergenceRow } from "../storage/models/convergences.js";
import type { TradeRow } from "../storage/models/trades.js";
import type { WalletRow } from "../storage/models/wallets.js";
import type { ITradeEvent } from "../blockchain/types.js";
import { formatUsd, truncateAddress, unique } from "../utils/helpers.js";

export function formatDiscordMessage(convergence: ConvergenceRow, trades: TradeRow[]): Record<string, unknown> {
  const mint = convergence.token_mint;
  const symbol = convergence.token_symbol ? `$${convergence.token_symbol}` : truncateAddress(mint);
  const wallets = unique(trades.map((trade) => trade.wallet_address)).map((address) => truncateAddress(address));
  const title = `CONVERGENCE ${convergence.tier}`;
  const description = [
    `Token: ${symbol} (${truncateAddress(mint)})`,
    `Score: ${convergence.score}/100`,
    `Wallets: ${convergence.wallet_count} tracked wallets buying`,
    `Volume: ${formatUsd(convergence.total_usd)}`,
    `Fenetre: ${formatWindow(convergence)}`,
    `Wallet labels: ${wallets.join(", ")}`
  ].join("\n");

  return {
    content: convergence.tier === "CRITICAL" ? "@everyone" : undefined,
    embeds: [
      {
        title,
        description,
        color: convergence.tier === "CRITICAL" ? 0xff3366 : 0x00ff88,
        fields: [
          { name: "Birdeye", value: `https://birdeye.so/token/${mint}?chain=solana`, inline: true },
          { name: "Jupiter", value: `https://jup.ag/swap/SOL-${mint}`, inline: true },
          { name: "DEXScreener", value: `https://dexscreener.com/solana/${mint}`, inline: true }
        ],
        timestamp: new Date(convergence.created_at * 1000).toISOString()
      }
    ]
  };
}

export function formatWhaleTradeMessage(trade: ITradeEvent, wallet: WalletRow): Record<string, unknown> {
  const mint = trade.tokenMint;
  const label = wallet.label || truncateAddress(trade.walletAddress);
  const solAmount = trade.amountSol ? `${trade.amountSol.toFixed(2)} SOL` : "? SOL";
  const emoji = trade.tradeType === "BUY" ? "\u{1F7E2}" : "\u{1F534}";
  const title = `${emoji} WHALE ${trade.tradeType}: ${label}`;
  const description = [
    `Wallet: ${truncateAddress(trade.walletAddress)} (score ${wallet.score}, ${wallet.state})`,
    `Token: ${truncateAddress(mint)}`,
    `Amount: ${solAmount}`,
    `DEX: ${trade.dexSource || "unknown"}`
  ].join("\n");

  return {
    embeds: [
      {
        title,
        description,
        color: trade.tradeType === "BUY" ? 0x00cc66 : 0xcc3300,
        fields: [
          { name: "Birdeye", value: `https://birdeye.so/token/${mint}?chain=solana`, inline: true },
          { name: "DEXScreener", value: `https://dexscreener.com/solana/${mint}`, inline: true }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function formatWindow(convergence: ConvergenceRow): string {
  const minutes = Math.max(1, Math.round((convergence.last_trade_at - convergence.first_trade_at) / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}` : `${minutes} minutes`;
}
