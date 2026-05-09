**Actionable comments posted: 13**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (2)</summary><blockquote>
> 
> <details>
> <summary>src/execution/risk-engine.ts (1)</summary><blockquote>
> 
> `117-165`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_
> 
> **Apply the portfolio hard cap before the downstream size gates.**
> 
> `sizeUsd` / `adjustedSizePct` are checked against pool-TVL share, max exposure, and portfolio heat before Lines 161-163 clamp them to `MAX_POSITION_PORTFOLIO_PCT` / `MAX_POSITION_USD`. That means a large portfolio can reject an entry based on a preliminary 5% size even when the final capped size is 2% / $2k and would pass those guards. Compute the capped size first and use that value consistently for the later checks.
>  
> 
> As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade).
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/risk-engine.ts` around lines 117 - 165, The current flow
> computes sizeUsd from adjustedSizePct and only applies the hard cap (hardCapUsd
> / finalSizeUsd / finalSizePct) at the end, causing downstream gates (pool TVL
> check, exposure check via openExposurePct, and portfolioHeatPct) to use an
> uncapped size; move the hard-cap computation up: compute hardCapUsd =
> Math.min(portfolioValueUsd * MAX_POSITION_PORTFOLIO_PCT / 100, MAX_POSITION_USD)
> and derive finalSizeUsd = Math.min(sizeUsd, hardCapUsd) and finalSizePct =
> (finalSizeUsd / portfolioValueUsd) * 100 before any checks that use size/percent
> (specifically replace usages of sizeUsd or adjustedSizePct in the pool-TVL
> guard, exposure check (openExposurePct + ...), and portfolioHeatPct calculation
> with finalSizeUsd/finalSizePct), and ensure the returned adjustedSizePct and
> sizeUsd use finalSizePct and finalSizeUsd.
> ```
> 
> </details>
> 
> </blockquote></details>
> <details>
> <summary>src/index.ts (1)</summary><blockquote>
> 
> `75-82`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **Guard the wallet-scorer job against overlap.**
> 
> The 60-second startup timer and the 09:43 scheduler both call `scorerJob()` unguarded. A deploy around 09:43 can run two scorer passes concurrently against the same SQLite handle / Helius budget, with last-writer-wins wallet scores.
> 
> <details>
> <summary>Minimal guard</summary>
> 
> ```diff
> +  let scorerJobRunning = false;
> -  const scorerJob = () => runWalletScorer(wallets, trades, helius, monitor).catch((err) => {
> -    logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "wallet-scorer: job failed");
> -  });
> +  const scorerJob = async () => {
> +    if (scorerJobRunning) return;
> +    scorerJobRunning = true;
> +    try {
> +      await runWalletScorer(wallets, trades, helius, monitor);
> +    } catch (err) {
> +      logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "wallet-scorer: job failed");
> +    } finally {
> +      scorerJobRunning = false;
> +    }
> +  };
> ```
> </details>
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/index.ts` around lines 75 - 82, The wallet-scorer job can be invoked
> concurrently by the startup setTimeout and the scheduled setInterval, risking
> concurrent runs of runWalletScorer against the same SQLite/Helius resources; add
> a guard around scorerJob to prevent overlap by tracking an "inFlight" flag or
> Promise (e.g., a boolean isRunning or currentRun Promise) inside the scorerJob
> closure, return immediately if a run is active, set the flag before calling
> runWalletScorer(wallets, trades, helius, monitor) and clear it in a finally
> block (preserving the existing logger.error behavior on rejection), and use that
> guarded scorerJob for both the setTimeout and setInterval triggers so only one
> scorer run executes at a time.
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>♻️ Duplicate comments (11)</summary><blockquote>

<details>
<summary>src/blockchain/helius-client.ts (1)</summary><blockquote>

`183-186`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Parse HTTP-date `Retry-After` values too.**

This helper only accepts numeric seconds. If Helius or an upstream CDN returns the date form, `retryAfterSeconds` becomes `null` and callers lose the provider backoff signal on the exact rate-limit path this change is trying to preserve.

   

<details>
<summary>Minimal fix</summary>

```diff
 function parseRetryAfter(header: string | null): number | null {
   if (!header) return null;
   const seconds = Number(header);
-  return Number.isFinite(seconds) ? seconds : null;
+  if (Number.isFinite(seconds)) return Math.max(0, seconds);
+  const retryAt = Date.parse(header);
+  if (!Number.isFinite(retryAt)) return null;
+  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
 }
