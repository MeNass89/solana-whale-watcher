**Actionable comments posted: 6**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (4)</summary><blockquote>
> 
> <details>
> <summary>src/execution/jupiter-client.ts (2)</summary><blockquote>
> 
> `180-183`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **`inputAmount` should come from `params.amountLamports`, not the quote.**
> 
> The new guard only validates `outputAmount`. Both paper and live results still derive `inputAmount` from `quote.inAmount` plus `quote.inputDecimals`, even though the caller already supplied the authoritative raw input amount. If Jupiter returns stale or misparsed decimals, the fill record can still overstate or understate size and poison P&L. Convert `params.amountLamports` directly, and optionally assert the quote matches it.
>  
> <details>
> <summary>🛠️ Minimal direction</summary>
> 
> ```diff
> -    const inputAmount = quote
> -      ? await this.rawAmountToUi(params.inputMint, BigInt(quote.inAmount), quote.inputDecimals)
> -      : await this.rawAmountToUi(params.inputMint, params.amountLamports);
> +    const inputAmount = await this.rawAmountToUi(params.inputMint, params.amountLamports);
> +    if (quote && quote.inAmount !== params.amountLamports.toString()) {
> +      logger.warn(
> +        { inputMint: params.inputMint, requested: params.amountLamports.toString(), quoted: quote.inAmount },
> +        "paper swap: quote input amount drifted from requested amount"
> +      );
> +      throw new Error("Paper swap quote input amount mismatch");
> +    }
> 
> ...
> -      inputAmount: await this.rawAmountToUi(params.inputMint, BigInt(quote.inAmount), quote.inputDecimals),
> +      inputAmount: await this.rawAmountToUi(params.inputMint, params.amountLamports),
> ```
> </details>
> As per coding guidelines, "Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."
> 
> 
> Also applies to: 194-208
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/jupiter-client.ts` around lines 180 - 183, The returned fill
> object is using quote.inAmount/quote.inputDecimals for inputAmount which is
> unsafe; change inputAmount to convert params.amountLamports via
> this.rawAmountToUi(params.inputMint, params.amountLamports, quote.inputDecimals)
> instead of awaiting rawAmountToUi(..., BigInt(quote.inAmount), ...); optionally
> add an assertion that BigInt(quote.inAmount) === BigInt(params.amountLamports)
> to catch mismatched quotes and log or error; update the same pattern in the
> nearby block referenced (lines ~194-208) where quote-derived inputAmount is
> used.
> ```
> 
> </details>
> 
> ---
> 
> `86-92`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **The intentional 25% MEME tier is still blocked by the fixed 3% impact gate.**
> 
> `slippageBpsForLiquidity()` now allows 2500 bps for the $5k-$50k tier, but `executeSwap()` still rejects any quote whose `priceImpactPct` is above 3. Live execution will keep dropping the exact low-liquidity entries this tier was added to permit. Align the impact ceiling with the slippage/liquidity tier instead of keeping a global 3% cap.
>  
> As per coding guidelines, "Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."
> 
> 
> Also applies to: 159-162
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/jupiter-client.ts` around lines 86 - 92, The executeSwap path
> still enforces a hard 3% priceImpactPct cap which overrides the variable
> slippage tiers from slippageBpsForLiquidity; change executeSwap (the price
> impact/acceptance logic) to compute an allowedImpactPct from
> slippageBpsForLiquidity(liquidityUsd) (convert bps to pct) and use that
> per-quote instead of the fixed 3% ceiling, falling back to a safe default (e.g.,
> 3%) only when slippageBpsForLiquidity returns null; update any related checks
> and error messages that reference the fixed 3% value so the approval gate aligns
> with the liquidity-based slippage tier.
> ```
> 
> </details>
> 
> </blockquote></details>
> <details>
> <summary>src/api/routes/webhooks.ts (1)</summary><blockquote>
> 
> `47-49`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_
> 
> **Sell percentage is based on lifetime buys, not the pre-sell position.**
> 
> `estimateSellPct()` divides by total historical buys only. After partial exits, a whale can sell 100% of the remaining bag and this still reports a small trim, so `positionManager.onWhaleSell()` under-exits and copied P&L drifts from the source wallet. Base the percentage on net holdings before the current sell, or compute it before inserting the current sell.
>  
> 
> 
> Also applies to: 63-68
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/api/routes/webhooks.ts` around lines 47 - 49, The sell percentage
> calculation is wrong because estimateSellPct currently divides by lifetime buys
> including prior sells; change the logic to compute the percentage against the
> wallet's net holding immediately before this sell (pre-sell balance) rather than
> lifetime buys or after inserting the trade. Locate where estimateSellPct is
> called from the webhook handler (the block with trade.tradeType === "SELL" and
> the analogous block at lines 63-68) and replace or augment it to compute
> preSellBalance = sum(buys) - sum(sells) excluding the current trade (or call a
> new helper like computePreSellBalance(walletAddress, tokenMint) before
> persisting the sell), then set sellPct = trade.amountToken / preSellBalance
> (handle zero/prevent divide-by-zero) and pass that sellPct into
> positionManager.onWhaleSell; apply the same change in the other SELL handling
> block referenced in the comment.
> ```
> 
> </details>
> 
> </blockquote></details>
> <details>
> <summary>src/execution/trade-executor.ts (1)</summary><blockquote>
> 
> `139-150`: _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
> 
> **Keep Discord failures out of the trade-failure path.**
> 
> Both `notify("ENTRY_FILLED", ...)` and `notifyPositionExit(...)` run inside the same `try` that guards swap execution and state writes. If Discord fails *after* `fillExecution()` / `markExit()`, the catch path flips the execution to `FAILED` and increments failed-transaction counters even though the swap already succeeded.
> 
> Make notifications best-effort in a separate `try/catch` after durable trading state is written. As per coding guidelines, `src/execution/**`: "Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."  
>  
> 
> 
> Also applies to: 222-227
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/trade-executor.ts` around lines 139 - 150, The notify calls
> (notify("ENTRY_FILLED", ...) and notifyPositionExit(...)) are inside the same
> try that performs durable state changes, so a notification failure can
> incorrectly trigger failExecution/recordFailedTransaction; move all user/Discord
> notification calls out of the critical swap/state-write try block and into their
> own best-effort try/catch after successful calls to fillExecution()/markExit()
> (or other durable write functions) so that failures there are logged but do not
> call failExecution or risk.recordFailedTransaction; apply the same change to the
> other notification site around notifyPositionExit to ensure notifications never
> flip completed trades to FAILED.
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>♻️ Duplicate comments (10)</summary><blockquote>

<details>
<summary>src/storage/database.ts (1)</summary><blockquote>

`39-54`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Concurrent startup can still fail on duplicate-column during wallet migration.**

Moving `PRAGMA table_info` into the transaction is not sufficient by itself; two processes can still race and the loser can fail on `ALTER TABLE ... ADD COLUMN`. Make each `ALTER TABLE` idempotent by catching duplicate-column errors and continuing.

<details>
<summary>Proposed minimal fix</summary>

```diff
 function runWalletPnlTrackingMigration(db: AppDatabase): void {
+  const execAddColumn = (sql: string): void => {
+    try {
+      db.exec(sql);
+    } catch (error) {
+      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) {
+        throw error;
+      }
+    }
+  };
+
   const tx = db.transaction(() => {
     // Probe schema inside the transaction so two concurrent startups can't
     // both observe the pre-migration state and race on duplicate ALTER TABLE.
     const columns = new Set(
       (db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>).map((column) => column.name)
     );

     if (!columns.has("realized_sol_30d")) {
-      db.exec("ALTER TABLE wallets ADD COLUMN realized_sol_30d REAL DEFAULT 0");
+      execAddColumn("ALTER TABLE wallets ADD COLUMN realized_sol_30d REAL DEFAULT 0");
     }
     if (!columns.has("n_closed_30d")) {
-      db.exec("ALTER TABLE wallets ADD COLUMN n_closed_30d INTEGER DEFAULT 0");
+      execAddColumn("ALTER TABLE wallets ADD COLUMN n_closed_30d INTEGER DEFAULT 0");
     }
     if (!columns.has("wallet_class")) {
-      db.exec("ALTER TABLE wallets ADD COLUMN wallet_class TEXT DEFAULT 'unknown'");
+      execAddColumn("ALTER TABLE wallets ADD COLUMN wallet_class TEXT DEFAULT 'unknown'");
     }
     db.exec("CREATE INDEX IF NOT EXISTS idx_wallets_class ON wallets(wallet_class)");
     db.exec("CREATE INDEX IF NOT EXISTS idx_wallets_realized_sol ON wallets(realized_sol_30d DESC)");
   });
   tx();
 }
