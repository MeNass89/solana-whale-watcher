**Actionable comments posted: 5**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (1)</summary><blockquote>
> 
> <details>
> <summary>src/blockchain/helius-client.ts (1)</summary><blockquote>
> 
> `119-135`: _⚠️ Potential issue_ | _🟠 Major_ | _💤 Low value_
> 
> **`getAsset` must throw a specific rate-limit error on 429 responses instead of a generic `Error`.**
> 
> Line 131 throws generically for all non-OK responses. This breaks the retry pattern used elsewhere in the codebase: `DexScreenerRateLimitError`, `BirdEyeRateLimitError`, and even Helius's own `searchAssets` method (line 102) all distinguish 429s to signal "back off and retry." 
> 
> More critically, `getAsset` is called in a tight loop in `token-metadata.ts:40` (enriching multiple tokens). When a 429 hits, the generic error surfaces as a logging failure (`token-metadata.ts:42`) with no backoff. This creates a cascade risk: repeated calls hammer the rate limit, polluting logs, and can fail entire token enrichment batches.
> 
> Throw `DexScreenerRateLimitError`-style (or a Helius equivalent) with `retry-after` from response headers so callers can implement proper backoff. Alternately, handle 429 inside `getAsset` with exponential backoff.
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/blockchain/helius-client.ts` around lines 119 - 135, The getAsset method
> currently throws a generic Error for all non-OK responses; update getAsset to
> detect a 429 response and throw a rate-limit-specific error (consistent with
> existing patterns like DexScreenerRateLimitError/BirdEyeRateLimitError and
> similar handling in searchAssets) instead of the generic Error, extracting the
> Retry-After value from response.headers.get("retry-after") (parse to a
> number/Date or include raw header) and include it on the thrown rate-limit error
> so callers can back off; keep the existing generic error behavior for other
> non-OK statuses.
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>♻️ Duplicate comments (12)</summary><blockquote>

<details>
<summary>src/execution/jupiter-client.ts (1)</summary><blockquote>

`195-213`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Quote amount mismatch still only warns — should reject.**

Lines 196-201 log a warning when `quote.inAmount !== params.amountLamports` but execution proceeds. The paper position will record `inputAmount` derived from `params.amountLamports` and `outputAmount` from the mismatched quote, creating an inconsistent fill price that poisons P&L tracking.

<details>
<summary>Suggested fix</summary>

```diff
     const inputAmount = await this.rawAmountToUi(params.inputMint, params.amountLamports, quote?.inputDecimals);
     if (quote && BigInt(quote.inAmount) !== params.amountLamports) {
       logger.warn(
         { inputMint: params.inputMint, requested: params.amountLamports.toString(), quoted: quote.inAmount },
-        "jupiter: quote.inAmount does not match requested amountLamports"
+        "jupiter: quote.inAmount does not match requested amountLamports; falling back to price estimation"
       );
+      quote = null; // Force fallback path to maintain consistency
     }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/jupiter-client.ts` around lines 195 - 213, The code currently
only warns when quote.inAmount != params.amountLamports but continues, which can
produce inconsistent paper fills; update the logic in the block around
rawAmountToUi / quote handling (where quote, quote.inAmount,
params.amountLamports, inputAmount, outputAmount and fallbackOutputAmount are
used) to treat a mismatch as a hard failure: after logging the mismatch via
logger.warn, throw an Error (or otherwise abort the operation) so execution
stops instead of using the mismatched quote; ensure the error message clearly
references the quote mismatch and include the mismatched values for debugging.
```

</details>

</blockquote></details>
<details>
<summary>scripts/leaderboard.ts (1)</summary><blockquote>

`171-185`: _⚠️ Potential issue_ | _🟠 Major_

**Seed FIFO with pre-window inventory before scoring the 30-day window.**

Line 181 still drops all buys before `cutoff`, so any sell inside the window that closes older inventory is treated as `unmatched_sells` and never contributes to `realized_sol`, `n_closed`, `wins`, `wallet_class`, or prune decisions. This will systematically undercount realized P&L for long-held positions.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/leaderboard.ts` around lines 171 - 185, The query currently filters
out all trades with block_time <= cutoff, which drops pre-window buys needed to
seed FIFO matching and causes sells inside the window to be treated as
unmatched_sells; modify the SQL in the trades preparation (the SELECT that
builds RawTrade[] in leaderboard.ts) to include pre-cutoff buy trades as well as
all trades after cutoff — e.g. change the WHERE to something like "WHERE
(block_time > ? OR (block_time <= ? AND trade_type = 'buy')) AND wallet_address
IN (SELECT address FROM wallets WHERE active = 1)" so FIFO inventory is seeded
correctly while keeping the ORDER BY wallet_address, token_mint, block_time, id
intact and pass cutoff twice when calling .all(...).
```

