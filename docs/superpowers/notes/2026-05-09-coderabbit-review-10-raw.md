**Actionable comments posted: 8**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (1)</summary><blockquote>
> 
> <details>
> <summary>src/engine/convergence.ts (1)</summary><blockquote>
> 
> `34-41`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **Anchor convergence windows to trade time, not wall clock.**
> 
> The base lookback and `validateTierWindow()` still derive their cutoffs from `Date.now()`. Replaying the same historical trade set later will therefore change which wallets are considered “recent,” which changes threshold/tier outcomes for identical data. Use the incoming trade batch’s timestamp as the reference clock for both `since` and `tierSince`.
> 
> 
> 
> 
> As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.
> 
> 
> Also applies to: 155-181
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/engine/convergence.ts` around lines 34 - 41, The convergence window is
> anchored to Date.now() causing different results when replaying historical
> trades; switch the reference to the incoming trade's timestamp instead: compute
> the lookback cutoff (used by since passed into
> this.trades.findByTokenInWindow(newTrade.tokenMint, ...)) from
> newTrade.timestamp (converted to the same epoch units as stored trades) minus
> windowSeconds, and do the same for the tier cutoff used by validateTierWindow so
> both since and tierSince use the trade's timestamp rather than wall clock;
> ensure unit consistency (ms vs s) and reuse the same reference value when
> calling getThreshold/validateTierWindow to avoid off-by-one/window divergence
> between live and backtest paths.
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
<summary>src/execution/position-auditor.ts (1)</summary><blockquote>

`22-29`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Check the backing convergence tier, not `positions.tier`.**

Line 22 audits `pos.tier`, but this query already fetched `c.tier AS conv_tier`. A position whose row says `NOTABLE` can still be backed by a `WATCH` convergence and slip through startup quarantine, leaving invalid P&L state live.

<details>
<summary>Minimal fix</summary>

```diff
-    if (pos.tier === "WATCH") violations.push("WATCH tier position");
+    if (pos.conv_tier === "WATCH") violations.push("WATCH tier position");
```
</details>

  
As per coding guidelines, "`src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-auditor.ts` around lines 22 - 29, The audit currently
checks the position's own tier (pos.tier) but must check the backing convergence
tier (pos.conv_tier); update the condition that pushes "WATCH tier position" to
use pos.conv_tier (and treat null appropriately), e.g. replace the pos.tier
check with a conv_tier check and ensure the existing orphan check for
pos.conv_tier === null remains correct so positions backed by a WATCH
convergence are quarantined; adjust the condition near the
violations.push("WATCH tier position") and related checks that reference
pos.tier/pos.conv_tier to use the convergence tier consistently.
```

</details>

</blockquote></details>
<details>
<summary>src/api/routes/webhooks.ts (1)</summary><blockquote>

`39-40`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Bound `preSellBalance` to trades before this SELL.**

The new DB-backed `sellPct` still sums every persisted SELL for the wallet/mint. If an older SELL is replayed after a newer one is already stored, `preSellBalance` subtracts that future exit too, so `sellPct` shrinks/overshoots and `onWhaleSell()` receives the wrong exit size.

<details>
<summary>Minimal fix</summary>

```diff
       const preSellBalance = trade.tradeType === "SELL"
-        ? computePreSellBalance(deps.db, trade.walletAddress, trade.tokenMint)
+        ? computePreSellBalance(deps.db, trade.walletAddress, trade.tokenMint, trade.blockTime)
         : 0;
@@
-function computePreSellBalance(db: AppDatabase, walletAddress: string, tokenMint: string): number {
+function computePreSellBalance(db: AppDatabase, walletAddress: string, tokenMint: string, blockTime: number): number {
   const row = db
     .prepare(
       `SELECT
         COALESCE(SUM(CASE WHEN trade_type = 'BUY' THEN amount_token ELSE 0 END), 0) AS bought,
         COALESCE(SUM(CASE WHEN trade_type = 'SELL' THEN amount_token ELSE 0 END), 0) AS sold
        FROM trades
-       WHERE wallet_address = ? AND token_mint = ?`
+       WHERE wallet_address = ? AND token_mint = ? AND block_time < ?`
     )
-    .get(walletAddress, tokenMint) as { bought: number; sold: number };
+    .get(walletAddress, tokenMint, blockTime) as { bought: number; sold: number };
   return Math.max(0, row.bought - row.sold);
 }
