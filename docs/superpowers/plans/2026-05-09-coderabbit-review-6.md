# CodeRabbit Review #6 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 15:33:41Z against commit `150a985`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-6-raw.md` (994 lines).
**Counts:** 6 actionable inline + 4 outside-diff + 10 duplicates (already addressed).

## Triage

| # | Path | Decision | Reason |
|---|------|----------|--------|
| 1 | `scripts/backfill-usd.ts:147-153` | APPLY | `solUsdCache` keyed by hour: first trade in an hour seeds the price for all subsequent trades in that hour → iteration-order-dependent backfill amounts. Switch to 5-minute buckets. |
| 2 | `src/blockchain/helius-client.ts:98-105` | APPLY | `getWalletTransactions` treats 401/403 as harmless end-of-pagination (silently truncates results when key expires). Throw `HeliusRequestError` for 401/403 same as 429/5xx. |
| 3 | `src/execution/position-auditor.ts:13-25` | APPLY | LEFT JOIN means positions whose convergence row is missing/orphaned still pass audit. Treat `conv_tier == null` as a violation (quarantine). |
| 4 | `src/execution/trade-executor.ts:52-58` (mint reservation) | **DEFER** | Migration 007's filtered unique index already prevents the DB from going inconsistent on concurrent race; only cost is a wasted paper-swap if races slip past the pre-check. Atomic-reservation refactor is meaningful and outside cleanup-loop scope. Open follow-up. |
| 5 | `src/execution/trade-executor.ts:183-193` | APPLY | `BigInt(Math.round(sellAmountToken))` rounds fractional tokens to whole units BEFORE scaling, losing precision (USDC 0.5 → 1, then ×10^6). Scale to base units in float space, then BigInt. |
| 6 | `src/jobs/co-buyer-scanner.ts:23-30` | APPLY | `find → upsert` race can clobber existing rows. Use single `INSERT … ON CONFLICT DO NOTHING` and check `changes` for created-vs-existed signal. |
| 7 | `src/api/routes/webhooks.ts:47-49,63-68` | APPLY | `estimateSellPct` divides by lifetime buys; correct denominator is pre-sell net holding (`sum(buys) - sum(prior sells)`). Real correctness bug for wallets with prior partial sells. |
| 8 | `src/execution/jupiter-client.ts:180-183` | APPLY | `inputAmount` derived from `quote.inAmount/quote.inputDecimals`; should use authoritative `params.amountLamports`. |
| 9 | `src/execution/jupiter-client.ts:86-92` | APPLY | Hard 3% `priceImpactPct` cap overrides liquidity-tiered slippage (negates MEME-tier 25% intentional design). Compute `allowedImpactPct` from `slippageBpsForLiquidity` per quote. |
| 10 | `src/execution/trade-executor.ts:139-150` | APPLY | `notify(…)` calls inside the durable-write `try` can trip `failExecution`/`recordFailedTransaction` on Discord failure. Move notifies into separate best-effort try/catch after the durable writes. |

**Result:** 9 apply, 1 defer.

## Tasks

### Task 1 — `scripts/backfill-usd.ts:146-154` switch to 5-min buckets

```diff
-      const bucket = Math.floor(trade.block_time / 3600);
+      // 5-minute granularity: hour buckets caused the first trade in an hour
+      // to seed the price for every subsequent trade in that hour, so backfill
+      // amounts depended on insertion order.
+      const bucket = Math.floor(trade.block_time / 300);
       let cached = solUsdCache.get(bucket);
```

If a `BUCKET_SECONDS` constant fits the file's style, define it and use it. Otherwise inline.

### Task 2 — `src/blockchain/helius-client.ts:98-105` 401/403 systemic

Locate the 429/5xx branch in `getWalletTransactions` (around line 98-105 in the new code) and extend to 401/403:

```diff
-      if (response.status === 429 || response.status >= 500) {
+      // 401/403 mean key expired/unauthorized — treating as silent
+      // end-of-pagination would truncate the wallet's recent activity and
+      // poison MEV/wash detection. Throw so the caller can retry/alert.
+      if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
         throw new HeliusRequestError(...)
       }
```