</details>

</blockquote></details>
<details>
<summary>src/engine/scorer.ts (2)</summary><blockquote>

`91-98`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Manipulation demotion is still running on a different dataset than P&L/activity.**

`buildPositions()` and `swapCount` include `heliusTxs`, but `computeHoldTimes()` and `detectWashTrading()` only inspect persisted `trades`. When ingestion lags, the same wallet can score as normal on one pass and flip to `DEMOTED` on the next without any new on-chain behavior. Feed the MEV/wash scan from the same unified fills used for the rest of `computeWalletMetrics`.  
  

As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 91 - 98, computeHoldTimes() and
detectWashTrading() are reading only persisted trades while buildPositions(),
swapCount and the rest of computeWalletMetrics use heliusTxs + trades, causing
inconsistent demotion results when ingestion lags; update computeHoldTimes() and
detectWashTrading() (or the call sites in computeWalletMetrics) to accept and
use the unified fills dataset (merge heliusTxs with trades the same way
buildPositions() does) so the MEV/wash detection operates on the identical input
as buildPositions()/swapCount, ensuring consistent scoring across live and
backtest paths and avoiding flip-flop demotions.
```

</details>

---

`37-53`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**The MEV/wash matcher is still row-based, not quantity-based.**

Both helpers remove an entire `BUY` row on the first `SELL` for that mint. A tiny partial exit against a large buy now looks like a full round-trip, which can collapse `medianHoldTimeSec` and inflate the wash ratio. Match remaining token quantity per lot, or reuse the FIFO lot logic from `src/engine/fifo-matcher.ts`, so partial exits only close the matched size.  
  

As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.


Also applies to: 65-83

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 37 - 53, computeHoldTimes currently treats
each BUY row as an atomic lot and removes an entire BUY on the first SELL for a
token mint, so partial sells are treated as full round-trips; update
computeHoldTimes to perform quantity-aware FIFO matching (track remaining
quantity per buy lot and only remove a buy when its remaining size hits zero) or
reuse the FIFO lot logic from src/engine/fifo-matcher.ts (e.g., the same lot
struct and consumeLot/advance logic) so each SELL reduces buy lots by matched
size and only pushes holdTimes for the actual matched quantity/time slices;
ensure you handle multiple sells that span buys, preserve chronological ordering
(sorted by block_time) and compute hold time per matched quantity slice before
returning the aggregated holdTimes array.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/dexscreener-client.ts (1)</summary><blockquote>

`44-68`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Transport and parse failures are still collapsed into the “no pairs” path.**

`429` and `5xx` are now distinct, but network timeouts, invalid JSON, unexpected `4xx`, and non-array payloads still return `[]`. Downstream liquidity checks still cannot tell “token has no market” from “DexScreener is unavailable”, so partial outages can quietly fall through to stale or zero-liquidity logic. Reserve `[]` for confirmed empty pair lists only, and surface these branches as a distinct failure mode too.  
  

As per coding guidelines, `src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals).

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/dexscreener-client.ts` around lines 44 - 68, The current
getTokenPairs flow collapses transport timeouts, parse failures, unexpected 4xx
and non-array payloads into returning [] — change those branches to surface
distinct failures: in the outer fetch catch (where logger.warn currently returns
[]), throw a new DexScreenerUnavailableError (or reuse a network/unavailable
error) instead of returning []; for response.status not OK (except 404) where
you now log and return [], throw a DexScreenerApiError containing status and
body metadata; in the JSON.parse catch, throw a DexScreenerParseError (include
the raw text/err) instead of returning []; keep returning [] only for explicit
404 and for a successfully parsed empty array; add the new error classes (e.g.,
DexScreenerUnavailableError, DexScreenerApiError, DexScreenerParseError) and
update callers of getTokenPairs to handle these exceptions distinctly from "no
pairs". Ensure logger calls still include error details (use error instanceof
Error ? error : new Error(String(error))).
```

</details>

</blockquote></details>
<details>
<summary>scripts/backfill-usd.ts (1)</summary><blockquote>

`158-171`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**Unbounded retry loop can hang indefinitely on persistent rate-limiting.**

The `while (true)` loop retries `getSolUsdAt` forever on repeated 429s. If BirdEye is down or persistently rate-limiting, this script hangs until killed. Add a max retry limit.





<details>
<summary>Suggested fix</summary>

