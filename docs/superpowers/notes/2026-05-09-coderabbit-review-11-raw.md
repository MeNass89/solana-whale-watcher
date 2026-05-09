**Actionable comments posted: 8**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (2)</summary><blockquote>
> 
> <details>
> <summary>src/execution/position-manager.ts (1)</summary><blockquote>
> 
> `193-214`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **Whale-sell filtering fails open when `wallets` is null.**
> 
> If `this.wallets` is not configured (line 197 evaluates false), the wallet quality check at lines 198-203 is skipped entirely. Any whale sell — including from `loser` or `accumulation_bot` wallets — will trigger exit logic.
> 
> This was flagged previously and remains unaddressed. Either require `wallets` for production, or skip whale-sell exits entirely when quality data is unavailable:
> 
> 
> 
> 
> <details>
> <summary>Proposed fix — fail closed when wallet quality unavailable</summary>
> 
> ```diff
>    async onWhaleSell(walletAddress: string, tokenMint: string, sellPct: number): Promise<void> {
>      if (sellPct < 20) return;
>      const positions = this.listOpen().filter((position) => position.token_mint === tokenMint);
>      if (positions.length === 0) return;
> +    if (!this.wallets) {
> +      logger.warn({ wallet: walletAddress, mint: tokenMint }, "whale sell ignored: wallet quality data unavailable");
> +      return;
> +    }
> -    if (this.wallets) {
> -      const quality = this.wallets.qualityFor([walletAddress]).get(walletAddress);
> -      if (quality && (quality.wallet_class === "loser" || quality.wallet_class === "accumulation_bot")) {
> -        logger.info({ wallet: walletAddress, mint: tokenMint, class: quality.wallet_class }, "whale sell ignored: untrusted wallet class");
> -        return;
> -      }
> +    const quality = this.wallets.qualityFor([walletAddress]).get(walletAddress);
> +    if (quality && (quality.wallet_class === "loser" || quality.wallet_class === "accumulation_bot")) {
> +      logger.info({ wallet: walletAddress, mint: tokenMint, class: quality.wallet_class }, "whale sell ignored: untrusted wallet class");
> +      return;
>      }
> ```
> </details>
> 
> As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L.
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/position-manager.ts` around lines 193 - 214, onWhaleSell
> currently proceeds with exit logic when this.wallets is null, allowing untrusted
> whale sells to trigger exits; change it to fail closed by returning early when
> wallet quality data is unavailable. Update onWhaleSell to check for this.wallets
> at the top (before filtering/processing) and if it's falsy, log/return without
> calling recordBehavioralSell, exit, setConfig, or deleteConfig; keep the
> existing wallet_class check (qualityFor/get) and remaining logic intact when
> this.wallets is present so recordBehavioralSell, exit, setConfig, and
> deleteConfig are only executed when wallet quality info is available.
> ```
> 
> </details>
> 
> </blockquote></details>
> <details>
> <summary>src/execution/trade-executor.ts (1)</summary><blockquote>
> 
> `137-146`: _⚠️ Potential issue_ | _🔴 Critical_
> 
> **Critical race condition: concurrent signals create duplicate execution records and double-debit paper balance.**
> 
> The execution record is created at line 130–136 and the paper balance is debited at line 137, both *before* `openPosition` checks for position collision. When two workers concurrently signal the same token:
> 
> 1. Both pass the dedup check (line 52–58)
> 2. Both call `fillExecution` (line 130–136), creating two FILLED execution records
> 3. Both call `updatePaperBalance(-sizeUsd)` (line 137), applying two debits
> 4. First worker's `openPosition` INSERT succeeds; second worker's fails with UNIQUE constraint
> 5. Second worker catches the collision (line 139–143) and returns the first worker's position
> 6. But the second worker's execution record and paper debit are already committed—no rollback occurs
> 
> The UNIQUE constraint only prevents duplicate position rows, not orphaned execution records or double paper debits. Wrap both `fillExecution` and `updatePaperBalance` in a transaction with `openPosition`, or restructure to check position existence *before* creating the execution record.
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/trade-executor.ts` around lines 137 - 146, The code creates
> execution records (fillExecution) and debits paper balance
> (risk.updatePaperBalance) before attempting to create the position
> (positions.openPosition), which causes race conditions and orphaned executions;
> fix by moving the position-existence check and/or the positions.openPosition
> INSERT into the same DB transaction that also performs fillExecution and the
> paper-balance update so they atomically succeed or fail together, or
> alternatively check for an existing position first (e.g., a
> positions.findByConvergence or SELECT ... FOR UPDATE) and only call
> fillExecution/updatePaperBalance after confirming no existing position; ensure
> you modify the code paths that call fillExecution, risk.updatePaperBalance, and
> positions.openPosition so they run inside a single transactional function (or
> use BEGIN/COMMIT around these calls) to avoid duplicate executions and double
> debits.
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>♻️ Duplicate comments (5)</summary><blockquote>

<details>
<summary>src/storage/migrations/005_co_buyer_index.sql (1)</summary><blockquote>

`5-6`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Stop recreating a deprecated index that is dropped in the next migration.**

Because migrations replay on every startup, this index is rebuilt here and dropped by `006_co_buyer_index_covering.sql` immediately after, causing avoidable heavy churn on `trades` at boot. Make this migration align with the final covering shape (or a no-op).

 

<details>
<summary>Proposed fix</summary>

```diff
-CREATE INDEX IF NOT EXISTS idx_trades_token_type_time
-  ON trades(token_mint, trade_type, block_time);
+-- Keep replay idempotent with the final covering index shape.
+CREATE INDEX IF NOT EXISTS idx_trades_token_type_wallet_time
+  ON trades(token_mint, trade_type, block_time, wallet_address);
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/storage/migrations/005_co_buyer_index.sql` around lines 5 - 6, The
migration currently recreates the deprecated index idx_trades_token_type_time on
trades which is immediately dropped by 006_co_buyer_index_covering.sql; update
005_co_buyer_index.sql to avoid churn by either removing the CREATE INDEX for
idx_trades_token_type_time (make this migration a no-op) or change it to create
the final covering index shape used by 006 (i.e., match the exact
columns/covering/inclusion that 006 creates) so the index is not created then
dropped during startup; adjust the SQL in migration 005 to reference the same
index definition/name as the final covering index or remove the statement
entirely.
```

