/**
 * RPC-based transaction fetcher — replaces Helius Enhanced API REST calls for
 * wallet-scorer flows.
 *
 * WHY: The Helius Enhanced API charges ~100 credits per getWalletTransactions
 * call. A single scorer run (50 wallets × 300 txs) burns 15k+ credits against
 * the 50k daily free-tier budget. Standard Solana RPC methods
 * (getSignaturesForAddress + getParsedTransaction) are available on
 * Alchemy/Chainstack/Helius RPC endpoints with massive combined free-tier
 * capacity. Routing through the RpcRouter spreads load across all providers
 * with automatic circuit-breaker failover.
 */

import { PublicKey, type ParsedTransactionWithMeta, type ConfirmedSignatureInfo } from "@solana/web3.js";
import type { RpcRouter } from "./rpc-router.js";
import type { HeliusTransaction, HeliusTokenTransfer, HeliusNativeTransfer } from "./helius-client.js";
import { logger } from "../utils/logger.js";

/** Batch size for concurrent getParsedTransaction calls.
 * ~10 req/s sustained (5 per ~500ms incl. latency) stays under Alchemy's free
 * throughput cap; 15-wide bursts at 200ms tripped 429 cascades that opened the
 * breaker and dumped the whole getTransaction load onto Helius's monthly quota. */
const TX_FETCH_BATCH_SIZE = 5;
/** Delay between batches to avoid rate-limit bursts (ms) */
const BATCH_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch wallet transactions using standard Solana RPC via the multi-provider
 * RpcRouter. Returns data in the same HeliusTransaction shape so downstream
 * consumers (scorer, position builder) work without changes.
 */
export async function fetchWalletTransactionsViaRpc(
  router: RpcRouter,
  address: string,
  limit = 100
): Promise<HeliusTransaction[]> {
  // Step 1: Get transaction signatures (paginated)
  const signatures = await getSignaturesPaginated(router, address, limit);
  if (signatures.length === 0) return [];

  // Step 2: Fetch parsed transactions in batches
  const transactions = await fetchParsedTransactionsBatched(router, signatures);

  // Step 3: Convert to HeliusTransaction format
  return transactions
    .map((tx, i) => convertToHeliusFormat(tx, signatures[i]))
    .filter((tx): tx is HeliusTransaction => tx !== null);
}

async function getSignaturesPaginated(
  router: RpcRouter,
  address: string,
  limit: number
): Promise<ConfirmedSignatureInfo[]> {
  const results: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;

  while (results.length < limit) {
    const batchLimit = Math.min(1000, limit - results.length);
    const batch = await router.call("getSignaturesForAddress", (conn) =>
      conn.getSignaturesForAddress(
        // web3.js accepts string | PublicKey; use the string overload via PublicKey
        toPublicKey(address),
        { limit: batchLimit, before }
      )
    );

    if (batch.length === 0) break;
    results.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < batchLimit) break;
  }

  return results.slice(0, limit);
}

async function fetchParsedTransactionsBatched(
  router: RpcRouter,
  signatures: ConfirmedSignatureInfo[]
): Promise<(ParsedTransactionWithMeta | null)[]> {
  const results: (ParsedTransactionWithMeta | null)[] = [];

  for (let i = 0; i < signatures.length; i += TX_FETCH_BATCH_SIZE) {
    const batch = signatures.slice(i, i + TX_FETCH_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((sig) =>
        router.call("getTransaction", (conn) =>
          conn.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0
          })
        ).catch((err) => {
          logger.debug(
            { signature: sig.signature.slice(0, 12), err: err instanceof Error ? err.message : String(err) },
            "rpc-tx-fetcher: failed to fetch parsed transaction"
          );
          return null;
        })
      )
    );
    results.push(...batchResults);

    // Rate-limit pause between batches (skip after last batch)
    if (i + TX_FETCH_BATCH_SIZE < signatures.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return results;
}

function convertToHeliusFormat(
  tx: ParsedTransactionWithMeta | null,
  sigInfo: ConfirmedSignatureInfo
): HeliusTransaction | null {
  if (!tx) return null;

  const tokenTransfers = extractTokenTransfers(tx);
  const nativeTransfers = extractNativeTransfers(tx);
  const type = inferTransactionType(tx, tokenTransfers);

  return {
    signature: sigInfo.signature,
    type,
    timestamp: tx.blockTime ?? sigInfo.blockTime ?? Math.floor(Date.now() / 1000),
    tokenTransfers,
    nativeTransfers,
    description: sigInfo.memo ?? undefined,
    source: extractSource(tx),
    fee: tx.meta?.fee
  };
}