```
</details>

  


Also applies to: 68-78

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/api/routes/webhooks.ts` around lines 39 - 40, preSellBalance is currently
computed by summing all persisted SELLs for the wallet/mint which can include
SELLs that occurred after the current trade, causing sellPct and onWhaleSell()
to be wrong; fix this by changing computePreSellBalance to accept a cutoff
(e.g., trade.timestamp or trade.id) and have it only sum SELLs with timestamp/id
strictly less than the current trade, then call computePreSellBalance(deps.db,
trade.walletAddress, trade.tokenMint, trade.timestamp) (and update the other
occurrences around the 68-78 block similarly) so preSellBalance is bound to
trades before this SELL.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/trade-executor.ts (2)</summary><blockquote>

`191-229`: _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

**Exit accounting still uses the pre-quantized token amount.**

`amountLamports` is correctly floored to base units, but `exitPrice`, `pnlUsd`, the filled `amountToken`, and `remaining` are still derived from `sellAmountToken`. Fractional exits will therefore overstate what was actually sold and drift both realized P&L and residual balances.

<details>
<summary>Proposed fix</summary>

```diff
       const decimals = Math.max(0, Math.trunc(this.tokenDecimals(current.token_mint)));
+      const scale = 10n ** BigInt(decimals);
+      const amountLamports = (() => {
+        if (!Number.isFinite(sellAmountToken) || sellAmountToken <= 0) return 1n;
+        const flooredTokenAmount = Math.floor(sellAmountToken);
+        const intPart = BigInt(flooredTokenAmount);
+        const fracPart = sellAmountToken - flooredTokenAmount;
+        const fracBaseUnits = BigInt(Math.floor(fracPart * Number(scale)));
+        const total = intPart * scale + fracBaseUnits;
+        return total < 1n ? 1n : total;
+      })();
+      const actualSellAmountToken =
+        Number(amountLamports / scale) + Number(amountLamports % scale) / 10 ** decimals;
       const result = await this.swaps.executeSwap({
         inputMint: current.token_mint,
         outputMint: USDC_MINT,
-        amountLamports: (() => {
-          // Split integer/fractional parts so high-decimal tokens with large
-          // balances don't lose integer precision via float scaling.
-          if (!Number.isFinite(sellAmountToken) || sellAmountToken <= 0) return 1n;
-          const scale = 10n ** BigInt(decimals);
-          const flooredTokenAmount = Math.floor(sellAmountToken);
-          const intPart = BigInt(flooredTokenAmount);
-          const fracPart = sellAmountToken - flooredTokenAmount;
-          const fracBaseUnits = BigInt(Math.floor(fracPart * Number(scale)));
-          const total = intPart * scale + fracBaseUnits;
-          return total < 1n ? 1n : total;
-        })(),
+        amountLamports,
         slippageBps,
         isExitSwap: true,
         panicExit,
         tier: current.tier
       });
@@
-      const exitPrice = sellAmountToken > 0 ? exitUsd / sellAmountToken : priceUsd;
-      const pnlUsd = sellAmountToken * (exitPrice - current.entry_price_usd);
+      const exitPrice = actualSellAmountToken > 0 ? exitUsd / actualSellAmountToken : priceUsd;
+      const pnlUsd = actualSellAmountToken * (exitPrice - current.entry_price_usd);
@@
-        amountToken: sellAmountToken,
+        amountToken: actualSellAmountToken,
@@
-      const remaining = Math.max(0, current.amount_token - sellAmountToken);
+      const remaining = Math.max(0, current.amount_token - actualSellAmountToken);
```
</details>

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/trade-executor.ts` around lines 191 - 229, The code calculates
amountLamports correctly but continues to use the original floating
sellAmountToken for post-trade accounting; change the post-trade math to use the
quantized sold token amount derived from amountLamports (the IIFE that computes
amountLamports) converted back to token units using the same scale (10n **
BigInt(decimals)). Use that quantizedTokenSold for exitPrice (exitUsd /
quantizedTokenSold), pnlUsd, pnlPct, pass quantizedTokenSold to fillExecution as
amountToken, and subtract quantizedTokenSold from current.amount_token for
remaining; keep the 1n minimum behavior from the amountLamports IIFE and ensure
conversion uses the same scale variable so decimals are handled consistently.
```

</details>

---

`52-58`: _⚠️ Potential issue_ | _🔴 Critical_ | _🏗️ Heavy lift_

**This open-position check is still racy.**