```diff
+        const MAX_RETRIES = 5;
+        let retries = 0;
         // eslint-disable-next-line no-constant-condition
-        while (true) {
+        while (retries < MAX_RETRIES) {
           try {
             value = await birdEyeClient.getSolUsdAt(unixTime);
             break;
           } catch (error) {
             if (error instanceof BirdEyeRateLimitError) {
               const waitMs = (error.retryAfterSeconds ?? 30) * 1000;
               console.log(`  SOL/USD rate-limited — backing off ${waitMs}ms`);
               await sleep(waitMs);
+              retries += 1;
               continue;
             }
             throw error;
           }
         }
+        if (retries >= MAX_RETRIES) {
+          stillNull.push({ id: trade.id, mint: trade.token_mint, reason: `${reason}; SOL/USD max retries exceeded` });
+          continue;
+        }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/backfill-usd.ts` around lines 158 - 171, The retry loop around
birdEyeClient.getSolUsdAt(unixTime) currently uses while(true) and can hang on
persistent BirdEyeRateLimitError; add a max retry counter (e.g., maxRetries) and
increment a retry variable inside the catch for BirdEyeRateLimitError, breaking
and rethrowing (or returning a clear failure) when retries exceed the limit,
while preserving the existing backoff logic using sleep; update any callers
expecting a value from this loop to handle the error/undefined result from
exceeding retries.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-manager.ts (2)</summary><blockquote>

`340-350`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Portfolio loss cap still measures only the current position, not aggregate drawdown.**

`checkDollarStop` computes unrealized loss for `position` alone (line 341) and compares it to total portfolio value. If you have three open positions each down ~1.5% of NAV, aggregate drawdown is 4.5%, but this guard never fires because no single position crosses the 3% threshold.

To protect NAV, sum unrealized losses across all `OPEN`/`PARTIAL` positions before evaluating `MAX_DOLLAR_LOSS_PORTFOLIO_PCT`.





As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute.

<details>
<summary>Suggested fix</summary>

```diff
 private async checkDollarStop(position: PositionRow, priceUsd: number): Promise<boolean> {
-  const unrealizedLoss = position.amount_token * (position.entry_price_usd - priceUsd);
-  if (unrealizedLoss <= 0) return false;
+  // Aggregate unrealized loss across ALL open/partial positions
+  const db = this.requireDb();
+  const openPositions = db.prepare(
+    `SELECT id, amount_token, entry_price_usd, COALESCE(current_price_usd, entry_price_usd) AS current_price_usd
+     FROM positions WHERE status IN ('OPEN','PARTIAL')`
+  ).all() as Array<{ id: number; amount_token: number; entry_price_usd: number; current_price_usd: number }>;
+
+  let totalUnrealizedLoss = 0;
+  for (const pos of openPositions) {
+    const currentPrice = pos.id === position.id ? priceUsd : pos.current_price_usd;
+    const loss = pos.amount_token * (pos.entry_price_usd - currentPrice);
+    if (loss > 0) totalUnrealizedLoss += loss;
+  }
+  if (totalUnrealizedLoss <= 0) return false;
+
   const portfolioValue = this.portfolioValueUsd();
   if (portfolioValue <= 0) return false;
-  if ((unrealizedLoss / portfolioValue) * 100 >= MAX_DOLLAR_LOSS_PORTFOLIO_PCT) {
-    await this.exit(position, "DOLLAR_LOSS_CAP", 100, true);
+  if ((totalUnrealizedLoss / portfolioValue) * 100 >= MAX_DOLLAR_LOSS_PORTFOLIO_PCT) {
+    // Exit ALL open positions when aggregate loss cap is breached
+    for (const pos of this.listOpen()) {
+      await this.exit(pos, "DOLLAR_LOSS_CAP", 100, true);
+    }
     return true;
   }
   return false;
 }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 340 - 350, checkDollarStop
currently measures unrealized loss only for the single PositionRow passed in
(unrealizedLoss) and compares it to portfolioValueUsd, which misses aggregate
drawdown across OPEN/PARTIAL positions; modify checkDollarStop to compute
totalUnrealizedLoss by summing (amount_token * (entry_price_usd - currentPrice))
for all positions with state OPEN or PARTIAL (use the existing positions
collection or query the same source used elsewhere), then compare
(totalUnrealizedLoss / this.portfolioValueUsd())*100 against
MAX_DOLLAR_LOSS_PORTFOLIO_PCT and call this.exit(position, "DOLLAR_LOSS_CAP",
100, true) if the threshold is exceeded; ensure PositionRow,
portfolioValueUsd(), checkDollarStop and exit are the only symbols changed and
keep the per-position early return logic only for non-loss cases.
```

</details>

---

`75-80`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Whale-sell filtering silently skips trust check when `wallets` is null.**

When `this.wallets` is not configured (line 77 defaults to `null`), `onWhaleSell` at lines 197-203 skips the wallet-class filter entirely. Sells from wallets that would be classified as `loser` or `accumulation_bot` will trigger exits anyway.

If this is intentional degradation, document it. If whale-sell exits should require wallet classification data, fail closed by logging and returning early when `wallets` is null.





As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute.