function extractTokenTransfers(tx: ParsedTransactionWithMeta): HeliusTokenTransfer[] {
  const transfers: HeliusTokenTransfer[] = [];

  // Use pre/post token balances to detect transfers
  const preBalances = tx.meta?.preTokenBalances ?? [];
  const postBalances = tx.meta?.postTokenBalances ?? [];

  // Build a map of account index → pre/post amounts
  const preMap = new Map<number, { owner: string; mint: string; amount: number }>();
  const postMap = new Map<number, { owner: string; mint: string; amount: number }>();

  for (const b of preBalances) {
    if (b.owner && b.mint) {
      preMap.set(b.accountIndex, {
        owner: b.owner,
        mint: b.mint,
        amount: b.uiTokenAmount?.uiAmount ?? 0
      });
    }
  }

  for (const b of postBalances) {
    if (b.owner && b.mint) {
      postMap.set(b.accountIndex, {
        owner: b.owner,
        mint: b.mint,
        amount: b.uiTokenAmount?.uiAmount ?? 0
      });
    }
  }

  // Find accounts where balance changed
  const allIndices = new Set([...preMap.keys(), ...postMap.keys()]);
  const deltasByOwnerMint = new Map<string, { owner: string; mint: string; delta: number }>();

  for (const idx of allIndices) {
    const pre = preMap.get(idx);
    const post = postMap.get(idx);
    const owner = post?.owner ?? pre?.owner;
    const mint = post?.mint ?? pre?.mint;
    if (!owner || !mint) continue;

    const preAmount = pre?.amount ?? 0;
    const postAmount = post?.amount ?? 0;
    const delta = postAmount - preAmount;
    if (Math.abs(delta) < 1e-9) continue;

    const key = `${owner}:${mint}`;
    const existing = deltasByOwnerMint.get(key);
    if (existing) {
      existing.delta += delta;
    } else {
      deltasByOwnerMint.set(key, { owner, mint, delta });
    }
  }

  // Convert deltas into from/to transfer pairs
  // Group by mint to pair senders and receivers
  const mintGroups = new Map<string, { owner: string; delta: number }[]>();
  for (const entry of deltasByOwnerMint.values()) {
    if (!mintGroups.has(entry.mint)) mintGroups.set(entry.mint, []);
    mintGroups.get(entry.mint)!.push({ owner: entry.owner, delta: entry.delta });
  }

  for (const [mint, accounts] of mintGroups) {
    const senders = accounts.filter((a) => a.delta < 0);
    const receivers = accounts.filter((a) => a.delta > 0);

    // Create transfer entries for each sender→receiver pair (simplified: largest sender to largest receiver)
    for (const sender of senders) {
      for (const receiver of receivers) {
        const amount = Math.min(Math.abs(sender.delta), receiver.delta);
        if (amount < 1e-9) continue;
        transfers.push({
          fromUserAccount: sender.owner,
          toUserAccount: receiver.owner,
          mint,
          tokenAmount: amount
        });
      }
    }
  }

  return transfers;
}

function extractNativeTransfers(tx: ParsedTransactionWithMeta): HeliusNativeTransfer[] {
  const transfers: HeliusNativeTransfer[] = [];
  const meta = tx.meta;
  if (!meta) return transfers;

  const accounts = tx.transaction.message.accountKeys;
  const preBalances = meta.preBalances;
  const postBalances = meta.postBalances;

  if (!preBalances || !postBalances || preBalances.length !== postBalances.length) return transfers;

  // Find accounts with balance changes (excluding fee payer fee)
  const deltas: { pubkey: string; delta: number }[] = [];
  for (let i = 0; i < preBalances.length; i++) {
    const delta = postBalances[i] - preBalances[i];
    // Skip tiny changes that are just rent adjustments
    if (Math.abs(delta) < 5000) continue;
    const acct = accounts[i];
    const pubkey = typeof acct === "string" ? acct : acct.pubkey.toBase58();
    deltas.push({ pubkey, delta });
  }

  const senders = deltas.filter((d) => d.delta < 0);
  const receivers = deltas.filter((d) => d.delta > 0);

  for (const sender of senders) {
    for (const receiver of receivers) {
      const amount = Math.min(Math.abs(sender.delta), receiver.delta);
      if (amount < 5000) continue;
      transfers.push({
        fromUserAccount: sender.pubkey,
        toUserAccount: receiver.pubkey,
        amount // in lamports, matching Helius format
      });
    }
  }

  return transfers;
}

function inferTransactionType(
  tx: ParsedTransactionWithMeta,
  tokenTransfers: HeliusTokenTransfer[]
): string {
  // Check for swap indicators: token transfers + SOL movement typically = SWAP
  const hasTokenTransfers = tokenTransfers.length > 0;
  const logMessages = tx.meta?.logMessages ?? [];

  // Known DEX program log prefixes
  const swapIndicators = [
    "Program JUP",    // Jupiter
    "Program whirL",  // Orca Whirlpool
    "Program 675k",   // Raydium V4
    "Program CLMM",   // Raydium CLMM
    "Program CAMMCzo", // Raydium CPMM
    "Program swap",
    "Program Dex"
  ];

  const isSwap = hasTokenTransfers && logMessages.some(
    (log) => swapIndicators.some((prefix) => log.includes(prefix))
  );

  if (isSwap) return "SWAP";
  if (hasTokenTransfers) return "TRANSFER";
  return "UNKNOWN";
}

function extractSource(tx: ParsedTransactionWithMeta): string | undefined {
  const logMessages = tx.meta?.logMessages ?? [];
  if (logMessages.some((l) => l.includes("JUP"))) return "JUPITER";
  if (logMessages.some((l) => l.includes("whirL"))) return "ORCA";
  if (logMessages.some((l) => l.includes("675k") || l.includes("CLMM") || l.includes("CAMMCzo"))) return "RAYDIUM";
  return undefined;
}

function toPublicKey(address: string): PublicKey {
  return new PublicKey(address);
}