</details>

</blockquote></details>
<details>
<summary>src/index.ts (1)</summary><blockquote>

`37-44`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Close Fastify before tearing down SQLite.**

`shutdown()` still closes the DB and exits while the server can be mid-request. A `SIGTERM` during webhook ingestion or execution retry can race request handlers against a closed handle and lose the last write.

  

<details>
<summary>🐛 Minimal fix</summary>

```diff
-  const shutdown = (signal: string) => {
+  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
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
@@
-  const app = await buildServer({ db, wallets, trades, convergences, engine, alerts });
+  app = await buildServer({ db, wallets, trades, convergences, engine, alerts });
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 37 - 44, shutdown currently closes the DB and
exits immediately which can race with in-flight Fastify requests; modify the
shutdown function (shutdown) to be async, stopRecentTradesCleanup() first, then
gracefully close the Fastify server instance (await server.close() or await
fastify.close()), only after that close the SQLite handle (db.close()) and
finally call process.exit(0); wrap awaits in try/catch to log errors and ensure
the function awaits server.close() before db.close() and process.exit so no
in-flight requests hit a closed DB.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/convergence.ts (1)</summary><blockquote>

`170-175`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Enforce the boosted tier's wallet floor before the early return.**

Line 171 returns immediately when the configured convergence window is already inside the tier window. In that branch, a top-alpha boost can still over-promote because `getMinWalletsForTier(tier)` is never re-checked. With a 30-minute config, two wallets can still come back as `CRITICAL`.

  

<details>
<summary>🐛 Minimal fix</summary>

```diff
 function validateTierWindow(
   candidate: ConvergenceTier,
   score: number,
   recentBuys: TradeRow[],
   windowSeconds: number,
   threshold: number
 ): ConvergenceTier {
   let tier = candidate;
   while (true) {
@@
-    const tierWindowSeconds = tier === "CRITICAL" ? 30 * 60 : tier === "NOTABLE" ? 60 * 60 : windowSeconds;
-    if (tierWindowSeconds >= windowSeconds) return tier;
+    const tierWindowSeconds = tier === "CRITICAL" ? 30 * 60 : tier === "NOTABLE" ? 60 * 60 : windowSeconds;
+    const requiredWallets = Math.max(threshold, getMinWalletsForTier(tier));
+    if (tierWindowSeconds >= windowSeconds) {
+      const windowWallets = new Set(recentBuys.map((t) => t.wallet_address));
+      if (windowWallets.size >= requiredWallets) return tier;
+    }
@@
-    if (tierWallets.size >= Math.max(threshold, getMinWalletsForTier(tier))) return tier;
+    if (tierWallets.size >= requiredWallets) return tier;
```
</details>

As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/convergence.ts` around lines 170 - 175, The early-return when
tierWindowSeconds >= windowSeconds bypasses the boosted-tier wallet-floor check;
fix by computing the recent window and wallet count and only return the tier if
both the window condition and the wallet-floor are satisfied: compute tierSince
using tierWindowSeconds, build tierWallets from recentBuys, compute minWallets =
Math.max(threshold, getMinWalletsForTier(tier)) and then return tier only when
tierWindowSeconds >= windowSeconds AND tierWallets.size >= minWallets (otherwise
continue normal logic).
```

</details>

</blockquote></details>
<details>
<summary>docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md (1)</summary><blockquote>

`158-160`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**The “manual, safe” migration command still bypasses the idempotent guard.**

Piping `004_wallet_pnl_tracking.sql` straight into `sqlite3` ignores the `PRAGMA table_info(wallets)` pre-check described above, so rerunning this on a DB that already has one of the columns will fail on the first `ALTER TABLE`. Point this step at `runMigrations`, or inline the pre-check here instead of calling the raw SQL file “safe.”

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md` around
lines 158 - 160, The migration step that pipes 004_wallet_pnl_tracking.sql into
sqlite3 bypasses the idempotency guard (the PRAGMA table_info(wallets)
pre-check) and will fail if columns already exist; change the instruction to
call the existing runMigrations entry point instead of piping the raw SQL, or if
you must keep a manual command, inline the same PRAGMA table_info(wallets)
checks before running ALTER TABLE so the script becomes idempotent; refer to
runMigrations and the 004_wallet_pnl_tracking.sql migration and the PRAGMA
table_info(wallets) check when making the change.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-manager.ts (1)</summary><blockquote>

`340-350`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Dollar-loss cap only measures single-position drawdown, not aggregate.**

`checkDollarStop` computes `unrealizedLoss` from one position (line 341). If three positions are each down 1.5% of NAV, aggregate drawdown is 4.5% but `MAX_DOLLAR_LOSS_PORTFOLIO_PCT` (3%) is never breached because no single position exceeds it.

This was flagged previously and remains unaddressed. For proper portfolio risk management, sum unrealized losses across all `OPEN`/`PARTIAL` positions:




<details>
<summary>Proposed fix — aggregate unrealized losses</summary>

```diff
 private async checkDollarStop(position: PositionRow, priceUsd: number): Promise<boolean> {
-  const unrealizedLoss = position.amount_token * (position.entry_price_usd - priceUsd);
-  if (unrealizedLoss <= 0) return false;
   const portfolioValue = this.portfolioValueUsd();
   if (portfolioValue <= 0) return false;
+
+  // Sum unrealized losses across ALL open positions
+  const positions = this.listOpen();
+  let aggregateLoss = 0;
+  for (const pos of positions) {
+    const currentPrice = pos.id === position.id ? priceUsd : (pos.current_price_usd ?? pos.entry_price_usd);
+    const loss = pos.amount_token * (pos.entry_price_usd - currentPrice);
+    if (loss > 0) aggregateLoss += loss;
+  }
+  if (aggregateLoss <= 0) return false;
+
-  if ((unrealizedLoss / portfolioValue) * 100 >= MAX_DOLLAR_LOSS_PORTFOLIO_PCT) {
+  if ((aggregateLoss / portfolioValue) * 100 >= MAX_DOLLAR_LOSS_PORTFOLIO_PCT) {
     await this.exit(position, "DOLLAR_LOSS_CAP", 100, true);
     return true;
   }
```
</details>

As per coding guidelines, `src/execution/**`: Flag any code that could corrupt P&L.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 340 - 350, checkDollarStop
currently measures unrealized loss for a single PositionRow; change it to
compute aggregate unrealized loss across all OPEN/PARTIAL positions and compare
that aggregate to MAX_DOLLAR_LOSS_PORTFOLIO_PCT instead of a single-position
loss. Concretely: retrieve all positions (filter by status OPEN or PARTIAL), sum
per-position unrealizedLoss = amount_token * (entry_price_usd - currentPrice) to
get totalUnrealizedLoss, compute portfolioValue via portfolioValueUsd(), and if
(totalUnrealizedLoss / portfolioValue) * 100 >= MAX_DOLLAR_LOSS_PORTFOLIO_PCT
then call exit(...) for the relevant positions (e.g., iterate and call
this.exit(pos, "DOLLAR_LOSS_CAP", 100, true) for each open/partial PositionRow)
and return true; otherwise return false. Ensure you reference checkDollarStop,
PositionRow, portfolioValueUsd, MAX_DOLLAR_LOSS_PORTFOLIO_PCT, and exit when
making the change.
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
In `@docs/superpowers/plans/2026-05-09-coderabbit-review-3.md`:
- Around line 24-37: The pagination logic in getWalletTransactions must not
treat 401/403 as normal pagination exhaustion—only a true no-more-data response
should break; instead, detect and throw HeliusRequestError for 401, 403, 429 and
any 5xx so auth/permission/rate/server errors surface to callers; update the
response.ok handling in getWalletTransactions to throw new
HeliusRequestError(response.status, ...) for response.status === 401 ||
response.status === 403 || response.status === 429 || response.status >= 500,
and only break for the specific 4xx that indicate no more data (e.g., explicit
404/NoContent semantics if used).

In `@scripts/start-funnel.sh`:
- Around line 21-27: The script currently writes the URL to "$URL_FILE"
immediately after starting the funnel background process (via "$TS_BIN" funnel
--bg 3000), which can publish a URL before the tunnel is actually bound; change
the flow to start the funnel as you do, then poll/verify the tunnel is reachable
before writing "$URL" to "$URL_FILE" (for example perform repeated connect/HTTP
requests against the announced host:port or use any funnel-provided wait/health
flag), stop polling on success or after a short timeout, and on failure
remove/empty "$URL_FILE", log the error to "$LOGFILE" and exit non-zero; keep
references to the same variables/commands (TS_BIN, funnel --bg 3000, LOGFILE,
URL_FILE, URL) so the fix is applied around the existing start-and-publish
logic.

In `@src/api/routes/webhooks.ts`:
- Around line 39-40: The pre-sell balance cutoff using only block_time is
unstable when multiple fills occur in the same second; update
computePreSellBalance (and any SQL/query logic it uses) to add a deterministic
tie-breaker such as (block_time, signature, instruction_index) or the persisted
row id in the WHERE/ORDER BY so you exclude rows strictly before the target fill
(e.g., compare the tuple (block_time, signature, ix) to (trade.blockTime,
trade.signature, trade.instructionIndex) or use the row id) — alternatively
implement a per-batch running balance inside the processing loop so balances are
computed deterministically; locate code in computePreSellBalance and the query
that currently uses "block_time < ?" and adjust it to use the tuple comparison
or running-balance approach.
- Around line 68-76: computePreSellBalance runs a query filtering WHERE
wallet_address = ? AND token_mint = ? AND block_time < ?, but current indexes
(idx_trades_wallet_time and idx_trades_token_time) don't match that prefix; add
a composite index on the trades table with columns in that exact order
(wallet_address, token_mint, block_time) — e.g. create an index named
idx_trades_wallet_token_time using CREATE INDEX IF NOT EXISTS
idx_trades_wallet_token_time ON trades (wallet_address, token_mint, block_time)
via your DB migrations/bootstrap so SQLite can use the index for
computePreSellBalance queries and avoid table scans.

In `@src/engine/convergence.ts`:
- Around line 173-174: The time-window math is using Date.now() in multiple
places causing inconsistent boundary inclusion; capture a single evaluation
timestamp (e.g., nowSeconds) once in checkConvergence() and thread it through to
validateTierWindow(...) and any downstream code that computes tierSince and
filters recentBuys; replace any direct Date.now() uses in validateTierWindow,
the tierSince calculation, and the recentBuys filter with the passed nowSeconds
(converted to seconds) so all window comparisons use the same reference time
(refer to functions checkConvergence, validateTierWindow, and variables
tierSince, recentBuys, tierWindowSeconds).

In `@src/engine/scorer.ts`:
- Around line 37-54: computeHoldTimes currently treats a matched buy lot as
fully consumed (queue.shift()) and ignores amount_token, so partial sells
wrongly remove entire buys; update computeHoldTimes to track remaining buy
quantity per queued lot (e.g., add a remaining field on each queued TradeRow or
wrap it in {lot, remaining}), when processing a SELL consume only
Math.min(remainingBuy, sell.amount_token), decrement both remaining values, push
the hold time for the consumed quantity (or push one entry per consumed chunk
consistent with fifo-matcher.ts), and only shift/remove the buy lot when its
remaining hits zero; use the same matching logic as in fifo-matcher.ts to handle
partial fills.
- Around line 95-98: The MEV/wash detection uses only persisted TradeRow[]
(computeHoldTimes and detectWashTrading) and thus misses live heliusTxs used by
buildPositions; change scoring to merge hold-times from both sources (e.g.,
combine results of computeHoldTimes(trades) and
computeHoldTimesFromHelius(heliusTxs)) before computing median and evaluating
MEV_HOLD_TIME_THRESHOLD_SEC, and run wash-detection over the unified fill set.
Also fix the matching logic in detectWashTrading (currently using queue.shift()
which drops entire trades) to handle partial-quantity matches correctly
(decrease remaining quantity on the queued fill rather than discarding it when
an opposite-side fill only partially matches). Ensure references:
computeHoldTimes, computeHoldTimesFromHelius, detectWashTrading, buildPositions,
queue.shift(), median, MEV_HOLD_TIME_THRESHOLD_SEC.

In `@src/jobs/leaderboard-refresh.ts`:
- Around line 28-33: The timeout handler currently sends SIGTERM and immediately
rejects which clears the leaderboardRunning lock while the subprocess may still
be alive; instead, change the timeout path in the leaderboard-refresh logic so
that when the timer fires you send SIGTERM (child.kill("SIGTERM")), schedule a
SIGKILL fallback, but do NOT call reject or mark settled/clear
leaderboardRunning yet — attach a one-time listener (child.once('exit' or
'close')) to detect when the child actually dies and only then set settled,
clear leaderboardRunning, and reject with the timeout Error (including
LEADERBOARD_TIMEOUT_MS); ensure the SIGKILL fallback still runs if the child
doesn't exit within the fallback interval.

---

Outside diff comments:
In `@src/execution/position-manager.ts`:
- Around line 193-214: onWhaleSell currently proceeds with exit logic when
this.wallets is null, allowing untrusted whale sells to trigger exits; change it
to fail closed by returning early when wallet quality data is unavailable.
Update onWhaleSell to check for this.wallets at the top (before
filtering/processing) and if it's falsy, log/return without calling
recordBehavioralSell, exit, setConfig, or deleteConfig; keep the existing
wallet_class check (qualityFor/get) and remaining logic intact when this.wallets
is present so recordBehavioralSell, exit, setConfig, and deleteConfig are only
executed when wallet quality info is available.

In `@src/execution/trade-executor.ts`:
- Around line 137-146: The code creates execution records (fillExecution) and
debits paper balance (risk.updatePaperBalance) before attempting to create the
position (positions.openPosition), which causes race conditions and orphaned
executions; fix by moving the position-existence check and/or the
positions.openPosition INSERT into the same DB transaction that also performs
fillExecution and the paper-balance update so they atomically succeed or fail
together, or alternatively check for an existing position first (e.g., a
positions.findByConvergence or SELECT ... FOR UPDATE) and only call
fillExecution/updatePaperBalance after confirming no existing position; ensure
you modify the code paths that call fillExecution, risk.updatePaperBalance, and
positions.openPosition so they run inside a single transactional function (or
use BEGIN/COMMIT around these calls) to avoid duplicate executions and double
debits.

---

Duplicate comments:
In `@docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md`:
- Around line 158-160: The migration step that pipes 004_wallet_pnl_tracking.sql
into sqlite3 bypasses the idempotency guard (the PRAGMA table_info(wallets)
pre-check) and will fail if columns already exist; change the instruction to
call the existing runMigrations entry point instead of piping the raw SQL, or if
you must keep a manual command, inline the same PRAGMA table_info(wallets)
checks before running ALTER TABLE so the script becomes idempotent; refer to
runMigrations and the 004_wallet_pnl_tracking.sql migration and the PRAGMA
table_info(wallets) check when making the change.

In `@src/engine/convergence.ts`:
- Around line 170-175: The early-return when tierWindowSeconds >= windowSeconds
bypasses the boosted-tier wallet-floor check; fix by computing the recent window
and wallet count and only return the tier if both the window condition and the
wallet-floor are satisfied: compute tierSince using tierWindowSeconds, build
tierWallets from recentBuys, compute minWallets = Math.max(threshold,
getMinWalletsForTier(tier)) and then return tier only when tierWindowSeconds >=
windowSeconds AND tierWallets.size >= minWallets (otherwise continue normal
logic).

In `@src/execution/position-manager.ts`:
- Around line 340-350: checkDollarStop currently measures unrealized loss for a
single PositionRow; change it to compute aggregate unrealized loss across all
OPEN/PARTIAL positions and compare that aggregate to
MAX_DOLLAR_LOSS_PORTFOLIO_PCT instead of a single-position loss. Concretely:
retrieve all positions (filter by status OPEN or PARTIAL), sum per-position
unrealizedLoss = amount_token * (entry_price_usd - currentPrice) to get
totalUnrealizedLoss, compute portfolioValue via portfolioValueUsd(), and if
(totalUnrealizedLoss / portfolioValue) * 100 >= MAX_DOLLAR_LOSS_PORTFOLIO_PCT
then call exit(...) for the relevant positions (e.g., iterate and call
this.exit(pos, "DOLLAR_LOSS_CAP", 100, true) for each open/partial PositionRow)
and return true; otherwise return false. Ensure you reference checkDollarStop,
PositionRow, portfolioValueUsd, MAX_DOLLAR_LOSS_PORTFOLIO_PCT, and exit when
making the change.

In `@src/index.ts`:
- Around line 37-44: shutdown currently closes the DB and exits immediately
which can race with in-flight Fastify requests; modify the shutdown function
(shutdown) to be async, stopRecentTradesCleanup() first, then gracefully close
the Fastify server instance (await server.close() or await fastify.close()),
only after that close the SQLite handle (db.close()) and finally call
process.exit(0); wrap awaits in try/catch to log errors and ensure the function
awaits server.close() before db.close() and process.exit so no in-flight
requests hit a closed DB.

In `@src/storage/migrations/005_co_buyer_index.sql`:
- Around line 5-6: The migration currently recreates the deprecated index
idx_trades_token_type_time on trades which is immediately dropped by
006_co_buyer_index_covering.sql; update 005_co_buyer_index.sql to avoid churn by
either removing the CREATE INDEX for idx_trades_token_type_time (make this
migration a no-op) or change it to create the final covering index shape used by
006 (i.e., match the exact columns/covering/inclusion that 006 creates) so the
index is not created then dropped during startup; adjust the SQL in migration
005 to reference the same index definition/name as the final covering index or
remove the statement entirely.
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

**Run ID**: `49ebf880-8116-483c-aa84-cfa573ca01d2`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and baf126a17d7e65b7efb0d17a9b63d831c9d8096f.

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
* .env.example
* src/jobs/cleanup.ts
* src/frontend/pages/Wallets.tsx
* src/frontend/pages/Settings.tsx
* src/frontend/components/ConvergenceCard.tsx
* src/frontend/components/StatusBadge.tsx
* src/frontend/pages/History.tsx
* src/frontend/hooks/useSSE.ts
* src/jobs/catchup.ts
* src/jobs/token-metadata.ts
* src/utils/retry.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