Two workers can both observe "no OPEN/PARTIAL row", both execute the BUY, and only diverge after the external swap. At that point execution rows, paper balance, and position state can already be inconsistent. The mint needs to be claimed atomically in the DB *before* `executeSwap()`.

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/trade-executor.ts` around lines 52 - 58, The current check
using requireDb().prepare(...).get(...) and returning if existingPosition is
racy because two workers can both see no OPEN/PARTIAL row and proceed to
executeSwap(); fix by atomically claiming the mint in the DB before calling
executeSwap(): inside a DB transaction create/insert a new row (e.g.,
status='PENDING' or similar) for convergence.token_mint or update an existing
row only if none with status IN ('OPEN','PARTIAL') exists, using an INSERT ...
ON CONFLICT/UPSERT or a SELECT...FOR UPDATE/UPDATE-with-condition so the claim
is serialized; if the insert/update fails because another worker claimed it, log
and return, and ensure you roll back or delete the PENDING row if executeSwap()
fails so position state and balances remain consistent.
```

</details>

</blockquote></details>
<details>
<summary>scripts/backfill-usd.ts (1)</summary><blockquote>

`149-176`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**The 5-minute SOL/USD cache is still order-dependent.**

The key is a 5-minute bucket, but the fetched quote is still anchored to the *first* trade's exact `block_time`. Every later trade in that bucket reuses that first timestamp's price, so `amount_usd` still depends on iteration order. Fetch/store by a deterministic timestamp for the bucket, or key the cache by exact `block_time`.

<details>
<summary>Proposed fix</summary>

