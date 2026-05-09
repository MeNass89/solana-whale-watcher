# CodeRabbit Review #9 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 15:57:28Z against commit `8be2143`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-9-raw.md` (968 lines).
**Counts:** 5 actionable inline + 1 outside-diff + ~5 duplicates (one re-flagged is real — addressed below).

## Triage

| # | Path | Decision | Reason |
|---|------|----------|--------|
| 1 | `scripts/leaderboard.ts:171-185` + `docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md:78-80` | APPLY | Trades query filters `block_time > cutoff` only, dropping pre-cutoff buys needed to seed FIFO. Sells in-window then become unmatched_sells, undercounting `realized_sol_30d` / `n_closed_30d` and misclassifying `wallet_class`. Fix the SQL to include pre-cutoff BUYs, then update the doc's unmatched-sell section to describe the seeded-inventory approach. |
| 2 | `src/__tests__/fifo-matcher.test.ts` | APPLY | Add two regression tests: (a) non-chronological input → matchFifo sorts before matching, (b) equal `block_time` → preserves input order (stable sort). Guards against the recent tie-break flip-flops. |
| 3 | `src/__tests__/webhook-health.test.ts:22-25,36-45` | APPLY | Replace `expect.any(Array)` with exact-address array assertions so a future bug that passes empty/duplicate addresses is caught. |
| 4 | `src/api/routes/webhooks.ts:39-40` (computePreSellBalance) | APPLY | Helper currently sums ALL persisted BUYs/SELLs for the wallet/mint. If an older SELL is replayed (out-of-order webhook delivery), the sum subtracts a future SELL → negative or wrong pre-sell balance. Add a `beforeBlockTime` cutoff to the helper and pass `trade.blockTime` from the call sites. |
| 5 | `src/execution/trade-executor.ts:191-202` exit accounting | APPLY | After `amountLamports` is computed in BigInt base units, subsequent `price`/`pnlUsd`/`remaining`/`fillSize` calculations still use the original (un-quantized) `sellAmountToken`. They should use the actual quantized amount sent to Jupiter (`Number(total) / 10**decimals`). |
| 6 | `src/blockchain/helius-client.ts:119-135` `getAsset` | APPLY | `getAsset` throws generic `Error` on 429; should throw `HeliusRequestError` with status & retry-after, consistent with `getWalletTransactions` and `searchAssets`. |

**Result:** 6 apply, 0 skip.

## Tasks

### Task 1 — `scripts/leaderboard.ts:171-185` seed FIFO with pre-cutoff buys + update doc

**Code fix:** locate the SQL building `RawTrade[]` for the active wallet set. Modify the WHERE clause to include pre-cutoff BUYs:

```diff
   const trades = db.prepare(
     `SELECT wallet_address, token_mint, trade_type, amount_token, amount_sol, amount_usd, block_time, id
        FROM trades
-       WHERE block_time > ?
+       -- Include pre-cutoff BUYs so in-window SELLs match against pre-window
+       -- inventory; otherwise FIFO drains and sells become unmatched, which
+       -- undercounts realized_sol_30d and misclassifies wallet_class.
+       WHERE (block_time > ? OR (block_time <= ? AND trade_type = 'buy'))
          AND wallet_address IN (SELECT address FROM wallets WHERE active = 1)
        ORDER BY wallet_address, token_mint, block_time, id`
-  ).all(cutoffSec) as RawTrade[];
+  ).all(cutoffSec, cutoffSec) as RawTrade[];
```

Verify the actual SELECT shape and bind logic in the file. The exact column list / ORDER BY must match what's already there; only the WHERE and the bind args change.

If `trade_type` casing differs (e.g., uppercase 'BUY'), match the existing convention. Check via `grep "trade_type" scripts/leaderboard.ts`.

After this change, the cycles produced by `matchFifo` will include cycles whose buy is pre-cutoff — those should still be counted as in-window closes (the SELL is in-window). No change needed in `matchFifo` itself; just the input.

**Doc fix:** update `docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md:78-80` (and the surrounding "unmatched sell" section if any) to describe the seeded-inventory approach:

```markdown
### Pre-cutoff BUY seeding

The 30-day window query selects BUYs from before the cutoff in addition to all
trades after it. This seeds `matchFifo` with the wallet's actual pre-window
inventory so SELLs landing inside the window can match against opens that
predate the cutoff. Without seeding, those SELLs become `unmatched_sells` and
their realized P&L (and the wallet_class signal that depends on it) is lost.

Cycles produced from a pre-cutoff BUY → in-window SELL pair are still counted
as in-window closes — the SELL's `block_time` is what the report attributes
the cycle to.
```