Use the actual HeliusRequestError construction signature already in the file. Verify exact code shape before applying.

### Task 3 — `src/execution/position-auditor.ts` quarantine null convergence

Inside the `for (const pos of positions)` loop, after the existing violation checks:

```diff
   for (const pos of positions) {
     const violations: string[] = [];

     if (pos.tier === "WATCH") violations.push("WATCH tier position");
     if (!isSanePrice(pos.entry_price_usd)) violations.push(`invalid entry price: ${pos.entry_price_usd}`);
     if (pos.current_price_usd !== null && !isSanePrice(pos.current_price_usd)) violations.push(`invalid current price: ${pos.current_price_usd}`);
     if (pos.amount_token <= 0 || pos.amount_token > 1e30 || !Number.isFinite(pos.amount_token)) violations.push(`invalid amount: ${pos.amount_token}`);
     if (pos.wallet_count !== null && pos.wallet_count < 2) violations.push(`convergence had only ${pos.wallet_count} wallet(s)`);
+    // LEFT JOIN can leave conv_tier/wallet_count null when the convergence
+    // row was deleted or never linked. Treat that as no convergence backing.
+    if (pos.conv_tier === null || pos.wallet_count === null) violations.push("no convergence backing (orphaned position)");
```

Verify the field names (`pos.conv_tier`, `pos.wallet_count`, `pos.convergence_id`) match the actual SELECT projection in this file before applying. If `convergence_id` is not selected, add it to the SELECT and the type.

### Task 4 — DEFER

Do not modify `trade-executor.ts:52-58`. Document in plan completion message.

### Task 5 — `src/execution/trade-executor.ts:183-193` BigInt scale-first

Current code rounds the fractional token amount to whole units then scales. Replace with: scale-first using the safest available approach.

Read the surrounding code, then:

```diff
       const result = await this.swaps.executeSwap({
         inputMint: current.token_mint,
         outputMint: USDC_MINT,
-        amountLamports: (() => {
-          const tokenInteger = BigInt(Math.max(1, Math.round(sellAmountToken)));
-          return tokenInteger * (10n ** BigInt(decimals));
-        })(),
+        amountLamports: (() => {
+          // Scale to base units BEFORE rounding so fractional tokens (e.g.
+          // 0.5 USDC) preserve their value through the conversion. We still
+          // floor() at the end for an integer base-unit count.
+          const scale = 10 ** decimals;
+          const baseUnitsFloat = sellAmountToken * scale;
+          if (!Number.isFinite(baseUnitsFloat) || baseUnitsFloat < 1) {
+            return 1n;
+          }
+          // For high-decimal tokens with large balances, baseUnitsFloat can
+          // exceed Number.MAX_SAFE_INTEGER; route through BigInt-from-string
+          // via toFixed(0) to avoid the silent float truncation.
+          return BigInt(Math.floor(baseUnitsFloat).toString());
+        })(),
```

NOTE: `Math.floor(baseUnitsFloat).toString()` still passes through Number, so for very large amounts this *can* still truncate. If existing tests cover token-decimals=18 + large balances, ensure they pass; if not, this is an acceptable improvement over the prior round-then-scale.

If a stricter approach is needed for high-decimal tokens, split the integer/fractional parts: `const intPart = BigInt(Math.floor(sellAmountToken)); const fracPart = sellAmountToken - Math.floor(sellAmountToken); const fracBaseUnits = BigInt(Math.floor(fracPart * scale)); return intPart * (10n ** BigInt(decimals)) + fracBaseUnits;` — apply this if and only if integration tests need it.

Pick the simpler version unless test failure forces the split.

### Task 6 — `src/jobs/co-buyer-scanner.ts:23-30` atomic insert

Read the current find→upsert pattern. Replace with a single statement:

