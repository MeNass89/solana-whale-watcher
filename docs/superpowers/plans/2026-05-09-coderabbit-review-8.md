# CodeRabbit Review #8 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 15:49:21Z against commit `8e188f0`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-8-raw.md` (1026 lines).
**Counts:** 6 actionable + ~7 duplicates (already addressed).

## Triage

| # | Path | Decision | Reason |
|---|------|----------|--------|
| 1 | `docs/superpowers/plans/2026-05-06-pnl-leaderboard.md:87-103` | APPLY | Add a `**SUPERSEDED**` note pointing at the FIFO refactor doc. Was skipped in review-7; CodeRabbit re-flagged. One-line note stops the re-flag. |
| 2 | `docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md:36` | APPLY | MD040 lint: add `text` language identifier to two unlabeled fenced blocks. |
| 3 | `scripts/backfill-usd.ts:158-171` | APPLY | Unbounded retry on `BirdEyeRateLimitError` can hang. Add `maxRetries` (e.g., 5) with backoff; throw a clear error after exhausting. |
| 4 | `src/__tests__/dexscreener-client.test.ts:25-28` | APPLY | Test enhancement: also assert `retryAfterSeconds === 2` from the parsed `Retry-After: 2` header. |
| 5 | `src/execution/jupiter-client.ts:195-205` | APPLY | When `BigInt(quote.inAmount) !== params.amountLamports`, currently only logs warn. Reject the quote (throw) before computing fill amounts; mismatched quotes can poison P&L. |
| 6 | `src/execution/risk-engine.ts:84-90` | **SKIP** | Already fixed in commit `8e188f0` (review-7 task 7): hard-fail returns `{ allowed: false, reason: "volatility unknown or outsized" }`. CodeRabbit reviewed stale state. Verified at `risk-engine.ts:88-95`. |

**Result:** 5 apply, 1 skip.

## Tasks

### Task 1 — `docs/superpowers/plans/2026-05-06-pnl-leaderboard.md:87-103` superseded note

Read lines 80-110. Insert a clear superseded note at the top of the section (or as a callout):

```markdown
> **SUPERSEDED:** This (wallet, token_mint) aggregate-cycle plan was replaced by FIFO lot matching. See `src/engine/fifo-matcher.ts` and `docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md`. The implementation tracks per-lot opens/closes/partials rather than netting whole-token positions.
```

Place it directly before the "(wallet, token_mint)" cycle description. Don't rewrite the original — the note is sufficient signal.

### Task 2 — `docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md:36` MD040 fix

Find the two unlabeled fenced code blocks. The first begins around "for each trade in chronological order:"; the second around "fix(leaderboard): FIFO inventory matching for accurate per-cycle PnL". Change `` ``` `` to `` ```text ``:

```diff
-```
+```text
 for each trade in chronological order:
   ...
 ```

-```
+```text
 fix(leaderboard): FIFO inventory matching for accurate per-cycle PnL
 ...
 ```
```

### Task 3 — `scripts/backfill-usd.ts:158-171` bounded retry

Replace the unbounded `while (true)` retry on `getSolUsdAt` with bounded retries + escalating backoff:

```diff
       if (!cached) {
         const unixTime = trade.block_time;
         let value: number | null = null;
-        // eslint-disable-next-line no-constant-condition
-        while (true) {
+        const MAX_RETRIES = 5;
+        let attempt = 0;
+        while (attempt <= MAX_RETRIES) {
           try {
             value = await birdEyeClient.getSolUsdAt(unixTime);
             break;
           } catch (error) {
             if (error instanceof BirdEyeRateLimitError) {
-              const waitMs = (error.retryAfterSeconds ?? 30) * 1000;
+              if (attempt === MAX_RETRIES) {
+                throw new Error(`SOL/USD getSolUsdAt: rate-limited after ${MAX_RETRIES} retries — aborting backfill`);
+              }
+              const baseMs = (error.retryAfterSeconds ?? 30) * 1000;
+              const waitMs = Math.min(baseMs * Math.pow(1.5, attempt), 5 * 60 * 1000);
               console.log(`  SOL/USD rate-limited — backing off ${waitMs}ms`);
               await sleep(waitMs);
+              attempt += 1;
               continue;
             }
             throw error;
           }
         }
```

Verify exact surrounding code shape before applying.

### Task 4 — `src/__tests__/dexscreener-client.test.ts:25-28` add retryAfterSeconds assertion

Locate the existing 429 test. Update so the stub returns `Retry-After: 2`, and the catch block asserts `error.retryAfterSeconds === 2`:

```ts
const fakeFetch = vi.fn().mockResolvedValue(new Response("", {
  status: 429,
  headers: { "retry-after": "2" }
}));
// ... call getTokenPairs, expect throw ...
try {
  await client.getTokenPairs("anymint");
  expect.fail("expected DexScreenerRateLimitError");
} catch (err) {
  expect(err).toBeInstanceOf(DexScreenerRateLimitError);
  expect((err as DexScreenerRateLimitError).retryAfterSeconds).toBe(2);
}
```

Adapt to the actual test framework (vitest is already in use). Reuse the test's existing fetch-stub pattern. Verify `DexScreenerRateLimitError` exposes the field name `retryAfterSeconds` (not `retryAfter`); inspect the class first.

### Task 5 — `src/execution/jupiter-client.ts:195-205` reject mismatched quote

Locate the spot where we already `logger.warn` on `BigInt(quote.inAmount) !== params.amountLamports` (added in review-6 task 8). Replace warn with throw:

```diff
-    if (quote && BigInt(quote.inAmount) !== params.amountLamports) {
-      logger.warn(
-        { inputMint: params.inputMint, requested: params.amountLamports.toString(), quoted: quote.inAmount },
-        "jupiter: quote.inAmount does not match requested amountLamports"
-      );
-    }
+    if (quote && BigInt(quote.inAmount) !== params.amountLamports) {
+      // A mismatched quote means the swap simulation priced a different size
+      // than we requested. Recording the fill against the requested size
+      // would attribute a wrong entry price; rejecting is safer than silent
+      // P&L corruption.
+      throw new Error(
+        `jupiter: quote.inAmount (${quote.inAmount}) does not match requested amountLamports (${params.amountLamports.toString()})`
+      );
+    }
```

Apply at both sites where the warn was added (CodeRabbit notes 195-205, but check 180-183 too — both inputAmount construction sites).

If the warn-only is currently *outside* the duplicate site, only convert the one that gates fill construction. The intent: any path that uses `quote.inAmount`/`outAmount` for the recorded fill must reject if amounts disagree.

### Task 6 — SKIP

Do not modify `risk-engine.ts:84-90`. Already fixed (hard-fail at lines 88-95).

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain ≥ 68/68. The dexscreener test adjustment may shift the count by 0-1.
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

## Skip / Defer Summary

- Task 6 (`risk-engine.ts:84-90`): SKIPPED. Already fixed in review-7 (8e188f0).

## Stop conditions

- Any task uncovers an unexpected behavioral test failure → stop and report.
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional, DB-trades-only for MEV/wash detection is intentional, atomic mint-reservation deferred (DB unique index already protects integrity), lots-based partial-fill scorer deferred.