Also applies to: 197-203

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 75 - 80, The whale-sell path
currently skips wallet-class filtering when this.wallets is null; update
onWhaleSell to fail closed by checking this.wallets and refusing to process
whale sells if wallet classification is unavailable: inside the onWhaleSell
handler (method onWhaleSell) add an early guard that logs an explicit error via
the existing logger and returns without executing exits when this.wallets is
null (or alternatively make configure require wallets and throw if input.wallets
is undefined); reference the configure method and this.wallets to locate the
configuration point and the onWhaleSell method to implement the guard so
whale-sell exits never run without wallet classification data.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/convergence.ts (1)</summary><blockquote>

`55-56`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Don’t reapply the global threshold inside the narrow-window check.**

`threshold` is the base convergence gate. Using `Math.max(threshold, getMinWalletsForTier(tier))` at Line 175 makes the 30m/60m validation stricter than the tier definition itself, so a valid 3-wallet `CRITICAL` signal gets downgraded whenever `getThreshold(...) > 3`.





<details>
<summary>💡 Proposed fix</summary>

```diff
-let tier = pickTier(score, uniqueWallets.size);
-tier = validateTierWindow(tier, score, recentBuys, windowSeconds, threshold);
+let tier = pickTier(score, uniqueWallets.size);
+tier = validateTierWindow(tier, score, recentBuys, windowSeconds);
@@
-      tier = validateTierWindow(boosted, scoreForTier(boosted), recentBuys, windowSeconds, threshold);
+      tier = validateTierWindow(boosted, scoreForTier(boosted), recentBuys, windowSeconds);
@@
 function validateTierWindow(
   candidate: ConvergenceTier,
   score: number,
   recentBuys: TradeRow[],
-  windowSeconds: number,
-  threshold: number
+  windowSeconds: number
 ): ConvergenceTier {
@@
-    if (tierWallets.size >= Math.max(threshold, getMinWalletsForTier(tier))) return tier;
+    if (tierWallets.size >= getMinWalletsForTier(tier)) return tier;
```
</details>

As per coding guidelines, `src/engine/**`: "Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths."