```
</details>

As per coding guidelines, "`src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals)."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/helius-client.ts` around lines 183 - 186, The parseRetryAfter
function only handles numeric seconds and ignores HTTP-date values; update
parseRetryAfter(header: string | null) to first trim the header and attempt to
parse it as a number (return Number if finite), and if that fails, try parsing
it as an HTTP-date via Date.parse(header) and return the positive seconds
difference between the parsed date and Date.now() (rounded up to seconds) or
null if invalid/past; reference parseRetryAfter and any callers that read
retryAfterSeconds to ensure they get the numeric second value for proper
backoff.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/scorer.ts (2)</summary><blockquote>

`95-98`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Run MEV/wash detection on the same fill set as position scoring.**

`buildPositions()` merges persisted `trades` with live `heliusTxs`, but `computeHoldTimes()` and `detectWashTrading()` only see `trades`. Fresh swap activity can therefore affect P&L immediately while MEV/wash demotion lags until ingestion lands, so the two scoring paths diverge on the same wallet.

  

As per coding guidelines, "`src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 95 - 98, The MEV and wash-detection logic
is running on only persisted trades while position scoring uses the merged set
from buildPositions(), causing divergence; update the scorer to run
computeHoldTimes(...) and detectWashTrading(...) on the same merged fills that
buildPositions() produces (the combined trades+heliusTxs set) rather than the
raw persisted trades so median(...) and MEV_HOLD_TIME_THRESHOLD_SEC checks and
detectWashTrading(...) use identical input; locate buildPositions(), the merged
fills output it creates, and replace the calls that pass `trades` into
computeHoldTimes and detectWashTrading with the merged fills (or add a small
adapter function to extract fills from the merged positions) so both scoring
paths see the same data.
```

</details>

---

`37-84`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Make the MEV/wash matchers quantity-aware.**

Both helpers still `shift()` a whole buy lot on any sell. A partial exit therefore records a full round-trip and deletes the remaining size, which skews `medianHoldTimeSec`, `washCount`, and can falsely demote wallets.

  

As per coding guidelines, "`src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 37 - 84, computeHoldTimes and
detectWashTrading assume whole-lot matching (queue.shift()) and ignore partial
fills; change both to consume buys by quantity: when processing a SELL in
buyQueueByMint, iterate consuming queued buys until the sell quantity is filled,
decrementing the matched buy's remaining quantity and only removing it when
exhausted; for each consumed quantity record proportional hold-time
contributions (e.g., push one entry per unit or weight entries by matched size)
so medianHoldTimeSec, washCount and roundTripCount are quantity-aware; apply the
same quantity-aware matching in detectWashTrading (use WASH_TRADE_WINDOW_SEC and
WASH_TRADE_FRACTION_THRESHOLD as before) and refer to the TradeRow quantity
field (replace t.quantity/t.size with the actual property name in your model)
when implementing.
```

</details>

</blockquote></details>
<details>
<summary>src/api/routes/webhooks.ts (2)</summary><blockquote>

`77-85`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**This SELL hot-path lookup still needs a matching composite index.**

This query filters by `wallet_address`, `token_mint`, and `block_time` on every SELL webhook. Without a leading composite index on those columns, SQLite will keep scanning and filtering far more rows than necessary as `trades` grows. Add the companion migration for `(wallet_address, token_mint, block_time)`.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/api/routes/webhooks.ts` around lines 77 - 85, Add a new DB migration that
creates a composite index on the trades table for (wallet_address, token_mint,
block_time) (suggested index name: idx_trades_wallet_token_block_time) so the
SELL hot-path query (the SELECT ... FROM trades WHERE wallet_address = ?, AND
token_mint = ?, AND (block_time < ? OR (block_time = ? AND tx_signature != ?)))
uses the index; ensure the migration runs during startup/migrations and uses IF
NOT EXISTS so repeated deployments are safe.
```

</details>

---

`68-85`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Same-second fills can still distort `sellPct`.**

`(block_time < ? OR (block_time = ? AND tx_signature != ?))` still pulls in every other fill from that second, including later ones. A replayed older SELL can therefore subtract future same-second BUY/SELL rows, and same-tx multi-instruction fills are still indistinguishable here. Fence on a deterministic sequence key such as `(block_time, tx_signature, instruction_index/rowid)` or keep a per-batch running balance instead.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/api/routes/webhooks.ts` around lines 68 - 85, computePreSellBalance is
still including other fills from the same block_time second and can subtract
future same-second trades; update the exclusion logic to use a deterministic
ordering tuple instead of just tx_signature: add and use instruction_index (or
fallback to SQLite rowid) in the trades table and change the WHERE clause in
computePreSellBalance to exclude all rows whose (block_time, tx_signature,
instruction_index) are >= the current trade's tuple; adjust the prepared
statement parameters and call sites in computePreSellBalance to pass the current
trade's instruction_index (or rowid) so same-second and same-tx
multi-instruction fills are correctly fenced out.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-manager.ts (2)</summary><blockquote>