```ts
// Atomic insert: ON CONFLICT DO NOTHING means concurrent scanners don't
// clobber each other's records. The `changes` count tells us if we actually
// inserted (1) or hit an existing row (0), which we need for the inserted
// counter.
const insertCoBuyer = db.prepare(`
  INSERT INTO wallets (address, source, state, score, ...) VALUES (?, 'co-buyer', 'NEW', 0, ...)
  ON CONFLICT(address) DO NOTHING
`);
// inside the loop:
const result = insertCoBuyer.run(row.wallet_address, ...);
if (result.changes > 0) inserted += 1;
```

Read the actual existing wallets schema and current upsert call to construct the exact INSERT correctly. The columns must match `wallets`. Probably easier: extend the existing `WalletModel.upsert` with a new `insertIfMissing` method, or call the existing `upsert` if it already uses ON CONFLICT — check first.

If `WalletModel.upsert` already uses `ON CONFLICT(address) DO UPDATE`, the issue is the UPDATE clobbers existing fields. The fix is `ON CONFLICT(address) DO NOTHING` for the co-buyer path specifically.

Best path: add a new method `WalletModel.insertIfMissing(address, source, state)` that uses `INSERT ... ON CONFLICT(address) DO NOTHING`, returns boolean (inserted?), and use it from `co-buyer-scanner.ts`. Then drop the find→upsert two-step.

### Task 7 — `src/api/routes/webhooks.ts:47-49,63-68` pre-sell balance

Locate `estimateSellPct` calls in the SELL handling blocks (line 47-49 and 63-68). Replace with a `computePreSellBalance(walletAddress, tokenMint)` helper that returns `sum(amount_token) WHERE trade_type = 'BUY'` minus `sum(amount_token) WHERE trade_type = 'SELL'` over rows BEFORE the current trade (i.e. exclude the row being inserted, or query before insert).