Also applies to: 84-88, 155-176

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/convergence.ts` around lines 55 - 56, The validateTierWindow call
is reapplying the global threshold (via Math.max(threshold,
getMinWalletsForTier(tier))) which tightens the 30m/60m window checks beyond the
tier definition and downgrades valid signals; update validateTierWindow (and any
places using Math.max(threshold, getMinWalletsForTier(tier))) to compare
recentBuys against the tier-specific minimum only (use
getMinWalletsForTier(tier)) instead of combining with the global threshold so
the narrow-window validation matches pickTier's definition; search for usages in
pickTier, validateTierWindow and getThreshold/getMinWalletsForTier and remove
the global-threshold override in those window checks.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/risk-engine.ts (1)</summary><blockquote>

`162-173`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Null SOL pricing still falls back silently to 1%.**

Thrown pricing failures are surfaced now, but Line 172 still collapses `getPriceUsd(SOL_MINT) === null` into `MIRROR_FALLBACK_PCT` with no warning. `getPriceUsd()` already uses `null` for unavailable/insane pricing, so this can size a live entry off a synthetic 1% path without any operator signal.





<details>
<summary>💡 Proposed fix</summary>

```diff
-    if (!solPriceUsd || solPriceUsd <= 0) return MIRROR_FALLBACK_PCT;
+    if (!solPriceUsd || solPriceUsd <= 0) {
+      logger.warn(
+        { trades: trades.length, portfolioValueUsd },
+        "risk-engine: SOL/USD price unavailable for mirror sizing"
+      );
+      throw new Error("SOL/USD price unavailable for mirror sizing");
+    }
```
</details>

As per coding guidelines, `src/execution/**`: "Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/risk-engine.ts` around lines 162 - 173, The code treats a null
SOL price from jupiterClient.getPriceUsd as a silent fallback to
MIRROR_FALLBACK_PCT; update the logic around solPriceUsd (result of
jupiterClient.getPriceUsd(SOL_MINT)) to explicitly detect solPriceUsd === null
or solPriceUsd <= 0, emit a logger.warn (including err/context like
trades.length and portfolioValueUsd and that we're using MIRROR_FALLBACK_PCT),
and only then return MIRROR_FALLBACK_PCT; keep the existing catch behavior for
thrown errors but ensure null/invalid prices are logged before returning.
```

</details>

</blockquote></details>
<details>
<summary>docs/superpowers/plans/2026-05-06-pnl-leaderboard.md (1)</summary><blockquote>

`87-103`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**Update this plan to describe FIFO, not token-level netting.**

Lines 89-103 still document aggregate cycle netting, but the shipped leaderboard logic uses FIFO lot matching. That changes realized P&L, win-rate, hold-time, and partial-close behavior for re-entries, so this plan now misstates the algorithm.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-06-pnl-leaderboard.md` around lines 87 - 103,
The plan currently describes token-level netting for cycle aggregation (grouping
by (wallet, token_mint) and computing CLOSED/OPEN/PARTIAL cycles and metrics
like realized_sol, realized_usd, wins, win_rate, avg_hold_time_s, locked_sol),
but the shipped leaderboard uses FIFO lot matching; update the document to
replace the token-netting algorithm with FIFO lot-based logic: describe
iterating trades per wallet and token_mint in chronological order, creating buy
lots and matching sells against oldest remaining buy lots (first-in-first-out),
compute realized P&L and hold time per matched lot (accumulate into
realized_sol/realized_usd, wins counting per matched lot where sell>buy,
win_rate over matched-close lots), handle partial fills by splitting lots
(affecting partial-close and re-entry behavior), compute locked_sol as sum of
unmatched buy lot sizes, and report n_closed/n_open/n_partial based on lot
states rather than token-level aggregates; reference the existing metric names
(realized_sol, realized_usd, wins, win_rate, avg_hold_time_s, locked_sol,
n_closed, n_open, n_partial) so the wording maps to implemented FIFO logic.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/trade-executor.ts (1)</summary><blockquote>

`52-58`: _⚠️ Potential issue_ | _🔴 Critical_ | _🏗️ Heavy lift_

**Reserve the mint before the external BUY.**

This is still a TOCTOU check. Two workers can both clear Line 55, both execute the BUY, and then one loses when the position write happens later. By that point `fillExecution()` and `updatePaperBalance()` have already run, so you can end up with a failed execution record, cash debited, and no active position for a real buy.





As per coding guidelines, `src/execution/**`: "Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/trade-executor.ts` around lines 52 - 58, This is a TOCTOU race:
before performing the external BUY you must atomically reserve the mint to
prevent concurrent workers from proceeding; use requireDb() to create an
explicit reservation step (e.g., insert a reservation row or insert a positions
row with status='RESERVED' under a unique constraint on token_mint or use a
transactional SELECT ... FOR UPDATE) immediately after checking
convergence.token_mint and before calling the external BUY, then only perform
fillExecution() and updatePaperBalance() after the BUY succeeds and you
transition the reserved row to an OPEN/PARTIAL position; ensure you clean up the
reservation on any BUY failure so you don't leak reserved mints.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md`:
- Around line 78-80: The current logic throws away sells whose matching buys
predate the 30-day cutoff (after FIFO drains), which undercounts
realized_sol_30d and n_closed_30d and can misclassify wallet_class; instead,
modify the unmatched-sell handling so that when FIFO has no in-window buys you
either (A) seed inventory/cost-basis from pre-cutoff history and consume that
cost basis to record the close, or (B) mark the sell as
"opened_before_window_closed_in_window" and still increment realized_sol_30d and
n_closed_30d using carried opening metadata; update the selling path that runs
post-FIFO-drain (the unmatched sell branch) to implement one of these approaches
and ensure realized_sol_30d, n_closed_30d and wallet_class calculations use the
carried or seeded cost-basis.

In `@src/__tests__/fifo-matcher.test.ts`:
- Around line 52-234: Add two tests to the matchFifo suite to guard against
regressions: one that feeds events in non-chronological order to verify
matchFifo sorts by block_time before matching, and another that feeds multiple
events with identical block_time to verify it preserves the original input order
(stable sort) when creating cycles and open lots; reference matchFifo and the
existing expectCycle/expectOpen helpers to assert identical realized P&L,
hold_time_s, closed_at and remaining open lot ordering so any change to sorting
or tie-break behavior will fail the test.

In `@src/__tests__/webhook-health.test.ts`:
- Around line 22-25: The test currently asserts mockUpdateWebhook was called
with expect.any(Array) which allows empty, duplicate, or stale addresses; change
the assertion to assert the exact expected payload array (the precise healed
webhook addresses based on the wallets fixture) when calling
checkWebhookHealth(helius, "wh1", "https://example.com/api/webhooks/helius",
discord, wallets) so the test fails on regressions — replace expect.any(Array)
with the exact array literal of addresses you expect (and do the same for the
other case around lines 36-45) referencing mockUpdateWebhook and
checkWebhookHealth so the test pins the exact heal payload.

In `@src/api/routes/webhooks.ts`:
- Around line 39-40: computePreSellBalance currently sums all persisted BUY/SELL
for a wallet/mint causing older SELL replays to subtract future sells; change
computePreSellBalance to accept a cutoff (e.g., cutoffTimestamp or
beforeTradeId) and modify its DB query to only include trades with created_at
(or sequence) strictly less than the current trade's timestamp/sequence; update
the SELL call sites (the preSellBalance calculation for trade.tradeType ===
"SELL" and the other occurrence around the sell handling) to pass
trade.created_at (or trade.id/sequence) as the cutoff so only prior trades are
summed.

In `@src/execution/trade-executor.ts`:
- Around line 191-202: The computation floors sellAmountToken to base units into
amountLamports/total but downstream calculations (price, P&L, fill size,
remaining) still use the original sellAmountToken; update the code that computes
price, realized P&L, fillSize and remaining (the block that currently
reads/derives from sellAmountToken after amountLamports is computed) to instead
derive the actual quantized token amount from the base-unit total (e.g.,
actualFilledToken = Number(total) / Number(10n ** BigInt(decimals)) or
equivalent safe conversion) and use that quantized value for all subsequent
calculations so accounting reflects what was actually sent to Jupiter.

---

Outside diff comments:
In `@src/blockchain/helius-client.ts`:
- Around line 119-135: The getAsset method currently throws a generic Error for
all non-OK responses; update getAsset to detect a 429 response and throw a
rate-limit-specific error (consistent with existing patterns like
DexScreenerRateLimitError/BirdEyeRateLimitError and similar handling in
searchAssets) instead of the generic Error, extracting the Retry-After value
from response.headers.get("retry-after") (parse to a number/Date or include raw
header) and include it on the thrown rate-limit error so callers can back off;
keep the existing generic error behavior for other non-OK statuses.

---

Duplicate comments:
In `@docs/superpowers/plans/2026-05-06-pnl-leaderboard.md`:
- Around line 87-103: The plan currently describes token-level netting for cycle
aggregation (grouping by (wallet, token_mint) and computing CLOSED/OPEN/PARTIAL
cycles and metrics like realized_sol, realized_usd, wins, win_rate,
avg_hold_time_s, locked_sol), but the shipped leaderboard uses FIFO lot
matching; update the document to replace the token-netting algorithm with FIFO
lot-based logic: describe iterating trades per wallet and token_mint in
chronological order, creating buy lots and matching sells against oldest
remaining buy lots (first-in-first-out), compute realized P&L and hold time per
matched lot (accumulate into realized_sol/realized_usd, wins counting per
matched lot where sell>buy, win_rate over matched-close lots), handle partial
fills by splitting lots (affecting partial-close and re-entry behavior), compute
locked_sol as sum of unmatched buy lot sizes, and report
n_closed/n_open/n_partial based on lot states rather than token-level
aggregates; reference the existing metric names (realized_sol, realized_usd,
wins, win_rate, avg_hold_time_s, locked_sol, n_closed, n_open, n_partial) so the
wording maps to implemented FIFO logic.

In `@scripts/backfill-usd.ts`:
- Around line 158-171: The retry loop around birdEyeClient.getSolUsdAt(unixTime)
currently uses while(true) and can hang on persistent BirdEyeRateLimitError; add
a max retry counter (e.g., maxRetries) and increment a retry variable inside the
catch for BirdEyeRateLimitError, breaking and rethrowing (or returning a clear
failure) when retries exceed the limit, while preserving the existing backoff
logic using sleep; update any callers expecting a value from this loop to handle
the error/undefined result from exceeding retries.

In `@scripts/leaderboard.ts`:
- Around line 171-185: The query currently filters out all trades with
block_time <= cutoff, which drops pre-window buys needed to seed FIFO matching
and causes sells inside the window to be treated as unmatched_sells; modify the
SQL in the trades preparation (the SELECT that builds RawTrade[] in
leaderboard.ts) to include pre-cutoff buy trades as well as all trades after
cutoff — e.g. change the WHERE to something like "WHERE (block_time > ? OR
(block_time <= ? AND trade_type = 'buy')) AND wallet_address IN (SELECT address
FROM wallets WHERE active = 1)" so FIFO inventory is seeded correctly while
keeping the ORDER BY wallet_address, token_mint, block_time, id intact and pass
cutoff twice when calling .all(...).

In `@src/blockchain/dexscreener-client.ts`:
- Around line 44-68: The current getTokenPairs flow collapses transport
timeouts, parse failures, unexpected 4xx and non-array payloads into returning
[] — change those branches to surface distinct failures: in the outer fetch
catch (where logger.warn currently returns []), throw a new
DexScreenerUnavailableError (or reuse a network/unavailable error) instead of
returning []; for response.status not OK (except 404) where you now log and
return [], throw a DexScreenerApiError containing status and body metadata; in
the JSON.parse catch, throw a DexScreenerParseError (include the raw text/err)
instead of returning []; keep returning [] only for explicit 404 and for a
successfully parsed empty array; add the new error classes (e.g.,
DexScreenerUnavailableError, DexScreenerApiError, DexScreenerParseError) and
update callers of getTokenPairs to handle these exceptions distinctly from "no
pairs". Ensure logger calls still include error details (use error instanceof
Error ? error : new Error(String(error))).

In `@src/engine/convergence.ts`:
- Around line 55-56: The validateTierWindow call is reapplying the global
threshold (via Math.max(threshold, getMinWalletsForTier(tier))) which tightens
the 30m/60m window checks beyond the tier definition and downgrades valid
signals; update validateTierWindow (and any places using Math.max(threshold,
getMinWalletsForTier(tier))) to compare recentBuys against the tier-specific
minimum only (use getMinWalletsForTier(tier)) instead of combining with the
global threshold so the narrow-window validation matches pickTier's definition;
search for usages in pickTier, validateTierWindow and
getThreshold/getMinWalletsForTier and remove the global-threshold override in
those window checks.

In `@src/engine/scorer.ts`:
- Around line 91-98: computeHoldTimes() and detectWashTrading() are reading only
persisted trades while buildPositions(), swapCount and the rest of
computeWalletMetrics use heliusTxs + trades, causing inconsistent demotion
results when ingestion lags; update computeHoldTimes() and detectWashTrading()
(or the call sites in computeWalletMetrics) to accept and use the unified fills
dataset (merge heliusTxs with trades the same way buildPositions() does) so the
MEV/wash detection operates on the identical input as
buildPositions()/swapCount, ensuring consistent scoring across live and backtest
paths and avoiding flip-flop demotions.
- Around line 37-53: computeHoldTimes currently treats each BUY row as an atomic
lot and removes an entire BUY on the first SELL for a token mint, so partial
sells are treated as full round-trips; update computeHoldTimes to perform
quantity-aware FIFO matching (track remaining quantity per buy lot and only
remove a buy when its remaining size hits zero) or reuse the FIFO lot logic from
src/engine/fifo-matcher.ts (e.g., the same lot struct and consumeLot/advance
logic) so each SELL reduces buy lots by matched size and only pushes holdTimes
for the actual matched quantity/time slices; ensure you handle multiple sells
that span buys, preserve chronological ordering (sorted by block_time) and
compute hold time per matched quantity slice before returning the aggregated
holdTimes array.

In `@src/execution/jupiter-client.ts`:
- Around line 195-213: The code currently only warns when quote.inAmount !=
params.amountLamports but continues, which can produce inconsistent paper fills;
update the logic in the block around rawAmountToUi / quote handling (where
quote, quote.inAmount, params.amountLamports, inputAmount, outputAmount and
fallbackOutputAmount are used) to treat a mismatch as a hard failure: after
logging the mismatch via logger.warn, throw an Error (or otherwise abort the
operation) so execution stops instead of using the mismatched quote; ensure the
error message clearly references the quote mismatch and include the mismatched
values for debugging.

In `@src/execution/position-manager.ts`:
- Around line 340-350: checkDollarStop currently measures unrealized loss only
for the single PositionRow passed in (unrealizedLoss) and compares it to
portfolioValueUsd, which misses aggregate drawdown across OPEN/PARTIAL
positions; modify checkDollarStop to compute totalUnrealizedLoss by summing
(amount_token * (entry_price_usd - currentPrice)) for all positions with state
OPEN or PARTIAL (use the existing positions collection or query the same source
used elsewhere), then compare (totalUnrealizedLoss /
this.portfolioValueUsd())*100 against MAX_DOLLAR_LOSS_PORTFOLIO_PCT and call
this.exit(position, "DOLLAR_LOSS_CAP", 100, true) if the threshold is exceeded;
ensure PositionRow, portfolioValueUsd(), checkDollarStop and exit are the only
symbols changed and keep the per-position early return logic only for non-loss
cases.
- Around line 75-80: The whale-sell path currently skips wallet-class filtering
when this.wallets is null; update onWhaleSell to fail closed by checking
this.wallets and refusing to process whale sells if wallet classification is
unavailable: inside the onWhaleSell handler (method onWhaleSell) add an early
guard that logs an explicit error via the existing logger and returns without
executing exits when this.wallets is null (or alternatively make configure
require wallets and throw if input.wallets is undefined); reference the
configure method and this.wallets to locate the configuration point and the
onWhaleSell method to implement the guard so whale-sell exits never run without
wallet classification data.

In `@src/execution/risk-engine.ts`:
- Around line 162-173: The code treats a null SOL price from
jupiterClient.getPriceUsd as a silent fallback to MIRROR_FALLBACK_PCT; update
the logic around solPriceUsd (result of jupiterClient.getPriceUsd(SOL_MINT)) to
explicitly detect solPriceUsd === null or solPriceUsd <= 0, emit a logger.warn
(including err/context like trades.length and portfolioValueUsd and that we're
using MIRROR_FALLBACK_PCT), and only then return MIRROR_FALLBACK_PCT; keep the
existing catch behavior for thrown errors but ensure null/invalid prices are
logged before returning.

In `@src/execution/trade-executor.ts`:
- Around line 52-58: This is a TOCTOU race: before performing the external BUY
you must atomically reserve the mint to prevent concurrent workers from
proceeding; use requireDb() to create an explicit reservation step (e.g., insert
a reservation row or insert a positions row with status='RESERVED' under a
unique constraint on token_mint or use a transactional SELECT ... FOR UPDATE)
immediately after checking convergence.token_mint and before calling the
external BUY, then only perform fillExecution() and updatePaperBalance() after
the BUY succeeds and you transition the reserved row to an OPEN/PARTIAL
position; ensure you clean up the reservation on any BUY failure so you don't
leak reserved mints.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: Path: .coderabbit.yaml

**Review profile**: ASSERTIVE

**Plan**: Pro Plus

**Run ID**: `cf568c67-2fae-4fef-aaa4-d815e1dc3d6b`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and 8e188f03f995b914d2a8d6a1cb6b2604f387e5ea.

</details>

<details>
<summary>📒 Files selected for processing (68)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `docs/audit-report.md`
* `docs/superpowers/plans/2026-05-04-safety-gates-fix.md`
* `docs/superpowers/plans/2026-05-04-whale-watcher-pro-upgrade.md`
* `docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md`
* `docs/superpowers/plans/2026-05-06-pnl-leaderboard.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-3.md`
* `docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md`
* `scripts/backfill-usd.ts`
* `scripts/dryrun-whale-sell.ts`
* `scripts/leaderboard.ts`
* `scripts/start-funnel.sh`
* `src/__tests__/birdeye-client.test.ts`
* `src/__tests__/co-buyer-scanner.test.ts`
* `src/__tests__/convergence-quality-gate.test.ts`
* `src/__tests__/dexscreener-client.test.ts`
* `src/__tests__/fifo-matcher.test.ts`
* `src/__tests__/leaderboard-script.test.ts`
* `src/__tests__/mev-filter.test.ts`
* `src/__tests__/position-auditor.test.ts`
* `src/__tests__/price-sanity.test.ts`
* `src/__tests__/risk-engine-safety.test.ts`
* `src/__tests__/slippage-tiers.test.ts`
* `src/__tests__/threshold-tiers.test.ts`
* `src/__tests__/threshold.test.ts`
* `src/__tests__/trade-executor-dedup.test.ts`
* `src/__tests__/webhook-health.test.ts`
* `src/api/middleware/hmac.ts`
* `src/api/routes/webhooks.ts`
* `src/api/server.ts`
* `src/blockchain/birdeye-client.ts`
* `src/blockchain/dexscreener-client.ts`
* `src/blockchain/helius-client.ts`
* `src/blockchain/transaction-parser.ts`
* `src/config/index.ts`
* `src/config/thresholds.ts`
* `src/engine/convergence.ts`
* `src/engine/fifo-matcher.ts`
* `src/engine/manipulation-detector.ts`
* `src/engine/scorer.ts`
* `src/execution/jupiter-client.ts`
* `src/execution/position-auditor.ts`
* `src/execution/position-manager.ts`
* `src/execution/risk-engine.ts`
* `src/execution/trade-executor.ts`
* `src/frontend/components/ConvergenceCard.tsx`
* `src/frontend/components/StatusBadge.tsx`
* `src/frontend/components/WalletTable.tsx`
* `src/frontend/hooks/useSSE.ts`
* `src/frontend/pages/History.tsx`
* `src/frontend/pages/Settings.tsx`
* `src/frontend/pages/Wallets.tsx`
* `src/index.ts`
* `src/jobs/catchup.ts`
* `src/jobs/cleanup.ts`
* `src/jobs/co-buyer-scanner.ts`
* `src/jobs/leaderboard-refresh.ts`
* `src/jobs/token-metadata.ts`
* `src/jobs/wallet-scorer.ts`
* `src/jobs/webhook-health.ts`
* `src/storage/database.ts`
* `src/storage/migrations/004_wallet_pnl_tracking.sql`
* `src/storage/migrations/005_co_buyer_index.sql`
* `src/storage/migrations/006_co_buyer_index_covering.sql`
* `src/storage/migrations/007_positions_active_unique.sql`
* `src/storage/models/wallets.ts`
* `src/utils/retry.ts`

</details>

<details>
<summary>💤 Files with no reviewable changes (12)</summary>

* src/frontend/components/WalletTable.tsx
* src/jobs/token-metadata.ts
* src/frontend/components/StatusBadge.tsx
* src/utils/retry.ts
* src/frontend/pages/History.tsx
* src/frontend/pages/Settings.tsx
* src/jobs/cleanup.ts
* src/frontend/pages/Wallets.tsx
* src/frontend/components/ConvergenceCard.tsx
* src/jobs/catchup.ts
* src/frontend/hooks/useSSE.ts
* .env.example

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