Place where the existing description was, replacing or augmenting any "unmatched sell" handling notes.

### Task 2 — `src/__tests__/fifo-matcher.test.ts` regression tests

Add two tests at the end of the existing matchFifo describe block. Use existing `expectCycle`/`expectOpen` helpers. Skeleton:

```ts
test("matchFifo sorts non-chronological input by block_time before matching", () => {
  // Feed events out-of-order: a SELL appears in the array BEFORE its matching BUY,
  // but with later block_time. Expect a single closed cycle with hold_time_s
  // computed from block_time delta, not array position.
  const trades = [
    { wallet: "w1", mint: "m1", type: "SELL" as const, amount_token: 10, amount_sol: 2, amount_usd: 200, block_time: 200 },
    { wallet: "w1", mint: "m1", type: "BUY" as const,  amount_token: 10, amount_sol: 1, amount_usd: 100, block_time: 100 },
  ];
  const result = matchFifo(trades);
  expect(result.cycles).toHaveLength(1);
  expect(result.cycles[0].hold_time_s).toBe(100);
  expect(result.unmatched_sells).toBe(0);
});

test("matchFifo preserves input order for equal block_time (stable sort)", () => {
  // Two BUYs at the same block_time, then two SELLs at the same later block_time.
  // FIFO should match SELL1 against BUY1 (first BUY in input order), SELL2 against BUY2.
  const trades = [
    { wallet: "w1", mint: "m1", type: "BUY" as const,  amount_token: 5, amount_sol: 1, amount_usd: 100, block_time: 100 },
    { wallet: "w1", mint: "m1", type: "BUY" as const,  amount_token: 5, amount_sol: 2, amount_usd: 200, block_time: 100 },
    { wallet: "w1", mint: "m1", type: "SELL" as const, amount_token: 5, amount_sol: 3, amount_usd: 300, block_time: 200 },
    { wallet: "w1", mint: "m1", type: "SELL" as const, amount_token: 5, amount_sol: 4, amount_usd: 400, block_time: 200 },
  ];
  const result = matchFifo(trades);
  expect(result.cycles).toHaveLength(2);
  // First cycle pairs first SELL with BUY1 (cost_sol=1, proceeds=3), second with BUY2 (cost=2, proceeds=4)
  expect(result.cycles[0].cost_sol).toBeCloseTo(1);
  expect(result.cycles[0].proceeds_sol).toBeCloseTo(3);
  expect(result.cycles[1].cost_sol).toBeCloseTo(2);
  expect(result.cycles[1].proceeds_sol).toBeCloseTo(4);
});
```

Adapt to the actual `RawTrade` type/shape and import paths used in the existing test file. The exact field names (e.g., `tradeType` vs `type`) must match.

### Task 3 — `src/__tests__/webhook-health.test.ts` exact-array assertions

Read the existing tests around lines 22-25 and 36-45. Replace `expect.any(Array)` with the exact addresses from the wallets fixture:

```diff
-    expect(mockUpdateWebhook).toHaveBeenCalledWith("wh1", expect.any(Array), "https://example.com/api/webhooks/helius");
+    expect(mockUpdateWebhook).toHaveBeenCalledWith(
+      "wh1",
+      ["addr1", "addr2"], // exact list from wallets.listActive() fixture
+      "https://example.com/api/webhooks/helius"
+    );
```

Look at the wallets fixture in the test file to determine the exact addresses. Apply the same change to both call sites (~22-25 and ~36-45).

### Task 4 — `src/api/routes/webhooks.ts` cutoff in computePreSellBalance

Add a `beforeBlockTime` parameter to `computePreSellBalance` and use it in the WHERE clause:

```diff
-function computePreSellBalance(db: AppDatabase, walletAddress: string, tokenMint: string): number {
+function computePreSellBalance(
+  db: AppDatabase,
+  walletAddress: string,
+  tokenMint: string,
+  beforeBlockTime: number
+): number {
   const row = db.prepare(`
     SELECT
       COALESCE(SUM(CASE WHEN trade_type = 'BUY' THEN amount_token ELSE 0 END), 0) AS bought,
       COALESCE(SUM(CASE WHEN trade_type = 'SELL' THEN amount_token ELSE 0 END), 0) AS sold
     FROM trades
