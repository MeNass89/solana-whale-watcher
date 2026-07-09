import { PublicKey } from "@solana/web3.js";
import { openDatabase } from "../src/storage/database.js";
import { WalletModel } from "../src/storage/models/wallets.js";
import { evaluateFollowerCandidate, type CandidateBuy } from "../src/engine/liveness.js";
import { HeliusClient, type HeliusTransaction } from "../src/blockchain/helius-client.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const EXCLUDED_BUY_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

export async function fetchCandidateBuys(input: {
  db: ReturnType<typeof openDatabase>;
  address: string;
  sinceBlockTime: number;
  helius?: HeliusClient;
}): Promise<CandidateBuy[]> {
  if (!process.env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY is required for pinned wallet liveness checks");
  const localRows = input.db
    .prepare(
      `SELECT tx_signature AS signature, block_time AS blockTime
       FROM trades
       WHERE wallet_address = ? AND trade_type = 'BUY' AND block_time >= ?
       ORDER BY block_time DESC`
    )
    .all(input.address, input.sinceBlockTime) as CandidateBuy[];
  const helius = input.helius ?? new HeliusClient();
  const onChainRows = (await helius.getWalletTransactionsSince(input.address, input.sinceBlockTime))
    .filter((tx) => isQualifyingBuy(input.address, tx))
    .map((tx) => ({ signature: tx.signature, blockTime: tx.timestamp }));
  const bySignature = new Map<string, CandidateBuy>();
  for (const buy of [...localRows, ...onChainRows]) bySignature.set(buy.signature, buy);
  return [...bySignature.values()].sort((a, b) => b.blockTime - a.blockTime);
}

export function isQualifyingBuy(address: string, tx: HeliusTransaction): boolean {
  if (tx.type !== "SWAP") return false;
  return tx.tokenTransfers.some((transfer) =>
    transfer.toUserAccount === address &&
    Boolean(transfer.mint) &&
    !EXCLUDED_BUY_MINTS.has(transfer.mint) &&
    transfer.tokenAmount > 0
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const pinned = argv.includes("--pinned");
  const positional = argv.filter((arg) => arg !== "--pinned");
  const [address, label = "", source = pinned ? "discovered" : "manual"] = positional;
  if (!address) {
    throw new Error("Usage: npm run add-wallet -- <address> [label] [source] [--pinned]");
  }

  new PublicKey(address);
  const db = openDatabase();
  const wallets = new WalletModel(db);

  if (pinned) {
    const result = await evaluateFollowerCandidate({
      address,
      fetchBuys: async (_candidate, sinceBlockTime) => fetchCandidateBuys({ db, address, sinceBlockTime })
    });
    if (!result.allowed) {
      throw new Error(`Pinned wallet enrollment refused: ${result.reason}. metrics=${JSON.stringify(result.metrics)}`);
    }
  }

  wallets.upsert({
    address,
    label,
    source: source as "manual" | "discovered",
    state: pinned ? "ACTIVE" : "NEW",
    monitorPolicy: pinned ? "pinned" : "pool"
  });
  console.log(`Added wallet ${address}${pinned ? " as pinned follower" : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