```
</details>

   

```shell
#!/bin/bash
# Read-only verification: confirm ALTERs are not currently guarded against duplicate-column races.
rg -n -C2 'runWalletPnlTrackingMigration|ALTER TABLE wallets ADD COLUMN|duplicate column|catch' src/storage/database.ts
```

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/storage/database.ts` around lines 39 - 54, The migration within tx
(db.transaction) still risks a race where concurrent processes both see PRAGMA
table_info(wallets) and one loses on db.exec("ALTER TABLE wallets ADD COLUMN
...") with a duplicate-column error; update the code around the columns.has
checks and each db.exec call (the ALTER TABLE wallets ADD COLUMN paths for
realized_sol_30d, n_closed_30d, wallet_class) to catch errors from db.exec,
detect duplicate-column errors (by message/code used by SQLite driver) and
ignore/continue while rethrowing other errors so the ALTERs become idempotent
under concurrent startup.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/transaction-parser.ts (1)</summary><blockquote>

`20-29`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Out-of-order trades can still be falsely flagged as rapid reversals.**

Line 23 updates the cache before validating event ordering, and Line 28 uses `Math.abs(...)`. A delayed older trade can be treated as a reversal against a newer one and also overwrite the newer state.

<details>
<summary>Proposed fix</summary>

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
+  if (!previous) {
+    recentTrades.set(key, { tradeType: trade.tradeType, blockTime: trade.blockTime });
+    return false;
+  }
+  if (trade.blockTime <= previous.blockTime) return false;
+
+  recentTrades.set(key, { tradeType: trade.tradeType, blockTime: trade.blockTime });
+  const oppositeType = trade.tradeType === "BUY" ? "SELL" : "BUY";
+  return previous.tradeType === oppositeType
+    && trade.blockTime - previous.blockTime < RAPID_REVERSAL_WINDOW_SEC;
 }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/transaction-parser.ts` around lines 20 - 29, The function
isRapidReversal incorrectly updates recentTrades before validating ordering and
uses Math.abs which causes older delayed events to be treated as reversals and
overwrite newer state; change the flow in isRapidReversal: read
recentTrades.get(key) first, if there is a previous entry require
previous.blockTime < trade.blockTime (or if previous.blockTime >=
trade.blockTime skip reversal detection and do not overwrite the cache), compute
delta = trade.blockTime - previous.blockTime (no Math.abs) and only if
previous.tradeType is the opposite (BUY/SELL) and delta <
RAPID_REVERSAL_WINDOW_SEC return true, then update recentTrades.set(key, {
tradeType: trade.tradeType, blockTime: trade.blockTime }) only after these
checks (or update only when trade.blockTime >= existing blockTime) to avoid
overwriting newer entries.
```