-    WHERE wallet_address = ? AND token_mint = ?
-  `).get(walletAddress, tokenMint) as { bought: number; sold: number };
+    WHERE wallet_address = ? AND token_mint = ? AND block_time < ?
+  `).get(walletAddress, tokenMint, beforeBlockTime) as { bought: number; sold: number };
   return Math.max(0, row.bought - row.sold);
 }
```

Update both SELL call sites to pass the current trade's `blockTime` (or whatever the inbound webhook payload's timestamp field is named). The cutoff is strict less-than (`<`) so the current trade isn't counted (it hasn't been inserted yet anyway, but `<` makes the contract explicit and robust to insert ordering).

If the trade's timestamp is in seconds vs ms, ensure consistency with the `block_time` column convention.

### Task 5 — `src/execution/trade-executor.ts:191-202` derive actual quantized amount

After computing `total: bigint` (the BigInt base units), derive the actual quantized token amount and use it everywhere downstream:

```diff
       const decimals = Math.max(0, Math.trunc(this.tokenDecimals(current.token_mint)));
+      let actualSellTokenAmount = sellAmountToken;
       const result = await this.swaps.executeSwap({
         inputMint: current.token_mint,
         outputMint: USDC_MINT,
         amountLamports: (() => {
           if (!Number.isFinite(sellAmountToken) || sellAmountToken <= 0) return 1n;
           const scale = 10n ** BigInt(decimals);
           const intPart = BigInt(Math.floor(sellAmountToken));
           const fracPart = sellAmountToken - Math.floor(sellAmountToken);
           const fracBaseUnits = BigInt(Math.floor(fracPart * Number(scale)));
           const total = intPart * scale + fracBaseUnits;
+          // Reflect the quantized base-unit amount back to the caller-scope
+          // variable so price/P&L/remaining calculations match what Jupiter
+          // actually received.
+          actualSellTokenAmount = Number(total) / Number(scale);
           return total < 1n ? 1n : total;
         })(),
         slippageBps,
         isExitSwap: true,
         panicExit,
         tier: convergence.tier
       });
```

Then replace the four downstream usages of `sellAmountToken` (lines around the price/pnl/remaining/fillSize block) with `actualSellTokenAmount`. Read the full block first to identify exact replacements; the IIFE pattern means the assignment to the outer variable must be wired correctly (closures over `let` work fine).

If the variable is `const` further down or used in additional places, make a careful sweep. The intent: every use of `sellAmountToken` AFTER the IIFE must become `actualSellTokenAmount`. The original `sellAmountToken` (the requested amount) is fine to use BEFORE the IIFE for the IIFE's input.

If the closure-via-`let` feels fragile, an alternative is to call the IIFE first into a local `total: bigint`, derive `actualSellTokenAmount` outside the IIFE, then pass `total` as `amountLamports`. Pick whichever yields the smaller diff.

### Task 6 — `src/blockchain/helius-client.ts:119-135` getAsset rate-limit error

Locate `getAsset`. Currently throws generic `Error` for non-OK. Mirror the pattern from `getWalletTransactions`:

```diff
   async getAsset(...): Promise<...> {
     const response = await fetch(...);
     if (!response.ok) {
+      // Surface 429 as a typed HeliusRequestError so callers can back off
+      // instead of treating rate-limit responses as missing data.
+      if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
+        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
+        throw new HeliusRequestError(
+          `helius getAsset failed with status ${response.status}`,
+          response.status,
+          retryAfter
+        );
+      }
       throw new Error(`helius getAsset failed with status ${response.status}`);
     }
     ...
   }
```

Use the existing `HeliusRequestError` class and the existing `parseRetryAfter` helper if present. If `parseRetryAfter` is not in this file, copy the inline parsing pattern from the other site (`getWalletTransactions`). Verify the constructor signature of `HeliusRequestError` before applying.

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain ≥ 68/68 (will likely climb to 70 with the two new fifo-matcher tests).
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

## Skip / Defer Summary

None — all 6 findings applied.

## Stop conditions

- Any task uncovers an unexpected behavioral test failure → stop and report.
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional, DB-trades-only for MEV/wash detection is intentional, atomic mint-reservation deferred (DB unique index already protects integrity), lots-based partial-fill scorer deferred.