`340-346`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**This “portfolio” stop still only measures the current position.**

`checkDollarStop()` computes one position's unrealized loss and divides by total portfolio value. If several `OPEN`/`PARTIAL` positions are each down below the threshold, aggregate drawdown can already exceed `MAX_DOLLAR_LOSS_PORTFOLIO_PCT` and this guard never fires. Sum unrealized losses across all active positions, using `priceUsd` for the current row and stored current prices for the rest, before deciding the exit.
  

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade).

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 340 - 346, checkDollarStop
currently computes unrealized loss for only the given PositionRow; instead
aggregate unrealized losses across all active positions and use that aggregate
to decide the dollar-stop. Modify checkDollarStop(PositionRow, priceUsd) to
iterate active positions (states OPEN/PARTIAL), compute each position's
unrealized loss using priceUsd for the supplied position and the stored current
price field (e.g., position.current_price_usd or equivalent) for the others, sum
only positive losses, divide by portfolioValueUsd() and compare to
MAX_DOLLAR_LOSS_PORTFOLIO_PCT, and if exceeded call exit(position,
"DOLLAR_LOSS_CAP", 100, true) for the current row; keep using
portfolioValueUsd() and MAX_DOLLAR_LOSS_PORTFOLIO_PCT as before.
```

</details>

---

`75-78`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Require `wallets` or fail whale-sell handling closed.**

`wallets` is still optional here, so any wiring that omits it makes `onWhaleSell()` skip the loser/accumulation-bot filter and exit on untrusted sellers. This should not fail open in the execution path. Require `wallets` in `configure()` or abort whale-sell exits when it is `null`.
  

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade).

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 75 - 78, The configure method
currently leaves this.wallets nullable which allows onWhaleSell to run without
the loser/accumulation-bot filter; update configure(input: { db: AppDatabase;
wallets: WalletModel; priceClient?: JupiterClient; exitHandler?: ExitHandler })
to require wallets, assign this.wallets = input.wallets (no null coalesce),
and/or add an immediate guard that throws an Error if input.wallets is missing
(e.g., in configure or at start of onWhaleSell) so execution never proceeds with
this.wallets === null; reference configure, onWhaleSell, and the wallets
property when making the change.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/dexscreener-client.ts (1)</summary><blockquote>

`68-76`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Don't treat schema drift as “no pairs.”**

Line 75 returns `[]` for any non-array payload, which collapses an upstream schema failure back into the same signal as a confirmed empty market. That makes `getBestPair()` and downstream risk code behave as if liquidity is absent instead of the provider being unhealthy. Throw `DexScreenerTransientError` here and reserve `[]` for 404 or a valid empty array.
  

As per coding guidelines, `src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling and silent error swallowing.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/dexscreener-client.ts` around lines 68 - 76, The code
currently treats any non-array response as an empty market by returning [] (in
the DexScreener client block that parses response.json()), which hides schema
drift; change the behavior in the response handling so that if data is not an
Array you log the invalid payload (use logger.warn with the payload or its type)
and throw a DexScreenerTransientError instead of returning [], reserving [] only
for a 404 or a legitimately empty array; ensure the thrown error propagates up
to getBestPair() so upstream risk logic can handle provider failures, and add a
TODO or implement basic rate-limit handling/retry/backoff around the HTTP call
to avoid silent error swallowing.
```

</details>

</blockquote></details>
<details>
<summary>docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md (1)</summary><blockquote>