```diff
       const bucket = Math.floor(trade.block_time / 300);
       let cached = solUsdCache.get(bucket);
       if (!cached) {
-        const unixTime = trade.block_time;
+        const unixTime = bucket * 300;
         let value: number | null = null;
         const MAX_RETRIES = 5;
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/backfill-usd.ts` around lines 149 - 176, The SOL/USD caching is
order-dependent because you call getSolUsdAt(trade.block_time) and store the
first trade's exact block_time in solUsdCache under a 5-minute bucket; instead
compute a deterministic bucket timestamp (e.g., bucketStart = bucket * 300 or
Math.floor(trade.block_time/300)*300) and use that bucketStart when calling
birdEyeClient.getSolUsdAt(...) and when storing cached = { unixTime:
bucketStart, value }, so every trade in the same 5-minute bucket uses the same
deterministic timestamp; update the code around solUsdCache.get(bucket), the
getSolUsdAt call, and the cached assignment to use this bucketStart instead of
trade.block_time.
```

</details>

</blockquote></details>
<details>
<summary>src/__tests__/webhook-health.test.ts (1)</summary><blockquote>

`22-25`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**Assert the healed address list exactly.**

`expect.any(Array)` still lets these tests pass if the job re-enables with `[]`, stale addresses, or duplicates. Pin the payload to the exact expected list so the heal-path regression is actually covered.  
  

<details>
<summary>Suggested fix</summary>

```diff
-    expect(mockUpdateWebhook).toHaveBeenCalledWith("wh1", expect.any(Array), "https://example.com/api/webhooks/helius");
+    expect(mockUpdateWebhook).toHaveBeenCalledWith("wh1", ["addr1"], "https://example.com/api/webhooks/helius");
@@
-    expect(mockUpdateWebhook).toHaveBeenCalledWith("wh1", expect.any(Array), "https://example.com/api/webhooks/helius");
+    expect(mockUpdateWebhook).toHaveBeenCalledWith("wh1", ["addr1"], "https://example.com/api/webhooks/helius");
@@
-    expect(mockUpdateWebhook).toHaveBeenCalledWith("wh1", expect.any(Array), "https://example.com/api/webhooks/helius");
+    expect(mockUpdateWebhook).toHaveBeenCalledWith("wh1", ["addr1"], "https://example.com/api/webhooks/helius");
```
</details>


Also applies to: 36-45

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/__tests__/webhook-health.test.ts` around lines 22 - 25, The test uses a
loose matcher expect.any(Array) for the update payload which allows
incorrect/healed address lists to slip; update the assertion in the test for
checkWebhookHealth to assert the exact expected array of addresses (no empty
array, no duplicates, no stale entries) passed to mockUpdateWebhook (replace
expect.any(Array) with the concrete list you expect, e.g., the wallets array or
the healed addresses), and make the matching change in the sibling test block
mentioned (lines 36-45) as well so both tests validate the precise payload.
```

</details>

</blockquote></details>
<details>
<summary>src/index.ts (1)</summary><blockquote>

`37-44`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Close Fastify before tearing down SQLite on SIGTERM/SIGINT.**

`shutdown()` still exits after `db.close()` without ever awaiting `app.close()`, so a signal can cut off in-flight webhook/API work instead of draining it cleanly. Make shutdown async, close the server first, then stop background cleanup and close the DB.  
  

<details>
<summary>Suggested fix</summary>

```diff
-  const shutdown = (signal: string) => {
+  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
+  const shutdown = async (signal: string) => {
     logger.info(signal);
+    await app?.close();
     stopRecentTradesCleanup();
     db.close();
     process.exit(0);
   };
-  process.on("SIGTERM", () => shutdown("SIGTERM"));
-  process.on("SIGINT", () => shutdown("SIGINT"));
+  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
+  process.on("SIGINT", () => { void shutdown("SIGINT"); });
@@
-  const app = await buildServer({ db, wallets, trades, convergences, engine, alerts });
+  app = await buildServer({ db, wallets, trades, convergences, engine, alerts });
```
</details>


Also applies to: 146-149

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 37 - 44, The shutdown flow in shutdown() must be
made async and should await Fastify's graceful close before tearing down other
resources: change shutdown to async, await app.close() (or
app.close().catch(...)) first, then stopRecentTradesCleanup(), then await
db.close() if it returns a Promise (or call it after app is closed), and only
call process.exit(0) after all awaited closes complete; update the two
process.on handlers (SIGTERM/SIGINT and the duplicate at lines ~146-149) to call
the async shutdown and not prematurely exit.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/scorer.ts (2)</summary><blockquote>

`37-54`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Partial sells still count as full round-trips.**

Both matchers still `shift()` an entire BUY row as soon as any SELL for that mint appears. A tiny trim can therefore generate a full hold-time sample and a full wash-trade round-trip, which artificially lowers `medianHoldTimeSec` and inflates the wash fraction. Track remaining token quantity per lot instead of consuming whole rows.





As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.


Also applies to: 65-84

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 37 - 54, computeHoldTimes (and the similar
matcher around lines 65-84) currently treats a BUY row as consumed entirely on
the first matching SELL by using queue.shift(), causing partial sells to be
counted as full round-trips; change the matching to maintain per-lot remaining
quantity for each buy (e.g., store objects with {row: TradeRow, remainingQty:
number}) and when a SELL arrives decrement remainingQty across queued buys
(possibly consuming a buy fully and shifting only when remainingQty === 0),
emitting hold-time samples for the actual quantity matched (or weighting
hold-times by matched quantity) instead of for the entire BUY row so partial
fills produce proportional hold-time entries and correct wash/median
calculations.
```

</details>

---

`91-98`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**MEV/wash scoring still ignores Helius-only swaps.**

`buildPositions()` and `totalTrades` incorporate `heliusTxs`, but `computeHoldTimes()` and `detectWashTrading()` only scan persisted `trades`. During ingestion lag, the same wallet can score clean in this pass and then flip to MEV/wash later once SQLite catches up. Run the manipulation scan over the same normalized fill set used for the rest of the wallet metrics.





As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 91 - 98, The MEV/wash detection currently
only analyzes persisted trades while positions and totalTrades include
heliusTxs; update computeHoldTimes and detectWashTrading to run over the same
normalized fill set used by buildPositions (i.e., merge/normalize heliusTxs into
the trades-like fills and pass that combined array instead of `trades`), and
ensure totalTrades calculation remains consistent (you can keep swapCount logic
but base hold-time and wash detection on the unified fills); reference
functions: buildPositions, computeHoldTimes, detectWashTrading, and variables:
heliusTxs, trades, totalTrades, medianHoldTime, MEV_HOLD_TIME_THRESHOLD_SEC.
```

</details>

</blockquote></details>
<details>
<summary>scripts/leaderboard.ts (1)</summary><blockquote>

`171-185`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Seed FIFO with opening inventory before the cutoff.**

Filtering to `block_time > cutoff` before `matchFifo(...)` still drops the cost basis for sells that close inventory opened before the 30-day window. Those sells fall into `unmatched_sells`, so `realized_sol`, `n_closed`, and the `wallet_class` written back to `wallets` all skew low for active wallets. Query enough history to seed opening lots, or snapshot pre-window inventory before folding the in-window trades.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/leaderboard.ts` around lines 171 - 185, The SQL currently restricts
the trades variable to block_time > cutoff which loses pre-window opening lots
needed by matchFifo(...) and causes sells that close pre-window inventory to
appear in unmatched_sells and undercount realized_sol, n_closed and
wallet_class; fix by expanding the query fed into trades to also include
historical trades needed to seed FIFO (e.g. include trades with block_time <=
cutoff for the same wallet_address/token_mint or fetch a pre-window inventory
snapshot) so matchFifo(...) has opening lots available; update the code that
writes wallet_class back to wallets (and any uses of unmatched_sells,
realized_sol, n_closed) to derive final metrics only after running matchFifo
with the seeded history.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-manager.ts (2)</summary><blockquote>

`340-360`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Portfolio loss cap still measures one position at a time.**

`checkDollarStop()` divides the current position’s unrealized loss by total NAV. Multiple OPEN/PARTIAL positions can jointly breach the 3% portfolio cap while every per-position check stays below it, so the portfolio guard never fires. Sum unrealized losses across all active positions, using `priceUsd` for the row currently being updated.





As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 340 - 360, checkDollarStop
currently measures only the single position's unrealized loss; update it to
compute the aggregated unrealized loss across all OPEN/PARTIAL positions and
compare that sum to NAV so the portfolio cap can trigger when multiple positions
together breach the limit. Use this.requireDb() to query all positions (fields:
id, amount_token, entry_price_usd, current_price_usd) and sum max(0,
amount_token * (entry_price_usd - price)) where price is priceUsd for the
PositionRow being checked (match by id) and COALESCE(current_price_usd,
entry_price_usd) for others; keep using portfolioValueUsd() for NAV and
MAX_DOLLAR_LOSS_PORTFOLIO_PCT for the threshold, and call this.exit(position,
"DOLLAR_LOSS_CAP", 100, true) when the aggregated percent >= cap. Ensure you
still return boolean and do not modify other behavior in portfolioValueUsd().
```

</details>

---

`75-78`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Do not fail open on whale-sell trust checks.**

If `configure()` omits `wallets`, `onWhaleSell()` skips the quality gate and will exit on any qualifying seller, including wallets already classified as `loser` or `accumulation_bot`. In the execution path this should require `wallets`, or defer whale-sell exits until classifications are available.





As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.


Also applies to: 193-203

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 75 - 78, The configure method
currently defaults wallets to null which lets onWhaleSell “fail open” when
wallets are omitted; change configure (method configure and the instance
property wallets: WalletModel) to require or explicitly keep wallets
undefined/unset if not provided, and update onWhaleSell to guard for absence of
wallets or missing classifications before exiting—i.e., if this.wallets is falsy
or the seller’s classification (loser/accumulation_bot) is not yet available, do
NOT perform the immediate exit and instead defer/skip the whale-sell action
until wallets/classifications are present; ensure all checks reference the
WalletModel lookups used elsewhere and cover the alternative execution path
noted around onWhaleSell (lines ~193-203).
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
In `@docs/superpowers/plans/2026-05-04-safety-gates-fix.md`:
- Around line 466-476: Replace the hard-coded local path and service label with
repo-relative and placeholder-friendly commands: instead of "cd
/Users/nassimlecornet/Projects/solana-whale-watcher" use a repo-root invocation
(e.g., run "npx vitest run" and "npx tsc --noEmit" from the repository root or
via npm scripts), and replace the launchctl call "launchctl kickstart -k
gui/$(id -u)/com.nassim.whale-watcher" with a templated placeholder such as
"launchctl kickstart -k gui/$(id -u)/<SERVICE_LABEL>" (or a note to use the
platform-appropriate service command), so the lines containing "npx vitest run",
"npx tsc --noEmit", the cd command, and the launchctl invocation are made
repo-agnostic and contributor-friendly.

In `@src/blockchain/birdeye-client.ts`:
- Around line 142-145: The current computation in birdeye-client.ts synthesizes
an artificial cost basis by using invested = totalBuy > 0 ? totalBuy : 1 which
yields wildly misleading totalPnlPercent; instead, detect when totalBuy === 0
and return a safe sentinel (e.g., null) for totalPnlPercent rather than
performing the division. Update the return path that sets totalPnlPercent
(referencing totalBuy, totalPnl, and invested) so that if totalBuy is zero you
assign the sentinel, otherwise compute (totalPnl / totalBuy) * 100.

In `@src/blockchain/dexscreener-client.ts`:
- Around line 44-58: The code in getTokenPairs currently swallows transport,
timeout, JSON/schema and unexpected 4xx errors by returning [] which hides
transient failures from callers (like getBestPair); instead, modify
getTokenPairs to throw distinct transient/client errors for non-OK conditions
and catch blocks. Specifically: in the catch block around the fetch/parse,
rethrow or wrap the exception as a DexScreenerTransientError (include original
error info) rather than returning []; for response.status handling, keep 429
(throw DexScreenerRateLimitError) and 500+ (throw DexScreenerServerError) and
404 (return []), but change the generic !response.ok branch (and any other
unexpected 4xx) to throw a DexScreenerClientError or DexScreenerTransientError
with status and headers instead of returning []; update any related handling
around lines 61-67 similarly so callers can distinguish "no pairs" from
transient failures.

In `@src/blockchain/helius-client.ts`:
- Around line 98-106: The pagination loop in getWalletTransactions currently
treats most 4xx responses as a pagination end (break), which can silently
truncate history; change the logic to throw a HeliusRequestError for any 4xx
response other than 404 so callers can surface/retry/log the failure.
Concretely, update the response handling that currently checks response.status
and calls logger.warn/break: keep throwing for 429, 401, 403 and >=500 as-is,
but also throw for any response.status >=400 && <500 except when status === 404
(which may still be treated as end-of-history); only allow the existing
logger.warn + break path for the explicit 404 case. Use HeliusRequestError when
throwing so existing error handling remains consistent.

In `@src/execution/jupiter-client.ts`:
- Around line 159-167: The live vs paper slippage gating is inconsistent:
replace direct uses of params.slippageBps when checking quote.priceImpactPct
with the single effective slippage cap computed by exitSlippageBps(params) (the
same cap used by getQuote()/freshQuote) so both live and paper branches validate
against the identical allowedImpactPct; update the price-impact checks
surrounding freshQuote/getQuote (including the block at lines ~165 and the
paper-path checks around 195-227) to compute allowedImpactPct once via
exitSlippageBps(params) (convert to percent consistently) and use that value for
all priceImpactPct comparisons and error messages.
- Around line 188-189: The code loses precision by converting quote.outAmount (a
u64 string) to Number in rawAmountToUi, corrupting P&L for large amounts; update
the conversion chain to use an arbitrary-precision decimal library (e.g.,
Decimal.js or BigDecimal) or validate bounds before any Number coercion.
Specifically, change rawAmountToUi and any callers that pass quote.outAmount
(including the real swap path where outputAmount is computed) to accept and
operate on BigInt/Decimal types (or parse quote.outAmount into Decimal
immediately) and perform UI formatting only at the final step; alternatively add
a pre-check that throws/logs if quote.outAmount exceeds Number.MAX_SAFE_INTEGER
to avoid silent truncation.

In `@src/execution/risk-engine.ts`:
- Around line 281-312: The tokenLiquidityLive and tokenAgeLive helpers currently
swallow all provider errors and fall back to cached DB values, which allows
429/5xx throttling to silently produce stale decisions; change them so that
BirdEye/DexScreener rate-limit or server errors are not treated as benign
fall-throughs: detect provider availability errors (HTTP 429/5xx or the clients'
specific error type/status) in the catch handlers inside tokenLiquidityLive and
tokenAgeLive, log the error with context (mint) and then re-throw for those
cases so the execution path fails closed; only fall back to dexscreener or DB
when the error is a non-provider-related transient (or when the upstream call
returns null/undefined) — keep function names tokenLiquidityLive and
tokenAgeLive and the two awaited calls birdEyeClient.getTokenOverview and
dexScreenerClient.getBestPair as anchors for where to implement this behavior.

In `@src/execution/trade-executor.ts`:
- Around line 82-84: The await for risk.checkEntry(convergence, trades,
entryPrice) can throw but is executed outside the later try/catch, so wrap the
call in error-handling before proceeding to swaps: call await
this.risk.checkEntry(...) inside a try/catch (or include it in the existing try
block that surrounds the swap phase in onConvergence), catch any thrown errors
from risk.checkEntry or swaps.getPriceUsd, log the error and return the
appropriate logged rejection/failure path instead of letting the exception
bubble; reference the async functions swaps.getPriceUsd, risk.checkEntry and the
onConvergence flow so you place the try/catch immediately around the entryPrice
calculation and risk.checkEntry step and ensure you still check
risk.allowed/risk.adjustedSizePct/risk.sizeUsd after a successful call.

---

Outside diff comments:
In `@src/engine/convergence.ts`:
- Around line 34-41: The convergence window is anchored to Date.now() causing
different results when replaying historical trades; switch the reference to the
incoming trade's timestamp instead: compute the lookback cutoff (used by since
passed into this.trades.findByTokenInWindow(newTrade.tokenMint, ...)) from
newTrade.timestamp (converted to the same epoch units as stored trades) minus
windowSeconds, and do the same for the tier cutoff used by validateTierWindow so
both since and tierSince use the trade's timestamp rather than wall clock;
ensure unit consistency (ms vs s) and reuse the same reference value when
calling getThreshold/validateTierWindow to avoid off-by-one/window divergence
between live and backtest paths.

---

Duplicate comments:
In `@scripts/backfill-usd.ts`:
- Around line 149-176: The SOL/USD caching is order-dependent because you call
getSolUsdAt(trade.block_time) and store the first trade's exact block_time in
solUsdCache under a 5-minute bucket; instead compute a deterministic bucket
timestamp (e.g., bucketStart = bucket * 300 or
Math.floor(trade.block_time/300)*300) and use that bucketStart when calling
birdEyeClient.getSolUsdAt(...) and when storing cached = { unixTime:
bucketStart, value }, so every trade in the same 5-minute bucket uses the same
deterministic timestamp; update the code around solUsdCache.get(bucket), the
getSolUsdAt call, and the cached assignment to use this bucketStart instead of
trade.block_time.

In `@scripts/leaderboard.ts`:
- Around line 171-185: The SQL currently restricts the trades variable to
block_time > cutoff which loses pre-window opening lots needed by matchFifo(...)
and causes sells that close pre-window inventory to appear in unmatched_sells
and undercount realized_sol, n_closed and wallet_class; fix by expanding the
query fed into trades to also include historical trades needed to seed FIFO
(e.g. include trades with block_time <= cutoff for the same
wallet_address/token_mint or fetch a pre-window inventory snapshot) so
matchFifo(...) has opening lots available; update the code that writes
wallet_class back to wallets (and any uses of unmatched_sells, realized_sol,
n_closed) to derive final metrics only after running matchFifo with the seeded
history.

In `@src/__tests__/webhook-health.test.ts`:
- Around line 22-25: The test uses a loose matcher expect.any(Array) for the
update payload which allows incorrect/healed address lists to slip; update the
assertion in the test for checkWebhookHealth to assert the exact expected array
of addresses (no empty array, no duplicates, no stale entries) passed to
mockUpdateWebhook (replace expect.any(Array) with the concrete list you expect,
e.g., the wallets array or the healed addresses), and make the matching change
in the sibling test block mentioned (lines 36-45) as well so both tests validate
the precise payload.

In `@src/api/routes/webhooks.ts`:
- Around line 39-40: preSellBalance is currently computed by summing all
persisted SELLs for the wallet/mint which can include SELLs that occurred after
the current trade, causing sellPct and onWhaleSell() to be wrong; fix this by
changing computePreSellBalance to accept a cutoff (e.g., trade.timestamp or
trade.id) and have it only sum SELLs with timestamp/id strictly less than the
current trade, then call computePreSellBalance(deps.db, trade.walletAddress,
trade.tokenMint, trade.timestamp) (and update the other occurrences around the
68-78 block similarly) so preSellBalance is bound to trades before this SELL.

In `@src/engine/scorer.ts`:
- Around line 37-54: computeHoldTimes (and the similar matcher around lines
65-84) currently treats a BUY row as consumed entirely on the first matching
SELL by using queue.shift(), causing partial sells to be counted as full
round-trips; change the matching to maintain per-lot remaining quantity for each
buy (e.g., store objects with {row: TradeRow, remainingQty: number}) and when a
SELL arrives decrement remainingQty across queued buys (possibly consuming a buy
fully and shifting only when remainingQty === 0), emitting hold-time samples for
the actual quantity matched (or weighting hold-times by matched quantity)
instead of for the entire BUY row so partial fills produce proportional
hold-time entries and correct wash/median calculations.
- Around line 91-98: The MEV/wash detection currently only analyzes persisted
trades while positions and totalTrades include heliusTxs; update
computeHoldTimes and detectWashTrading to run over the same normalized fill set
used by buildPositions (i.e., merge/normalize heliusTxs into the trades-like
fills and pass that combined array instead of `trades`), and ensure totalTrades
calculation remains consistent (you can keep swapCount logic but base hold-time
and wash detection on the unified fills); reference functions: buildPositions,
computeHoldTimes, detectWashTrading, and variables: heliusTxs, trades,
totalTrades, medianHoldTime, MEV_HOLD_TIME_THRESHOLD_SEC.

In `@src/execution/position-auditor.ts`:
- Around line 22-29: The audit currently checks the position's own tier
(pos.tier) but must check the backing convergence tier (pos.conv_tier); update
the condition that pushes "WATCH tier position" to use pos.conv_tier (and treat
null appropriately), e.g. replace the pos.tier check with a conv_tier check and
ensure the existing orphan check for pos.conv_tier === null remains correct so
positions backed by a WATCH convergence are quarantined; adjust the condition
near the violations.push("WATCH tier position") and related checks that
reference pos.tier/pos.conv_tier to use the convergence tier consistently.

In `@src/execution/position-manager.ts`:
- Around line 340-360: checkDollarStop currently measures only the single
position's unrealized loss; update it to compute the aggregated unrealized loss
across all OPEN/PARTIAL positions and compare that sum to NAV so the portfolio
cap can trigger when multiple positions together breach the limit. Use
this.requireDb() to query all positions (fields: id, amount_token,
entry_price_usd, current_price_usd) and sum max(0, amount_token *
(entry_price_usd - price)) where price is priceUsd for the PositionRow being
checked (match by id) and COALESCE(current_price_usd, entry_price_usd) for
others; keep using portfolioValueUsd() for NAV and MAX_DOLLAR_LOSS_PORTFOLIO_PCT
for the threshold, and call this.exit(position, "DOLLAR_LOSS_CAP", 100, true)
when the aggregated percent >= cap. Ensure you still return boolean and do not
modify other behavior in portfolioValueUsd().
- Around line 75-78: The configure method currently defaults wallets to null
which lets onWhaleSell “fail open” when wallets are omitted; change configure
(method configure and the instance property wallets: WalletModel) to require or
explicitly keep wallets undefined/unset if not provided, and update onWhaleSell
to guard for absence of wallets or missing classifications before exiting—i.e.,
if this.wallets is falsy or the seller’s classification (loser/accumulation_bot)
is not yet available, do NOT perform the immediate exit and instead defer/skip
the whale-sell action until wallets/classifications are present; ensure all
checks reference the WalletModel lookups used elsewhere and cover the
alternative execution path noted around onWhaleSell (lines ~193-203).

In `@src/execution/trade-executor.ts`:
- Around line 191-229: The code calculates amountLamports correctly but
continues to use the original floating sellAmountToken for post-trade
accounting; change the post-trade math to use the quantized sold token amount
derived from amountLamports (the IIFE that computes amountLamports) converted
back to token units using the same scale (10n ** BigInt(decimals)). Use that
quantizedTokenSold for exitPrice (exitUsd / quantizedTokenSold), pnlUsd, pnlPct,
pass quantizedTokenSold to fillExecution as amountToken, and subtract
quantizedTokenSold from current.amount_token for remaining; keep the 1n minimum
behavior from the amountLamports IIFE and ensure conversion uses the same scale
variable so decimals are handled consistently.
- Around line 52-58: The current check using requireDb().prepare(...).get(...)
and returning if existingPosition is racy because two workers can both see no
OPEN/PARTIAL row and proceed to executeSwap(); fix by atomically claiming the
mint in the DB before calling executeSwap(): inside a DB transaction
create/insert a new row (e.g., status='PENDING' or similar) for
convergence.token_mint or update an existing row only if none with status IN
('OPEN','PARTIAL') exists, using an INSERT ... ON CONFLICT/UPSERT or a
SELECT...FOR UPDATE/UPDATE-with-condition so the claim is serialized; if the
insert/update fails because another worker claimed it, log and return, and
ensure you roll back or delete the PENDING row if executeSwap() fails so
position state and balances remain consistent.

In `@src/index.ts`:
- Around line 37-44: The shutdown flow in shutdown() must be made async and
should await Fastify's graceful close before tearing down other resources:
change shutdown to async, await app.close() (or app.close().catch(...)) first,
then stopRecentTradesCleanup(), then await db.close() if it returns a Promise
(or call it after app is closed), and only call process.exit(0) after all
awaited closes complete; update the two process.on handlers (SIGTERM/SIGINT and
the duplicate at lines ~146-149) to call the async shutdown and not prematurely
exit.
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

**Run ID**: `3304bc3e-d07d-4f86-9981-54d11c84b406`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and 8be21438d45445d08acddbf254bcfa1a3064bb78.

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

* src/frontend/pages/Wallets.tsx
* .env.example
* src/frontend/pages/History.tsx
* src/frontend/pages/Settings.tsx
* src/frontend/components/ConvergenceCard.tsx
* src/jobs/cleanup.ts
* src/jobs/token-metadata.ts
* src/jobs/catchup.ts
* src/utils/retry.ts
* src/frontend/hooks/useSSE.ts
* src/frontend/components/StatusBadge.tsx
* src/frontend/components/WalletTable.tsx

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
