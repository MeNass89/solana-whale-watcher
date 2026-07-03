/**
 * Chain access for discovery — thin helpers over the existing RpcRouter
 * (Alchemy archive primary, Helius fallback, circuit-breaker protected).
 * Throughput deliberately matches rpc-transaction-fetcher's validated pacing:
 * ~10 tx-fetches/s sustained; wider bursts tripped 429 cascades.
 */
import { PublicKey, type ConfirmedSignatureInfo, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getRpcRouter } from "../blockchain/rpc-router.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const TX_BATCH = 5;
const BATCH_DELAY_MS = 350;
const LAMPORTS = 1e9;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Page signatures for an address from newest to oldest until `untilTs` is
 * passed or `maxPages` is exhausted. Returns { sigs, complete } where
 * complete=false means history was truncated by the page cap.
 *
 * `anchorSig` is the time machine: pagination starts BEFORE that signature
 * instead of from the present, so a known tx near the target window (e.g. our
 * whale's first buy from the live DB) jumps straight to the token's early
 * life instead of walking weeks of dust history.
 */
export async function signaturesBackTo(
  address: string,
  untilTs: number,
  maxPages: number,
  anchorSig?: string
): Promise<{ sigs: ConfirmedSignatureInfo[]; complete: boolean }> {
  const router = getRpcRouter();
  const key = new PublicKey(address);
  const all: ConfirmedSignatureInfo[] = [];
  let before: string | undefined = anchorSig;
  for (let page = 0; page < maxPages; page++) {
    const batch = await router.call("getSignaturesForAddress", (conn) =>
      conn.getSignaturesForAddress(key, { limit: 1000, before })
    );
    if (batch.length === 0) return { sigs: all, complete: true };
    all.push(...batch);
    const oldest = batch[batch.length - 1];
    if (oldest.blockTime != null && oldest.blockTime < untilTs) return { sigs: all, complete: true };
    if (batch.length < 1000) return { sigs: all, complete: true };
    before = oldest.signature;
    await sleep(120);
  }
  return { sigs: all, complete: false };
}

export async function fetchParsedBatched(
  signatures: string[],
  onProgress?: (fetched: number) => void
): Promise<Array<ParsedTransactionWithMeta | null>> {
  const router = getRpcRouter();
  const out: Array<ParsedTransactionWithMeta | null> = [];
  for (let i = 0; i < signatures.length; i += TX_BATCH) {
    const slice = signatures.slice(i, i + TX_BATCH);
    const txs = await Promise.all(
      slice.map((sig) =>
        router
          .call("getTransaction", (conn) =>
            conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
          )
          .catch(() => null)
      )
    );
    out.push(...txs);
    onProgress?.(out.length);
    await sleep(BATCH_DELAY_MS);
  }
  return out;
}

export interface SwapView {
  feePayer: string;
  blockTime: number;
  /** SOL delta of the fee payer, native + WSOL combined (negative = spent) */
  solDelta: number;
  /** uiAmount delta per non-WSOL mint for accounts owned by the fee payer */
  tokenDeltas: Map<string, number>;
}

/** Reduce a parsed tx to the fee payer's SOL and token flows. */
export function toSwapView(tx: ParsedTransactionWithMeta | null): SwapView | null {
  if (!tx?.meta || tx.blockTime == null) return null;
  if (tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys;
  if (keys.length === 0) return null;
  const feePayer = keys[0].pubkey.toString();

  let solDelta = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / LAMPORTS;
  const tokenDeltas = new Map<string, number>();

  const pre = new Map<string, number>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (b.owner !== feePayer) continue;
    pre.set(b.mint, (pre.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
  }
  const post = new Map<string, number>();
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.owner !== feePayer) continue;
    post.set(b.mint, (post.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
  }
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const delta = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0);
    if (mint === WSOL_MINT) solDelta += delta;
    else if (delta !== 0) tokenDeltas.set(mint, delta);
  }
  return { feePayer, blockTime: tx.blockTime, solDelta, tokenDeltas };
}