`158-160`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**The documented “manual, safe” migration command is still not safe.**

Piping `004_wallet_pnl_tracking.sql` directly into `sqlite3` bypasses the `PRAGMA table_info(wallets)` guard described above and can fail on a DB that already has any of these columns. Point this section at the migration runner, or inline the pre-check here.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md` around
lines 158 - 160, The documented manual migration command unconditionally pipes
004_wallet_pnl_tracking.sql into sqlite3 which can fail if the target columns
already exist; update the docs to either (A) point users to run the project's
migration runner instead of the raw sqlite3 command (reference the migration
runner used in this project) or (B) inline a safe pre-check that queries PRAGMA
table_info(wallets) and only applies each ALTER/CREATE in
004_wallet_pnl_tracking.sql when the corresponding column is absent; mention the
004_wallet_pnl_tracking.sql file by name and the PRAGMA table_info(wallets)
check so readers know to perform the guard before applying the SQL.
```

</details>

</blockquote></details>
<details>
<summary>src/index.ts (1)</summary><blockquote>

`37-44`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Close Fastify before closing SQLite.**

`shutdown()` still closes `db` and exits while `app` is still serving requests and the scheduled jobs are still live. A `SIGTERM` during webhook ingestion or a scheduled write can race `db.close()` and drop the last write. Make shutdown async, await `app.close()`, then stop background work, then close the DB.  
  