```ts
function computePreSellBalance(db: AppDatabase, walletAddress: string, tokenMint: string): number {
  // Net holding: cumulative buys minus cumulative sells, excluding the
  // current trade (call this BEFORE inserting the new row).
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN trade_type = 'BUY' THEN amount_token ELSE 0 END), 0) AS bought,
      COALESCE(SUM(CASE WHEN trade_type = 'SELL' THEN amount_token ELSE 0 END), 0) AS sold
    FROM trades WHERE wallet_address = ? AND token_mint = ?
  `).get(walletAddress, tokenMint) as { bought: number; sold: number };
  return Math.max(0, row.bought - row.sold);
}
```

In the SELL block:
```diff
-const sellPct = estimateSellPct(...);
+const preSellBalance = computePreSellBalance(db, trade.walletAddress, trade.tokenMint);
+const sellPct = preSellBalance > 0 ? (trade.amountToken / preSellBalance) * 100 : 0;
+// Insert trade row AFTER this calculation to avoid double-counting.
```

Apply to both SELL handling blocks. Verify the existing `estimateSellPct` definition and remove it if no other callers remain.

If `estimateSellPct` is exported and used elsewhere, leave it but don't call it from the webhook handlers — replace with the new helper.

### Task 8 — `src/execution/jupiter-client.ts:180-183` and ~194-208 inputAmount

```diff
-    const inputAmount = quote
-      ? await this.rawAmountToUi(params.inputMint, BigInt(quote.inAmount), quote.inputDecimals)
-      : await this.rawAmountToUi(params.inputMint, params.amountLamports);
+    // Use the authoritative caller-supplied amount, not the quote echo.
+    // If the quote disagrees, the swap simulation can be wrong but the
+    // recorded fill should still match what we actually requested.
+    const inputAmount = await this.rawAmountToUi(params.inputMint, params.amountLamports, quote?.inputDecimals);
+    if (quote && BigInt(quote.inAmount) !== params.amountLamports) {
+      logger.warn(
+        { inputMint: params.inputMint, requested: params.amountLamports.toString(), quoted: quote.inAmount },
+        "jupiter: quote.inAmount does not match requested amountLamports"
+      );
+    }
```

Apply to both the paper and live result construction sites (CodeRabbit notes lines 180-183 and the nearby block ~194-208). Verify `rawAmountToUi` signature accepts a third `decimals` param; if not, fall back to the two-arg form and let it look up decimals.

### Task 9 — `src/execution/jupiter-client.ts:86-92` dynamic price-impact cap

The hard 3% cap negates MEME-tier 25% slippage. Replace with liquidity-tiered cap.

```diff
-    const MAX_PRICE_IMPACT_PCT = 3;
-    if (Number(quote.priceImpactPct) > MAX_PRICE_IMPACT_PCT) { ... reject ... }
+    // Use liquidity-tiered slippage as the price-impact ceiling so MEME-tier
+    // 25% slippage actually allows MEME-tier 25% impact. Fall back to 3%
+    // when liquidity is unknown (preserves prior conservative ceiling).
+    const slippageBps = slippageBpsForLiquidity(liquidityUsd);
+    const allowedImpactPct = slippageBps != null ? slippageBps / 100 : 3;
+    if (Number(quote.priceImpactPct) > allowedImpactPct) { ... reject ... }
```

Verify `slippageBpsForLiquidity` is in scope at this site (or import it from `src/config/thresholds.ts`). Verify `liquidityUsd` is available — it's likely a method param or fetched from a TVL helper. If not available at this site, defer this task with a note (the scope creeps to plumbing TVL into executeSwap).

If `liquidityUsd` is **not** plumbed into `executeSwap`, the minimal change is: accept an optional `liquidityUsd?: number` param and have callers pass it. If callers already compute TVL upstream (risk-engine), wire it through.

If wiring TVL is too invasive, the alternative is to use the pre-call slippageBps tier passed in via `params.slippageBps` and convert that to pct. That's likely simpler:

```diff
-    const MAX_PRICE_IMPACT_PCT = 3;
+    const allowedImpactPct = params.slippageBps != null ? params.slippageBps / 100 : 3;
```

Use this simpler approach unless `params.slippageBps` is unavailable.

### Task 10 — `src/execution/trade-executor.ts:139-150` notify outside try

Move `notify(…)` and `notifyPositionExit(…)` calls from inside the swap/state-write try into a separate try/catch AFTER the durable writes succeed:

```diff
-    try {
-      await fillExecution(...);
-      await updatePaperBalance(...);
-      notify("ENTRY_FILLED", ...);  // <-- this can throw and trip catch below
-    } catch (error) {
-      failExecution(...);
-      risk.recordFailedTransaction(...);
-    }
+    try {
+      await fillExecution(...);
+      await updatePaperBalance(...);
+    } catch (error) {
+      failExecution(...);
+      risk.recordFailedTransaction(...);
+      throw error;
+    }
+    // Notifications are best-effort: a Discord failure must not flip a
+    // completed trade to FAILED.
+    try {
+      notify("ENTRY_FILLED", ...);
+    } catch (notifyErr) {
+      logger.warn({ err: notifyErr }, "trade-executor: notify failed (non-fatal)");
+    }
```

Apply the same pattern to `notifyPositionExit` site. Read the current code shape before applying — the actual function structure may differ from this skeleton.

If the notify call is currently `await`ed and the surrounding function returns early after, move the notify after all critical writes complete; if it's fire-and-forget already, just confirm and add the try/catch wrapper.

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain ≥ 67/67. Watch for tests touching:
   - jupiter-client price-impact (task 9)
   - trade-executor exits (tasks 5, 10)
   - webhook SELL handling (task 7)
   - position-auditor (task 3)
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

## Skip / Defer Summary

- Task 4 (atomic mint reservation in trade-executor): DEFERRED. Migration 007 unique index already protects DB integrity; only cost of race is a wasted paper-swap. Atomic-reservation refactor is meaningful work outside cleanup loop scope.

## Stop conditions

- Any task uncovers an unexpected behavioral test failure → stop and report.
- If task 9 (`liquidityUsd` plumbing) requires significant cross-file changes, defer it instead.
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional (and task 9 ensures it's actually honored), DB-trades-only for MEV/wash detection is intentional.