</details>

</blockquote></details>
<details>
<summary>docs/audit-report.md (1)</summary><blockquote>

`3-7`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**Snapshot header still points to the wrong alert-manager file.**

The “current state” pointer uses `src/services/alert-manager.ts`, but the implementation in this PR lives under `src/engine/alert-manager.ts`. That leaves the historical note pointing readers at the wrong place.
  
<details>
<summary>📝 Minimal fix</summary>

```diff
-> `src/jobs/webhook-health.ts`, and the post-convergence hook in `src/services/alert-manager.ts`
+> `src/jobs/webhook-health.ts`, and the post-convergence hook in `src/engine/alert-manager.ts`
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/audit-report.md` around lines 3 - 7, Update the snapshot header in
docs/audit-report.md so the “current state” pointer references the actual
implementation path src/engine/alert-manager.ts (instead of
src/services/alert-manager.ts); specifically modify the line that lists
`src/jobs/co-buyer-scanner.ts`, `src/jobs/webhook-health.ts`, and the
post-convergence hook to include `src/engine/alert-manager.ts` so readers are
directed to the correct AlertManager implementation.
```

</details>

</blockquote></details>
<details>
<summary>src/index.ts (2)</summary><blockquote>

`97-103`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Use the guarded leaderboard job for the startup trigger too.**

`setTimeout(leaderboardJob, 90_000)` bypasses the mutex and can overlap with the 06:00 scheduled run on startup near that boundary.

<details>
<summary>Proposed fix</summary>

```diff
-  setTimeout(leaderboardJob, 90_000);
+  setTimeout(() => {
+    void leaderboardJobGuarded();
+  }, 90_000);
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 97 - 103, The startup setTimeout currently calls
leaderboardJob directly which bypasses the mutex; change that to call
leaderboardJobGuarded instead (i.e., invoke leaderboardJobGuarded after the
90_000ms delay) so the initial run uses the same guarded behavior as the
scheduled 06:00 run and cannot overlap with it; update the setTimeout invocation
that references leaderboardJob to reference leaderboardJobGuarded.
```

</details>

---

`37-44`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Close the HTTP server before closing SQLite during shutdown.**

Current signal shutdown closes `db` and exits immediately while request handling/background work can still be active, which can fail in-flight writes against a closed handle.

<details>
<summary>Proposed fix</summary>

```diff
 async function main(): Promise<void> {
   const db = openDatabase();
+  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
   process.removeAllListeners("SIGTERM");
   process.removeAllListeners("SIGINT");
-  const shutdown = (signal: string) => {
+  const shutdown = async (signal: string) => {
     logger.info(signal);
+    if (app) await app.close();
     stopRecentTradesCleanup();
     db.close();
     process.exit(0);
   };
-  process.on("SIGTERM", () => shutdown("SIGTERM"));
-  process.on("SIGINT", () => shutdown("SIGINT"));
+  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
+  process.on("SIGINT", () => { void shutdown("SIGINT"); });

-  const app = await buildServer({ wallets, trades, convergences, engine, alerts });
+  app = await buildServer({ wallets, trades, convergences, engine, alerts });
```
</details>

   

```shell
#!/bin/bash
# Verify buildServer return type supports close() and current shutdown ordering in src/index.ts
rg -n --type=ts -C3 '\bexport\s+async\s+function\s+buildServer\b|\breturn\s+app\b|\bFastify' src/api/server.ts
rg -n --type=ts -C4 '\bconst shutdown\b|\bdb\.close\(\)|\bbuildServer\(' src/index.ts
```

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 37 - 44, The shutdown sequence currently calls
stopRecentTradesCleanup() and db.close() then exits, which can close SQLite
while the HTTP server is still handling requests; update the shutdown function
to first stop background tasks (stopRecentTradesCleanup()), then gracefully
close the HTTP server (await server.close() or await fastify.close() on the
instance returned by buildServer or stored as `server`) and only after the
server has fully closed call db.close() and finally process.exit(0); ensure
buildServer returns/exports the server instance with a close() method or keep a
module-scoped reference to the created server so shutdown can await
server.close() and handle/ log any close errors before exiting.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/scorer.ts (2)</summary><blockquote>

`95-98`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**MEV/wash detection runs on a different dataset than position scoring.**

`computeHoldTimes` and `detectWashTrading` operate on persisted `trades`, while `buildPositions` and `totalTrades` also incorporate `heliusTxs`. When ingestion lags, the same wallet may avoid demotion in one pass and flip state once swaps land in SQLite—breaking live/backtest parity.

Build manipulation scans from the same unified fills used for P&L computation.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 95 - 98, The MEV and wash trading
detection currently use persisted trades (computeHoldTimes(trades),
detectWashTrading(trades)) which diverges from position scoring that uses the
unified fills including heliusTxs (buildPositions, totalTrades); update the
scorer so computeHoldTimes and detectWashTrading are invoked on the same unified
fills dataset used for P&L/position computation (merge or replace the persisted
trades input with the combined fills/heliusTxs stream before calling
computeHoldTimes and detectWashTrading) to ensure consistent demotion/state
decisions across live/backtest runs.
```

</details>

---

`37-54`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**FIFO pairing is correct but not quantity-aware.**

A partial sell (e.g., 1% of position) currently `shift()`s the entire buy fill, creating a synthetic full round-trip with an artificially short hold time. This can falsely trigger `isMev` when the bulk of the position is still open.

Use per-mint lots with remaining token quantities (similar to `src/engine/fifo-matcher.ts`) and only close the matched quantity per sell.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 37 - 54, computeHoldTimes currently treats
buys as atomic lots and shift()s a full buy on any SELL, mis-handling partial
sells; update computeHoldTimes to track per-mint buy lots with remaining
quantities (use a queue of lots like {trade: TradeRow, remainingQty: number})
similar to src/engine/fifo-matcher.ts, and on a SELL iterate consuming from the
queue reducing remainingQty instead of shift()ing entire buys; for each consumed
portion compute the hold time (t.block_time - buy.block_time) for the matched
quantity and record it appropriately (e.g., repeat the hold time per unit
matched or push a weighted entry) until the sell amount is fully matched. Ensure
you reference computeHoldTimes, buyQueueByMint, and the FIFO lot structure from
fifo-matcher.ts when implementing.
```

</details>

</blockquote></details>
<details>
<summary>scripts/leaderboard.ts (1)</summary><blockquote>

`166-180`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Pre-window inventory still not seeded into FIFO matching.**

Sells within the 30-day window that close positions opened *before* the cutoff become `unmatched_sells` (logged at Line 186). Their realized P&L, `n_closed`, and win rate are lost from the metrics that drive `wallet_class` and the convergence quality gate.

For a 30-day *realized* leaderboard, the realization event is the sell inside the window—even if the lot was bought earlier. Without seeding pre-cutoff inventory, alpha wallets with longer hold times are systematically misclassified as `incomplete`.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/leaderboard.ts` around lines 166 - 180, The FIFO matcher is only
given trades after cutoff so sells inside the window that close pre-cutoff lots
are marked as unmatched; to fix this, seed the matcher with pre-window inventory
by querying and injecting prior buy lots into the FIFO state before processing
`trades` — add a separate query that selects buys (trade_type = 'buy') with
block_time <= cutoff for the same active wallets/mints (same filters as the
current `trades` query), convert those rows into the same RawTrade/lot structure
and feed them into the FIFO matching routine prior to processing `trades` so
`unmatched_sells`, realized P&L, `n_closed`, and win-rate calculations reflect
closes of pre-cutoff lots (update code paths that reference `trades`, `cutoff`,
`RawTrade`, and the FIFO matcher/unmatched_sells logic to accept the seeded
inventory).
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-manager.ts (2)</summary><blockquote>

`186-206`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Whale-sell filtering still fails open when `wallets` is not configured.**

When `this.wallets` is `null` (Lines 190-196), the quality check is skipped entirely. Sells from wallets already classified as `loser` or `accumulation_bot` can still trigger exits on the position. This is inconsistent with the convergence gate which requires quality data to reject bad triggers.

Consider either requiring `wallets` in the execution path or defaulting to ignore whale-sell events until quality data is available.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 186 - 206, onWhaleSell
currently skips wallet-quality filtering when this.wallets is null, allowing
untrusted wallets to trigger exits; change onWhaleSell to require quality data
by returning early if this.wallets is falsy (or otherwise treat unknown quality
as untrusted) so the qualityFor check always runs before acting; locate the
onWhaleSell method and add an early return when this.wallets is null (or
explicitly treat missing quality as "ignore" by checking this.wallets before
calling recordBehavioralSell/exit) so whale-sell events are ignored until wallet
quality is available.
```

</details>

---

`333-343`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Dollar loss cap still only measures one position's unrealized loss.**

`checkDollarStop` computes `unrealizedLoss` from the *current* position only (Line 334), not the aggregate across all open/partial positions. If three positions are each down ~1.5% of NAV, aggregate drawdown is ~4.5% but this guard never fires because no single position crosses the 3% threshold.

To enforce portfolio-level risk, sum unrealized losses across all OPEN/PARTIAL positions before comparing to `MAX_DOLLAR_LOSS_PORTFOLIO_PCT`.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 333 - 343, checkDollarStop
currently measures unrealizedLoss for only the single PositionRow passed in;
change it to compute totalUnrealizedLoss across all OPEN/PARTIAL positions (use
your list of positions getter, e.g. this.getOpenPositions() or this.positions)
by summing amount_token * (entry_price_usd - currentPriceForEachPosition), then
compare (totalUnrealizedLoss / this.portfolioValueUsd()) * 100 against
MAX_DOLLAR_LOSS_PORTFOLIO_PCT; if exceeded, trigger exits for the portfolio
(call this.exit for each open/partial position or invoke your portfolio-wide
exit path) and return true, otherwise return false, keeping the function
signature checkDollarStop(PositionRow, priceUsd).
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
In `@scripts/backfill-usd.ts`:
- Around line 147-153: The current solUsdCache keyed by hour makes amounts
depend on iteration order because the first trade in an hour seeds the price;
change the caching so the key is deterministic per trade time—either use the
exact unix timestamp trade.block_time as the cache key or use a smaller fixed
granularity (e.g., 5-minute buckets) instead of Math.floor(trade.block_time /
3600). Update the code around solUsdCache, bucket, and the
birdEyeClient.getSolUsdAt(unixTime) call to compute the new cache key (e.g.,
Math.floor(trade.block_time / 300) for 5-minute or trade.block_time) and always
fetch/store based on that key so each trade uses the correct price for its
block_time.

In `@src/blockchain/helius-client.ts`:
- Around line 98-105: The current getWalletTransactions branch treats 401/403 as
a harmless end-of-pagination; instead update the error handling so auth failures
are treated as systemic errors: in the block that currently throws
HeliusRequestError for 429 or >=500, also throw for 401 and 403 (i.e., include
response.status === 401 || response.status === 403 in that condition) and do not
fall through to the logger.warn/pagination break path; keep using
HeliusRequestError so callers can surface and retry appropriately.

In `@src/execution/position-auditor.ts`:
- Around line 13-25: The audit currently misses positions whose convergence is
absent because the query uses LEFT JOIN and the loop ignores
conv_tier/wallet_count nulls; update the audit in position-auditor.ts to treat
missing or mismatched convergences as a violation: inside the loop that iterates
over positions (the positions array and AuditResult accumulation), add a check
for pos.convergence_id !== null && (pos.conv_tier == null || pos.wallet_count ==
null) (or simply pos.conv_tier == null || pos.wallet_count == null) and push a
descriptive reason like "no valid convergence/backing" to violations so these
positions are quarantined; alternatively, change the SQL to use an INNER JOIN to
exclude positions without a matching convergence if that better matches intent.
Ensure you reference pos.convergence_id, pos.conv_tier, pos.wallet_count and
update total/valid/quarantined counts accordingly.

In `@src/execution/trade-executor.ts`:
- Around line 52-58: The pre-check using
requireDb().prepare(...).get(convergence.token_mint) is racy because it only
observes existing positions before the external BUY; instead reserve the mint
atomically before calling executeSwap(): inside trade-executor.ts, create a
DB-backed reservation or insert a pending/opening position row in a transaction
(using the same DB via requireDb()) keyed by convergence.token_mint, and only
call executeSwap() after that insert/lock succeeds; then proceed to
openPosition(), fillExecution(), and updatePaperBalance() knowing the mint is
claimed; ensure the reservation is removed or updated on failure so no stale
pending rows remain.
- Around line 183-193: The amountLamports calculation currently rounds
sellAmountToken to an integer before applying token decimals, which forces
fractional amounts to whole tokens; change it to convert the fractional token
amount into base units first and then cast to BigInt. Specifically, in the
swaps.executeSwap call replace the IIFE that computes amountLamports so it
multiplies sellAmountToken by 10**decimals in decimal/string space (or using a
precise decimal lib) to produce an exact integer base-unit string (preventing
float overflow/precision loss), then create the BigInt from that integer string
(e.g., compute baseUnits = floor(sellAmountToken * 10**decimals) using a safe
decimal approach and use BigInt(String(baseUnits))). Keep references:
amountLamports, sellAmountToken, tokenDecimals(current.token_mint),
current.token_mint, and swaps.executeSwap.

In `@src/jobs/co-buyer-scanner.ts`:
- Around line 23-30: The current wallets.find → wallets.upsert loop is racy and
can clobber existing rows; replace that two-step logic in the loop over rows
(using row.wallet_address) with a single atomic insert that uses INSERT ... ON
CONFLICT DO NOTHING so concurrent jobs cannot overwrite existing records, and
record success by checking the insertion count from the DB response (e.g., the
returned changes/rowCount) instead of relying on a separate find; update the
code that calls wallets.upsert to use the new single-insert call and use the
DB's changes/rowCount to determine whether the wallet was created.

---

Outside diff comments:
In `@src/api/routes/webhooks.ts`:
- Around line 47-49: The sell percentage calculation is wrong because
estimateSellPct currently divides by lifetime buys including prior sells; change
the logic to compute the percentage against the wallet's net holding immediately
before this sell (pre-sell balance) rather than lifetime buys or after inserting
the trade. Locate where estimateSellPct is called from the webhook handler (the
block with trade.tradeType === "SELL" and the analogous block at lines 63-68)
and replace or augment it to compute preSellBalance = sum(buys) - sum(sells)
excluding the current trade (or call a new helper like
computePreSellBalance(walletAddress, tokenMint) before persisting the sell),
then set sellPct = trade.amountToken / preSellBalance (handle zero/prevent
divide-by-zero) and pass that sellPct into positionManager.onWhaleSell; apply
the same change in the other SELL handling block referenced in the comment.

In `@src/execution/jupiter-client.ts`:
- Around line 180-183: The returned fill object is using
quote.inAmount/quote.inputDecimals for inputAmount which is unsafe; change
inputAmount to convert params.amountLamports via
this.rawAmountToUi(params.inputMint, params.amountLamports, quote.inputDecimals)
instead of awaiting rawAmountToUi(..., BigInt(quote.inAmount), ...); optionally
add an assertion that BigInt(quote.inAmount) === BigInt(params.amountLamports)
to catch mismatched quotes and log or error; update the same pattern in the
nearby block referenced (lines ~194-208) where quote-derived inputAmount is
used.
- Around line 86-92: The executeSwap path still enforces a hard 3%
priceImpactPct cap which overrides the variable slippage tiers from
slippageBpsForLiquidity; change executeSwap (the price impact/acceptance logic)
to compute an allowedImpactPct from slippageBpsForLiquidity(liquidityUsd)
(convert bps to pct) and use that per-quote instead of the fixed 3% ceiling,
falling back to a safe default (e.g., 3%) only when slippageBpsForLiquidity
returns null; update any related checks and error messages that reference the
fixed 3% value so the approval gate aligns with the liquidity-based slippage
tier.

In `@src/execution/trade-executor.ts`:
- Around line 139-150: The notify calls (notify("ENTRY_FILLED", ...) and
notifyPositionExit(...)) are inside the same try that performs durable state
changes, so a notification failure can incorrectly trigger
failExecution/recordFailedTransaction; move all user/Discord notification calls
out of the critical swap/state-write try block and into their own best-effort
try/catch after successful calls to fillExecution()/markExit() (or other durable
write functions) so that failures there are logged but do not call failExecution
or risk.recordFailedTransaction; apply the same change to the other notification
site around notifyPositionExit to ensure notifications never flip completed
trades to FAILED.

---

Duplicate comments:
In `@docs/audit-report.md`:
- Around line 3-7: Update the snapshot header in docs/audit-report.md so the
“current state” pointer references the actual implementation path
src/engine/alert-manager.ts (instead of src/services/alert-manager.ts);
specifically modify the line that lists `src/jobs/co-buyer-scanner.ts`,
`src/jobs/webhook-health.ts`, and the post-convergence hook to include
`src/engine/alert-manager.ts` so readers are directed to the correct
AlertManager implementation.

In `@scripts/leaderboard.ts`:
- Around line 166-180: The FIFO matcher is only given trades after cutoff so
sells inside the window that close pre-cutoff lots are marked as unmatched; to
fix this, seed the matcher with pre-window inventory by querying and injecting
prior buy lots into the FIFO state before processing `trades` — add a separate
query that selects buys (trade_type = 'buy') with block_time <= cutoff for the
same active wallets/mints (same filters as the current `trades` query), convert
those rows into the same RawTrade/lot structure and feed them into the FIFO
matching routine prior to processing `trades` so `unmatched_sells`, realized
P&L, `n_closed`, and win-rate calculations reflect closes of pre-cutoff lots
(update code paths that reference `trades`, `cutoff`, `RawTrade`, and the FIFO
matcher/unmatched_sells logic to accept the seeded inventory).

In `@src/blockchain/transaction-parser.ts`:
- Around line 20-29: The function isRapidReversal incorrectly updates
recentTrades before validating ordering and uses Math.abs which causes older
delayed events to be treated as reversals and overwrite newer state; change the
flow in isRapidReversal: read recentTrades.get(key) first, if there is a
previous entry require previous.blockTime < trade.blockTime (or if
previous.blockTime >= trade.blockTime skip reversal detection and do not
overwrite the cache), compute delta = trade.blockTime - previous.blockTime (no
Math.abs) and only if previous.tradeType is the opposite (BUY/SELL) and delta <
RAPID_REVERSAL_WINDOW_SEC return true, then update recentTrades.set(key, {
tradeType: trade.tradeType, blockTime: trade.blockTime }) only after these
checks (or update only when trade.blockTime >= existing blockTime) to avoid
overwriting newer entries.

In `@src/engine/scorer.ts`:
- Around line 95-98: The MEV and wash trading detection currently use persisted
trades (computeHoldTimes(trades), detectWashTrading(trades)) which diverges from
position scoring that uses the unified fills including heliusTxs
(buildPositions, totalTrades); update the scorer so computeHoldTimes and
detectWashTrading are invoked on the same unified fills dataset used for
P&L/position computation (merge or replace the persisted trades input with the
combined fills/heliusTxs stream before calling computeHoldTimes and
detectWashTrading) to ensure consistent demotion/state decisions across
live/backtest runs.
- Around line 37-54: computeHoldTimes currently treats buys as atomic lots and
shift()s a full buy on any SELL, mis-handling partial sells; update
computeHoldTimes to track per-mint buy lots with remaining quantities (use a
queue of lots like {trade: TradeRow, remainingQty: number}) similar to
src/engine/fifo-matcher.ts, and on a SELL iterate consuming from the queue
reducing remainingQty instead of shift()ing entire buys; for each consumed
portion compute the hold time (t.block_time - buy.block_time) for the matched
quantity and record it appropriately (e.g., repeat the hold time per unit
matched or push a weighted entry) until the sell amount is fully matched. Ensure
you reference computeHoldTimes, buyQueueByMint, and the FIFO lot structure from
fifo-matcher.ts when implementing.

In `@src/execution/position-manager.ts`:
- Around line 186-206: onWhaleSell currently skips wallet-quality filtering when
this.wallets is null, allowing untrusted wallets to trigger exits; change
onWhaleSell to require quality data by returning early if this.wallets is falsy
(or otherwise treat unknown quality as untrusted) so the qualityFor check always
runs before acting; locate the onWhaleSell method and add an early return when
this.wallets is null (or explicitly treat missing quality as "ignore" by
checking this.wallets before calling recordBehavioralSell/exit) so whale-sell
events are ignored until wallet quality is available.
- Around line 333-343: checkDollarStop currently measures unrealizedLoss for
only the single PositionRow passed in; change it to compute totalUnrealizedLoss
across all OPEN/PARTIAL positions (use your list of positions getter, e.g.
this.getOpenPositions() or this.positions) by summing amount_token *
(entry_price_usd - currentPriceForEachPosition), then compare
(totalUnrealizedLoss / this.portfolioValueUsd()) * 100 against
MAX_DOLLAR_LOSS_PORTFOLIO_PCT; if exceeded, trigger exits for the portfolio
(call this.exit for each open/partial position or invoke your portfolio-wide
exit path) and return true, otherwise return false, keeping the function
signature checkDollarStop(PositionRow, priceUsd).

In `@src/index.ts`:
- Around line 97-103: The startup setTimeout currently calls leaderboardJob
directly which bypasses the mutex; change that to call leaderboardJobGuarded
instead (i.e., invoke leaderboardJobGuarded after the 90_000ms delay) so the
initial run uses the same guarded behavior as the scheduled 06:00 run and cannot
overlap with it; update the setTimeout invocation that references leaderboardJob
to reference leaderboardJobGuarded.
- Around line 37-44: The shutdown sequence currently calls
stopRecentTradesCleanup() and db.close() then exits, which can close SQLite
while the HTTP server is still handling requests; update the shutdown function
to first stop background tasks (stopRecentTradesCleanup()), then gracefully
close the HTTP server (await server.close() or await fastify.close() on the
instance returned by buildServer or stored as `server`) and only after the
server has fully closed call db.close() and finally process.exit(0); ensure
buildServer returns/exports the server instance with a close() method or keep a
module-scoped reference to the created server so shutdown can await
server.close() and handle/ log any close errors before exiting.

In `@src/storage/database.ts`:
- Around line 39-54: The migration within tx (db.transaction) still risks a race
where concurrent processes both see PRAGMA table_info(wallets) and one loses on
db.exec("ALTER TABLE wallets ADD COLUMN ...") with a duplicate-column error;
update the code around the columns.has checks and each db.exec call (the ALTER
TABLE wallets ADD COLUMN paths for realized_sol_30d, n_closed_30d, wallet_class)
to catch errors from db.exec, detect duplicate-column errors (by message/code
used by SQLite driver) and ignore/continue while rethrowing other errors so the
ALTERs become idempotent under concurrent startup.
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

**Run ID**: `a8f0d3a7-acf2-4003-9904-db7063fa843c`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and 72a9694b1f0e9ee45725d927f0f99eadd31ca452.

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

* src/frontend/pages/History.tsx
* src/frontend/components/ConvergenceCard.tsx
* src/frontend/pages/Settings.tsx
* src/utils/retry.ts
* src/frontend/components/WalletTable.tsx
* src/jobs/token-metadata.ts
* src/frontend/pages/Wallets.tsx
* src/frontend/hooks/useSSE.ts
* src/frontend/components/StatusBadge.tsx
* src/jobs/catchup.ts
* .env.example
* src/jobs/cleanup.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