Also applies to: 146-149

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 37 - 44, Make shutdown asynchronous and graceful:
change shutdown to async, first await app.close() to stop Fastify from serving
new requests, then stop background work by calling stopRecentTradesCleanup(),
then await db.close() before calling process.exit(0); update the SIGTERM/SIGINT
handlers (and any other shutdown registrations like the other registration
block) to call the async shutdown and properly catch/log errors so process.exit
runs only after resources are closed.
```

</details>

</blockquote></details>
<details>
<summary>docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md (1)</summary><blockquote>

`89-99`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**BUY-only pre-cutoff seeding still creates phantom inventory.**

Seeding FIFO with only pre-cutoff BUYs is not the wallet's opening state at cutoff. Any pre-cutoff SELLs are ignored, so an in-window SELL can match lots that were already closed before the window, overstating `realized_sol_30d`, `n_closed_30d`, and downstream `wallet_class`. Seed net inventory as of cutoff, or feed full pre-cutoff history into the matcher.  
  


Also applies to: 143-145

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md` around lines
89 - 99, The current seeding logic populates matchFifo with only pre-cutoff BUYs
which ignores pre-cutoff SELLs and produces phantom inventory; update the
seeding so matchFifo reflects the net inventory at cutoff by either (A) feeding
the full pre-cutoff trade history (both BUY and SELL) into the matcher (e.g.,
the same matcher that produces unmatched_sells) so prior closes remove lots
correctly, or (B) computing net positions as of cutoff and seeding matchFifo
with net lots/quantities rather than only BUYs; ensure downstream metrics
(realized_sol_30d, n_closed_30d, wallet_class) are derived from this corrected
seeded state and verify the 30-day window logic still attributes cycles by SELL
block_time.
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
In `@docs/superpowers/plans/2026-05-09-coderabbit-review-4.md`:
- Around line 282-295: The startup scheduled call bypasses the mutex because
setTimeout currently invokes leaderboardJob directly; change both entry points
to use leaderboardJobGuarded so the leaderboardRunning guard covers startup and
interval triggers. Specifically, ensure the initial setTimeout uses
leaderboardJobGuarded instead of leaderboardJob, and keep the interval branch
that calls leaderboardJobGuarded (which wraps runLeaderboardRefresh and toggles
leaderboardRunning) so all invocations go through the same mutex-protected
function.
- Around line 149-176: The revalidation loop added after the alpha boost uses
Date.now() and Math.max(threshold, ...), causing replay-divergence and a
different floor than the original tier logic; change the loop in the hasTopAlpha
branch to anchor the window to the latest buy timestamp (compute latestBuyTime =
max(recentBuys.map(t => t.block_time))) instead of Date.now(), compute tierSince
= latestBuyTime - tierWindowSeconds, and remove the Math.max so the gate uses
only getMinWalletsForTier(tier) when checking tierWallets.size; keep the same
tier downgrading sequence and logger.info call.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-5.md`:
- Around line 120-124: The comparator for sortedTrades currently forces BUY
before SELL on equal block_time which can misstate inventory and P&L; change the
sort to preserve original input order for ties by capturing each trade's
original index (from trades) and using that index as the final tie-breaker
instead of checking trade.type; keep the primary comparison on block_time and
remove the a.type === b.type / BUY check so trades with equal block_time remain
in their original sequence (reference sortedTrades, trades, block_time, and
type).
- Around line 53-74: The unbounded while (true) retry around
birdEyeClient.getSolUsdAt can hang indefinitely on repeated 429s; add a retry
budget or total wait deadline so the loop gives up and surfaces an error once
exhausted. Implement one of: a maxRetries counter (e.g., MAX_429_RETRIES) that
increments on BirdEyeRateLimitError and throws after exceeding it, or a hard
deadline (e.g., start = Date.now(); if Date.now() - start > MAX_TOTAL_WAIT_MS
throw) that also accounts for error.retryAfterSeconds; update the retry branch
around BirdEyeRateLimitError (the block catching errors from
birdEyeClient.getSolUsdAt) to enforce the chosen limit, log a clear failure
message, and ensure cached/solUsdCache and subsequent sleep(RATE_LIMIT_DELAY_MS)
are only reached on success.

In `@src/__tests__/convergence-quality-gate.test.ts`:
- Around line 32-56: Add a control run to each test that proves the alpha wallet
actually causes the uplift: call setup(), insert the non-alpha triggers (use
insertWallet and insertBuy for the other wallets/tokens) but do NOT insert the
alpha wallet, then call ctx.engine.checkConvergence(newTrade) and assert the
tier is lower (e.g., not NOTABLE/CRITICAL) before inserting the alpha and
re-running checkConvergence to assert the boosted tier; alternatively (or
additionally) assert a boost-specific observable on the returned convergence
(e.g., convergence.boosted or convergence.boostReason) after the alpha insert to
prove the alpha-boost path ran, referencing setup(), insertWallet, insertBuy,
and ctx.engine.checkConvergence to locate changes.

In `@src/__tests__/leaderboard-script.test.ts`:
- Around line 23-47: The test's query only uses `block_time > ?` so it doesn't
cover the edge case where a BUY happens before the cutoff and a SELL inside the
window; update the test data used by `buildWalletMetrics` to include a
pre-cutoff BUY trade for the same wallet/mint and a corresponding in-window SELL
trade (i.e., ensure the BUY has block_time <= cutoff and the SELL has block_time
> cutoff) so the seeded-inventory regression for
`realized_sol_30d`/`n_closed_30d` is exercised; modify the `trades` fixture (the
rows returned to `buildWalletMetrics`) to include these two trades for
"wallet-a" and the same `token_mint` so the metrics calculation is validated.

In `@src/__tests__/threshold.test.ts`:
- Around line 10-12: Add a new unit test in the same test suite to assert
getThreshold(0, 10) returns 2 so the lower-bound clamp path is covered; locate
the test block using the existing test case referencing getThreshold and add a
second it/assertion that calls getThreshold with core=0 and the same max (10)
and expects 2.

In `@src/engine/fifo-matcher.ts`:
- Around line 92-127: The current code aggregates all matched lots into one
ClosedCycle after the while loop, losing per-lot hold times; change the logic in
fifo-matcher.ts so that each consumption of a BUY lot (inside the while over
pair.lots) emits its own ClosedCycle entry. For each iteration where you compute
take, ratio, takeSol, takeUsd and update lot.tok/lot.sol/lot.usd, compute the
proceeds for that take as proceedsSol = sellSol * (take / trade.amount_token)
and proceedsUsd = sellUsd * (take / trade.amount_token), then push a cycle
object using trade.wallet, trade.mint, cost_sol: takeSol, cost_usd: takeUsd,
proceeds_sol: proceedsSol, proceeds_usd: proceedsUsd, pnl_sol: proceedsSol -
takeSol, pnl_usd: proceedsUsd - takeUsd, hold_time_s: Math.max(0,
trade.block_time - lot.time), and closed_at: trade.block_time. Remove the single
aggregated cycles.push(...) after the loop (the block referencing
matchedTok/oldestBuyTime) so each consumed lot produces its own ClosedCycle and
correct per-lot hold_time_s.

In `@src/execution/jupiter-client.ts`:
- Around line 350-357: The code currently calls rawAmountToUi(…) after
transaction confirmation which can throw if quote.outAmount >
Number.MAX_SAFE_INTEGER; move the representability check to right after
obtaining the quote (i.e., immediately after you set quote/outAmount) and reject
or adjust the swap before submitting the transaction by comparing
quote.outAmount (a BigInt) to BigInt(Number.MAX_SAFE_INTEGER); alternatively,
avoid converting to Number by switching rawAmountToUi or downstream logic to use
exact decimal arithmetic (BigInt + tokenDecimals from tokenDecimals(mint)) so no
Number(...) conversion occurs after confirmation.
- Around line 112-117: The fallback in getPriceUsd currently coerces
raw.outAmount to Number without checking Number.MAX_SAFE_INTEGER which can
silently round huge values; modify the fallbackOutputAmount handling inside
getPriceUsd to mirror getQuote/rawAmountToUi by parsing outAmount as a string
and converting to BigInt (or checking against Number.MAX_SAFE_INTEGER) before
doing arithmetic, e.g., use BigInt(raw.outAmount) or validate
Number(raw.outAmount) <= Number.MAX_SAFE_INTEGER and handle overflow by
returning null or using BigInt math so the computed price remains precise.

In `@src/execution/position-auditor.ts`:
- Around line 22-29: The audit currently checks pos.tier for WATCH quarantine
which can miss cases where the joined convergence tier (pos.conv_tier) indicates
WATCH; update the checks in the position-auditor logic to use the effective tier
(use pos.conv_tier ?? pos.tier) when deciding WATCH quarantine instead of
pos.tier directly, while leaving the other validations (entry_price_usd,
current_price_usd, amount_token, wallet_count, null convergence check)
unchanged; ensure any diagnostic string still references the effective tier
decision so orphaned/backing-convergence behavior is preserved.

In `@src/execution/trade-executor.ts`:
- Around line 200-201: The current conversion uses Number(amountLamports) which
loses precision for values > 2^53-1; replace the unsafe coercion in the block
that sets amountLamports and actualSellTokenAmount by using an
arbitrary-precision library (e.g., BigInt, bn.js or decimal.js) to compute
actualSellTokenAmount = amountLamports / scale without converting to JS Number,
or if you must use Number, validate amountLamports against
Number.MAX_SAFE_INTEGER first and throw/log an error; update references to
amountLamports and scale (and any downstream logic that expects a Number) to
accept the big-number result or a safe decimal string to avoid corrupting P&L.

---

Outside diff comments:
In `@src/execution/risk-engine.ts`:
- Around line 117-165: The current flow computes sizeUsd from adjustedSizePct
and only applies the hard cap (hardCapUsd / finalSizeUsd / finalSizePct) at the
end, causing downstream gates (pool TVL check, exposure check via
openExposurePct, and portfolioHeatPct) to use an uncapped size; move the
hard-cap computation up: compute hardCapUsd = Math.min(portfolioValueUsd *
MAX_POSITION_PORTFOLIO_PCT / 100, MAX_POSITION_USD) and derive finalSizeUsd =
Math.min(sizeUsd, hardCapUsd) and finalSizePct = (finalSizeUsd /
portfolioValueUsd) * 100 before any checks that use size/percent (specifically
replace usages of sizeUsd or adjustedSizePct in the pool-TVL guard, exposure
check (openExposurePct + ...), and portfolioHeatPct calculation with
finalSizeUsd/finalSizePct), and ensure the returned adjustedSizePct and sizeUsd
use finalSizePct and finalSizeUsd.

In `@src/index.ts`:
- Around line 75-82: The wallet-scorer job can be invoked concurrently by the
startup setTimeout and the scheduled setInterval, risking concurrent runs of
runWalletScorer against the same SQLite/Helius resources; add a guard around
scorerJob to prevent overlap by tracking an "inFlight" flag or Promise (e.g., a
boolean isRunning or currentRun Promise) inside the scorerJob closure, return
immediately if a run is active, set the flag before calling
runWalletScorer(wallets, trades, helius, monitor) and clear it in a finally
block (preserving the existing logger.error behavior on rejection), and use that
guarded scorerJob for both the setTimeout and setInterval triggers so only one
scorer run executes at a time.

---

Duplicate comments:
In `@docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md`:
- Around line 158-160: The documented manual migration command unconditionally
pipes 004_wallet_pnl_tracking.sql into sqlite3 which can fail if the target
columns already exist; update the docs to either (A) point users to run the
project's migration runner instead of the raw sqlite3 command (reference the
migration runner used in this project) or (B) inline a safe pre-check that
queries PRAGMA table_info(wallets) and only applies each ALTER/CREATE in
004_wallet_pnl_tracking.sql when the corresponding column is absent; mention the
004_wallet_pnl_tracking.sql file by name and the PRAGMA table_info(wallets)
check so readers know to perform the guard before applying the SQL.

In `@docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md`:
- Around line 89-99: The current seeding logic populates matchFifo with only
pre-cutoff BUYs which ignores pre-cutoff SELLs and produces phantom inventory;
update the seeding so matchFifo reflects the net inventory at cutoff by either
(A) feeding the full pre-cutoff trade history (both BUY and SELL) into the
matcher (e.g., the same matcher that produces unmatched_sells) so prior closes
remove lots correctly, or (B) computing net positions as of cutoff and seeding
matchFifo with net lots/quantities rather than only BUYs; ensure downstream
metrics (realized_sol_30d, n_closed_30d, wallet_class) are derived from this
corrected seeded state and verify the 30-day window logic still attributes
cycles by SELL block_time.

In `@src/api/routes/webhooks.ts`:
- Around line 77-85: Add a new DB migration that creates a composite index on
the trades table for (wallet_address, token_mint, block_time) (suggested index
name: idx_trades_wallet_token_block_time) so the SELL hot-path query (the SELECT
... FROM trades WHERE wallet_address = ?, AND token_mint = ?, AND (block_time <
? OR (block_time = ? AND tx_signature != ?))) uses the index; ensure the
migration runs during startup/migrations and uses IF NOT EXISTS so repeated
deployments are safe.
- Around line 68-85: computePreSellBalance is still including other fills from
the same block_time second and can subtract future same-second trades; update
the exclusion logic to use a deterministic ordering tuple instead of just
tx_signature: add and use instruction_index (or fallback to SQLite rowid) in the
trades table and change the WHERE clause in computePreSellBalance to exclude all
rows whose (block_time, tx_signature, instruction_index) are >= the current
trade's tuple; adjust the prepared statement parameters and call sites in
computePreSellBalance to pass the current trade's instruction_index (or rowid)
so same-second and same-tx multi-instruction fills are correctly fenced out.

In `@src/blockchain/dexscreener-client.ts`:
- Around line 68-76: The code currently treats any non-array response as an
empty market by returning [] (in the DexScreener client block that parses
response.json()), which hides schema drift; change the behavior in the response
handling so that if data is not an Array you log the invalid payload (use
logger.warn with the payload or its type) and throw a DexScreenerTransientError
instead of returning [], reserving [] only for a 404 or a legitimately empty
array; ensure the thrown error propagates up to getBestPair() so upstream risk
logic can handle provider failures, and add a TODO or implement basic rate-limit
handling/retry/backoff around the HTTP call to avoid silent error swallowing.

In `@src/blockchain/helius-client.ts`:
- Around line 183-186: The parseRetryAfter function only handles numeric seconds
and ignores HTTP-date values; update parseRetryAfter(header: string | null) to
first trim the header and attempt to parse it as a number (return Number if
finite), and if that fails, try parsing it as an HTTP-date via
Date.parse(header) and return the positive seconds difference between the parsed
date and Date.now() (rounded up to seconds) or null if invalid/past; reference
parseRetryAfter and any callers that read retryAfterSeconds to ensure they get
the numeric second value for proper backoff.

In `@src/engine/scorer.ts`:
- Around line 95-98: The MEV and wash-detection logic is running on only
persisted trades while position scoring uses the merged set from
buildPositions(), causing divergence; update the scorer to run
computeHoldTimes(...) and detectWashTrading(...) on the same merged fills that
buildPositions() produces (the combined trades+heliusTxs set) rather than the
raw persisted trades so median(...) and MEV_HOLD_TIME_THRESHOLD_SEC checks and
detectWashTrading(...) use identical input; locate buildPositions(), the merged
fills output it creates, and replace the calls that pass `trades` into
computeHoldTimes and detectWashTrading with the merged fills (or add a small
adapter function to extract fills from the merged positions) so both scoring
paths see the same data.
- Around line 37-84: computeHoldTimes and detectWashTrading assume whole-lot
matching (queue.shift()) and ignore partial fills; change both to consume buys
by quantity: when processing a SELL in buyQueueByMint, iterate consuming queued
buys until the sell quantity is filled, decrementing the matched buy's remaining
quantity and only removing it when exhausted; for each consumed quantity record
proportional hold-time contributions (e.g., push one entry per unit or weight
entries by matched size) so medianHoldTimeSec, washCount and roundTripCount are
quantity-aware; apply the same quantity-aware matching in detectWashTrading (use
WASH_TRADE_WINDOW_SEC and WASH_TRADE_FRACTION_THRESHOLD as before) and refer to
the TradeRow quantity field (replace t.quantity/t.size with the actual property
name in your model) when implementing.

In `@src/execution/position-manager.ts`:
- Around line 340-346: checkDollarStop currently computes unrealized loss for
only the given PositionRow; instead aggregate unrealized losses across all
active positions and use that aggregate to decide the dollar-stop. Modify
checkDollarStop(PositionRow, priceUsd) to iterate active positions (states
OPEN/PARTIAL), compute each position's unrealized loss using priceUsd for the
supplied position and the stored current price field (e.g.,
position.current_price_usd or equivalent) for the others, sum only positive
losses, divide by portfolioValueUsd() and compare to
MAX_DOLLAR_LOSS_PORTFOLIO_PCT, and if exceeded call exit(position,
"DOLLAR_LOSS_CAP", 100, true) for the current row; keep using
portfolioValueUsd() and MAX_DOLLAR_LOSS_PORTFOLIO_PCT as before.
- Around line 75-78: The configure method currently leaves this.wallets nullable
which allows onWhaleSell to run without the loser/accumulation-bot filter;
update configure(input: { db: AppDatabase; wallets: WalletModel; priceClient?:
JupiterClient; exitHandler?: ExitHandler }) to require wallets, assign
this.wallets = input.wallets (no null coalesce), and/or add an immediate guard
that throws an Error if input.wallets is missing (e.g., in configure or at start
of onWhaleSell) so execution never proceeds with this.wallets === null;
reference configure, onWhaleSell, and the wallets property when making the
change.

In `@src/index.ts`:
- Around line 37-44: Make shutdown asynchronous and graceful: change shutdown to
async, first await app.close() to stop Fastify from serving new requests, then
stop background work by calling stopRecentTradesCleanup(), then await db.close()
before calling process.exit(0); update the SIGTERM/SIGINT handlers (and any
other shutdown registrations like the other registration block) to call the
async shutdown and properly catch/log errors so process.exit runs only after
resources are closed.
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

**Run ID**: `67c5b671-31b8-4fdc-825c-5a81f1b9b728`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and 136398302f4a2279e1b9c409c804ca9885fdb147.

</details>

<details>
<summary>📒 Files selected for processing (88)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `docs/audit-report.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-10-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-11-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-12-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-13-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-5-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-6-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-7-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-8-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-9-raw.md`
* `docs/superpowers/plans/2026-05-04-safety-gates-fix.md`
* `docs/superpowers/plans/2026-05-04-whale-watcher-pro-upgrade.md`
* `docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md`
* `docs/superpowers/plans/2026-05-06-pnl-leaderboard.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-10.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-11.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-12.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-13.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-3.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-4.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-5.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-6.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-7.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-8.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-review-9.md`
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
* `src/storage/migrations/008_trades_wallet_token_time_index.sql`
* `src/storage/models/wallets.ts`
* `src/utils/retry.ts`

</details>

<details>
<summary>💤 Files with no reviewable changes (12)</summary>

* src/frontend/hooks/useSSE.ts
* src/frontend/components/ConvergenceCard.tsx
* src/utils/retry.ts
* src/frontend/components/StatusBadge.tsx
* src/jobs/token-metadata.ts
* src/frontend/pages/Settings.tsx
* src/frontend/pages/Wallets.tsx
* src/jobs/catchup.ts
* src/frontend/components/WalletTable.tsx
* src/jobs/cleanup.ts
* src/frontend/pages/History.tsx
* .env.example

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
