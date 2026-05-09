# CodeRabbit Review #5 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 15:24:47Z against commit `72a9694`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-5-raw.md` (1010 lines).
**Counts:** 8 actionable + 12 duplicates (already addressed by 72a9694, ignore).

## Triage

| # | Path | Decision | Reason |
|---|------|----------|--------|
| 1 | `docs/audit-report.md:6` | APPLY | Stale path: `src/services/alert-manager.ts` → `src/engine/alert-manager.ts`. Verified: only `src/engine/alert-manager.ts` exists. |
| 2 | `docs/superpowers/plans/2026-05-09-coderabbit-review-3.md:182-189` | APPLY | "(5 files)" disagrees with 7 paths listed below it. Update count to "(7 files)". |
| 3 | `scripts/backfill-usd.ts:147-155` | APPLY | SOL/USD fallback `getSolUsdAt` lacks `BirdEyeRateLimitError` handling. Mirror the token-history retry/backoff pattern at lines 105-118. |
| 4 | `src/blockchain/transaction-parser.ts:20-28` | APPLY | `isRapidReversal` writes to `recentTrades` *before* the order/window check. An out-of-order delivery (older webhook arriving after a newer one) overwrites the newer entry. Real correctness bug for replayed/late Helius events. |
| 5 | `src/engine/fifo-matcher.ts:48-120` | APPLY | `matchFifo` assumes pre-sorted input. Sort defensively at the top by `block_time` ascending; ties broken stably. Cheap to do, eliminates a footgun. |
| 6 | `src/engine/scorer.ts:95-98` | **SKIP** | CodeRabbit claims `isMev`/`isWashTrader` should use the unified `trades+heliusTxs` collection. **Intentional**: MEV/wash detection requires parsed BUY/SELL pairs that only DB `trades` reliably provide. Using heliusTxs raw inflates noise (router-internal swaps, multi-leg routes). Skip. |
| 7 | `src/engine/scorer.ts:37-84` | **DEFER** | Lots-based partial-fill refactor for `computeHoldTimes`/`detectWashTrading`. Real algorithmic gap (whole-row shift treats a partial sell as full close), but a meaningful refactor — out of scope for this cleanup loop. Open follow-up. |
| 8 | `src/execution/position-auditor.ts:22-23` | APPLY | Auditor accepts `entry_price_usd > 0` while runtime uses `isSanePrice` (`> 1e-15`). Switch auditor to import + use `isSanePrice` from `src/execution/jupiter-client.ts` for both `entry_price_usd` and `current_price_usd`. |

**Result:** 6 to apply, 1 skip, 1 defer.

## Tasks

### Task 1 — `docs/audit-report.md:6` path fix

```diff
-> `src/jobs/webhook-health.ts`, and the post-convergence hook in `src/services/alert-manager.ts`
+> `src/jobs/webhook-health.ts`, and the post-convergence hook in `src/engine/alert-manager.ts`
```

Also check line 134 for the same string `alert-manager.ts` reference — it already says `alert-manager.ts` without a path prefix, so leave it. If any other occurrences of `src/services/alert-manager.ts` exist anywhere in the file, fix them too (`grep -n "src/services/alert-manager" docs/audit-report.md`).

### Task 2 — `docs/superpowers/plans/2026-05-09-coderabbit-review-3.md:182` count fix

```diff
-7. `git add -A` — verify staged files match expected list (5 files):
+7. `git add -A` — verify staged files match expected list (7 files):
```

### Task 3 — `scripts/backfill-usd.ts` SOL/USD rate-limit handling

Current `for (const trade of fallbackTrades)` loop in lines 140-167 calls `birdEyeClient.getSolUsdAt(unixTime)` without catching `BirdEyeRateLimitError`. Mirror the token-history pattern.

```diff
       const bucket = Math.floor(trade.block_time / 3600);
       let cached = solUsdCache.get(bucket);
       if (!cached) {
         const unixTime = trade.block_time;
-        const value = await birdEyeClient.getSolUsdAt(unixTime);
-        cached = { unixTime, value };
-        solUsdCache.set(bucket, cached);
-        await sleep(RATE_LIMIT_DELAY_MS);
+        let value: number | null = null;
+        // Retry on 429 with retry-after; otherwise let other errors bubble.
+        // Mirrors the token-history retry block above so a single SOL/USD
+        // rate-limit doesn't poison the whole fallback batch.
+        // eslint-disable-next-line no-constant-condition
+        while (true) {
+          try {
+            value = await birdEyeClient.getSolUsdAt(unixTime);
+            break;
+          } catch (error) {
+            if (error instanceof BirdEyeRateLimitError) {
+              const waitMs = (error.retryAfterSeconds ?? 30) * 1000;
+              console.log(`  SOL/USD rate-limited — backing off ${waitMs}ms`);
+              await sleep(waitMs);
+              continue;
+            }
+            throw error;
+          }
+        }
+        cached = { unixTime, value };
+        solUsdCache.set(bucket, cached);
+        await sleep(RATE_LIMIT_DELAY_MS);
       }
```

Verify exact surrounding lines before editing.

### Task 4 — `src/blockchain/transaction-parser.ts:20-28` reorder check before write

```diff
 export function isRapidReversal(trade: ITradeEvent): boolean {
   const key = `${trade.walletAddress}:${trade.tokenMint}`;
   const previous = recentTrades.get(key);
-  recentTrades.set(key, { tradeType: trade.tradeType, blockTime: trade.blockTime });
-
-  if (!previous) return false;
-  const oppositeType = trade.tradeType === "BUY" ? "SELL" : "BUY";
-  if (previous.tradeType !== oppositeType) return false;
-  return Math.abs(trade.blockTime - previous.blockTime) < RAPID_REVERSAL_WINDOW_SEC;
+
+  // Only advance the cache for trades that are newer than the cached entry —
+  // an out-of-order webhook delivery (older blockTime arriving after a newer
+  // one) must not overwrite the newer entry, otherwise the next legitimate
+  // event compares against stale data.
+  if (!previous || trade.blockTime > previous.blockTime) {
+    recentTrades.set(key, { tradeType: trade.tradeType, blockTime: trade.blockTime });
+  }
+
+  if (!previous) return false;
+  const oppositeType = trade.tradeType === "BUY" ? "SELL" : "BUY";
+  if (previous.tradeType !== oppositeType) return false;
+  // Only count as reversal when the new trade is strictly later than the
+  // previous one within the window.
+  if (trade.blockTime <= previous.blockTime) return false;
+  return (trade.blockTime - previous.blockTime) < RAPID_REVERSAL_WINDOW_SEC;
 }
```

### Task 5 — `src/engine/fifo-matcher.ts:48` defensive sort

```diff
 export function matchFifo(trades: RawTrade[]): FifoMatchResult {
+  // Defensive sort: callers are expected to pass time-ordered trades, but
+  // database query order isn't always guaranteed and a single out-of-order
+  // row corrupts FIFO matching. Stable tie-break on type so BUY before SELL
+  // at the same block_time (a same-block buy must enter the queue before
+  // its paired sell consumes it).
+  const sortedTrades = [...trades].sort((a, b) => {
+    if (a.block_time !== b.block_time) return a.block_time - b.block_time;
+    if (a.type === b.type) return 0;
+    return a.type === "BUY" ? -1 : 1;
+  });
   const lotsByPair = new Map<string, { wallet: string; mint: string; lots: Lot[] }>();
   const cycles: ClosedCycle[] = [];
   let unmatched_sells = 0;

-  for (const trade of trades) {
+  for (const trade of sortedTrades) {
```

### Task 6 — `src/engine/scorer.ts:95-98` — SKIP

Do not modify. Add no code change. (Design decision: MEV/wash detection runs on parsed DB trades by design; mixing in raw heliusTxs introduces multi-leg/router noise.)

### Task 7 — `src/engine/scorer.ts:37-84` — DEFER

Do not modify in this batch. Lots-based partial-fill rewrite is a meaningful refactor outside this cleanup loop's scope. Note in plan completion message.

### Task 8 — `src/execution/position-auditor.ts:22-23` use isSanePrice

```diff
+import { isSanePrice } from "./jupiter-client.js";
 // ... existing imports ...

   for (const pos of positions) {
     const violations: string[] = [];

     if (pos.tier === "WATCH") violations.push("WATCH tier position");
-    if (pos.entry_price_usd <= 0 || pos.entry_price_usd > 1e6 || !Number.isFinite(pos.entry_price_usd)) violations.push(`invalid entry price: ${pos.entry_price_usd}`);
-    if (pos.current_price_usd !== null && (!Number.isFinite(pos.current_price_usd) || pos.current_price_usd <= 0 || pos.current_price_usd > 1e6)) violations.push(`invalid current price: ${pos.current_price_usd}`);
+    if (!isSanePrice(pos.entry_price_usd)) violations.push(`invalid entry price: ${pos.entry_price_usd}`);
+    if (pos.current_price_usd !== null && !isSanePrice(pos.current_price_usd)) violations.push(`invalid current price: ${pos.current_price_usd}`);
```

`isSanePrice` is exported at `src/execution/jupiter-client.ts:431` (`export { isSanePrice, isSanePriceChange }`). Use the relative import path `./jupiter-client.js`. Verify path is correct relative to `position-auditor.ts`.

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain ≥ 67/67.
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count. The human handles git.

## Skip / Defer Summary

- Task 6 (`scorer.ts:95-98` unify trades): SKIPPED. DB-trades-only is intentional for MEV/wash detection.
- Task 7 (`scorer.ts:37-84` lots-based partial fills): DEFERRED. Separate refactor outside cleanup loop.

## Stop conditions

- Any task uncovers an unexpected behavioral test failure → stop and report.
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional.
