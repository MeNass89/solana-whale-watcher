**Actionable comments posted: 7**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (2)</summary><blockquote>
> 
> <details>
> <summary>src/execution/jupiter-client.ts (1)</summary><blockquote>
> 
> `186-192`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **Live swap records quoted output, not actual fill.**
> 
> `outputAmount` at line 189 comes from `quote.outAmount`, but the actual tokens received could differ due to slippage or MEV. Lines 181-184 verify the balance increased but don't use the actual delta for the returned `SwapResult`. This means recorded P&L can drift from reality.
> 
> For paper trading this is fine (no real execution), but for live mode this could accumulate accounting error over time.
> 
> 
> 
> <details>
> <summary>Proposed fix</summary>
> 
> ```diff
>      await this.waitForConfirmation(signature);
>      const afterBalance = await this.tokenBalance(params.outputMint);
>      if (afterBalance <= beforeBalance && !params.isExitSwap) {
>        throw new Error("Swap signature confirmed but output token balance did not increase");
>      }
> +    const actualOutputRaw = BigInt(afterBalance) - BigInt(beforeBalance);
> +    const actualOutputAmount = await this.rawAmountToUi(params.outputMint, actualOutputRaw, quote.outputDecimals);
> 
>      return {
>        txSignature: signature,
>        inputAmount: await this.rawAmountToUi(params.inputMint, params.amountLamports, quote.inputDecimals),
> -      outputAmount: await this.rawAmountToUi(params.outputMint, BigInt(quote.outAmount), quote.outputDecimals),
> +      outputAmount: actualOutputAmount,
>        priceImpactPct: Number(quote.priceImpactPct ?? 0),
>        executedAt: Math.floor(Date.now() / 1000)
>      };
> ```
> </details>
> 
> As per coding guidelines, "Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L."
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/jupiter-client.ts` around lines 186 - 192, The returned
> SwapResult currently uses quote.outAmount for outputAmount which records quoted
> output instead of the actual filled amount; change SwapResult.outputAmount to
> use the real balance delta computed earlier (the post/pre balance difference
> verified in lines around balance checks) converted via rawAmountToUi (pass the
> appropriate mint and decimals, using BigInt for the delta) instead of
> BigInt(quote.outAmount), while keeping txSignature, priceImpactPct and
> executedAt as-is; ensure this branch is used for live execution (paper mode can
> keep quote.outAmount) and preserve types/decimals (outputMint and
> quote.outputDecimals) when calling rawAmountToUi.
> ```
> 
> </details>
> 
> </blockquote></details>
> <details>
> <summary>src/execution/position-manager.ts (1)</summary><blockquote>
> 
> `228-241`: _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
> 
> **P&L calculation uses post-partial-exit amount, not original position size.**
> 
> When `markExit` is called for the final exit (`remainingAmount === 0`), the P&L is computed as:
> ```typescript
> const pnlUsd = position.amount_token * (priceUsd - position.entry_price_usd);
> ```
> 
> After partial exits, `amount_token` has already been reduced (line 240 runs `UPDATE ... SET amount_token = ?` with the remaining amount). So the final P&L only reflects the last tranche, not the full position.
> 
> **Example:**
> 1. Open 1000 tokens at $1.00
> 2. Partial exit 50% at $1.50 → `amount_token` becomes 500, `pnl_usd = null`
> 3. Final exit at $2.00 → `pnl_usd = 500 * (2.00 - 1.00) = $500`
> 4. Actual P&L should be: `500 * ($1.50 - $1.00) + 500 * ($2.00 - $1.00) = $750`
> 
> Either accumulate partial P&L on each exit, or store the original amount separately for final calculation.
> 
> 
> 
> 
> <details>
> <summary>🔧 Suggested fix: accumulate P&L on each partial exit</summary>
> 
> ```diff
>  markExit(position: PositionRow, remainingAmount: number, priceUsd: number, reason: string): void {
>    const status = remainingAmount > 0 ? "PARTIAL" : "CLOSED";
> -  const pnlUsd = remainingAmount > 0 ? null : position.amount_token * (priceUsd - position.entry_price_usd);
> -  const pnlPct = remainingAmount > 0 ? null : ((priceUsd - position.entry_price_usd) / position.entry_price_usd) * 100;
> +  const soldAmount = position.amount_token - remainingAmount;
> +  const incrementalPnlUsd = soldAmount * (priceUsd - position.entry_price_usd);
> +  // Accumulate P&L; final pnl_pct computed on close
> +  const pnlPct = remainingAmount > 0 ? null : ((priceUsd - position.entry_price_usd) / position.entry_price_usd) * 100;
>    this.requireDb()
>      .prepare(
>        `UPDATE positions
> -       SET amount_token = ?, current_price_usd = ?, status = ?, exit_reason = ?,
> -           pnl_usd = COALESCE(?, pnl_usd), pnl_pct = COALESCE(?, pnl_pct),
> +       SET amount_token = ?, current_price_usd = ?, status = ?, exit_reason = ?,
> +           pnl_usd = COALESCE(pnl_usd, 0) + ?, pnl_pct = COALESCE(?, pnl_pct),
>             closed_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE closed_at END
>         WHERE id = ?`
>      )
> -    .run(remainingAmount, priceUsd, status, reason, pnlUsd, pnlPct, status, unixNow(), position.id);
> +    .run(remainingAmount, priceUsd, status, reason, incrementalPnlUsd, pnlPct, status, unixNow(), position.id);
>  }
> ```
> </details>
> 
> As per coding guidelines, `src/execution/**`: Flag any code that could corrupt P&L.
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/position-manager.ts` around lines 228 - 241, markExit computes
> final P&L using position.amount_token which has already been reduced by partial
> exits, causing underreported P&L; update markExit to use either the original
> position size (e.g., a stored original_amount or entry_amount field on
> PositionRow) when computing pnlUsd/pnlPct for a complete close, or accumulate
> realized P&L on every exit by adding the P&L for the tranche being removed to an
> existing realized_pnl field before setting amount_token to remainingAmount;
> adjust the SQL in markExit (the UPDATE prepared statement) and the P&L
> calculation so pnl_usd/pnl_pct are incremented (or computed from
> original_amount) only for the tranche being closed and not from the
> already-updated amount_token.
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>♻️ Duplicate comments (9)</summary><blockquote>

<details>
<summary>scripts/start-funnel.sh (1)</summary><blockquote>

`21-31`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Wait briefly for the funnel bind before declaring startup failure.**

This still does a single immediate `funnel status` probe after `funnel --bg 3000`. If the bind completes a second later, the script exits anyway, clears `tunnel-url.txt`, and can bounce in a launchd restart loop during a healthy-but-slow startup.

  

<details>
<summary>🔧 Minimal hardening</summary>

```diff
   if ! "$TS_BIN" funnel --bg 3000 >> "$LOGFILE" 2>&1; then
     : > "$URL_FILE"
     log "ERROR: failed to start funnel"
     exit 1
   fi
-  if ! "$TS_BIN" funnel status 2>/dev/null | grep -q "127.0.0.1:3000"; then
+  ready=0
+  for _ in {1..10}; do
+    if "$TS_BIN" funnel status 2>/dev/null | grep -q "127.0.0.1:3000"; then
+      ready=1
+      break
+    fi
+    sleep 1
+  done
+  if [ "$ready" -ne 1 ]; then
     : > "$URL_FILE"
     log "ERROR: funnel start returned success but bind check failed"
     exit 1
   fi
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/start-funnel.sh` around lines 21 - 31, The startup check for funnel
is too eager: after running "$TS_BIN" funnel --bg 3000 the script immediately
runs "$TS_BIN" funnel status and fails if the bind isn't visible; modify the
logic around the existing funnel --bg / funnel status sequence (referencing
TS_BIN, funnel --bg, funnel status, URL_FILE, URL, and log) to retry the bind
check for a short period (e.g., loop with a few attempts and small sleeps)
before declaring failure, only clearing/writing URL_FILE and exiting on final
failure; on success write URL to URL_FILE as before and keep existing log
messages.
```

</details>

</blockquote></details>
<details>
<summary>docs/superpowers/plans/2026-05-09-coderabbit-review-3.md (1)</summary><blockquote>

`26-37`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Keep the Task 1 snippet aligned with the stated 401/403 behavior.**

The prose says only `404` is terminal, but the sample still `break`s on every non-`429`/`5xx` response. If someone follows this plan literally, `401`/`403` and other unexpected `4xx` responses go back to looking like normal pagination exhaustion.

  

<details>
<summary>🩹 Suggested correction</summary>

```diff
 const response = await fetch(url);
 if (!response.ok) {
-  // Rate-limit / server errors should surface to callers (so wallet-scorer
-  // can log + retry next cycle); 4xx-other means malformed request and
-  // pagination must stop, not throw.
-  if (response.status === 429 || response.status >= 500) {
+  // Only the explicit no-more-data response should terminate pagination.
+  if (response.status === 404) {
+    break;
+  }
+  if (response.status >= 400) {
     throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
   }
-  break;
 }
 const batch = (await response.json()) as HeliusTransaction[];
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-3.md` around lines 26 -
37, The sample response-handling snippet is inconsistent with the prose: instead
of breaking for all non-429/5xx responses, ensure any unexpected 4xx (including
401 and 403) throws a HeliusRequestError while only 404 is treated as terminal
pagination exhaustion; update the logic around response.ok/response.status (the
snippet that uses response and HeliusRequestError) so that if response.status
=== 404 you break, if response.status === 429 || response.status >= 500 you
throw a HeliusRequestError, and for any other non-OK 4xx (e.g., 401/403/other)
you also throw a HeliusRequestError containing response.status and a descriptive
message.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-auditor.ts (1)</summary><blockquote>

`22-29`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Validate the backing convergence tier, not the copied position tier.**

This still trusts `positions.tier`. A corrupted/manual row with `tier = 'NOTABLE'` but `conv_tier = 'WATCH'` survives the audit and stays open, which defeats the whole quarantine guard. Reject on `pos.conv_tier === "WATCH"` here, and add a regression case for a tier mismatch so the auditor doesn't trust seeded row state.

  

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-auditor.ts` around lines 22 - 29, The audit is
incorrectly trusting the copied position's tier (pos.tier); change the
WATCH-tier rejection to validate the backing convergence tier (pos.conv_tier ===
"WATCH") instead of pos.tier, and also add an explicit regression check that
flags any tier mismatch between pos.tier and pos.conv_tier (e.g., reject or log
when pos.tier !== pos.conv_tier) so seeded/corrupted rows can't bypass
quarantine; update the logic around the violations array in position-auditor.ts
(look for the existing WATCH-tier check and the orphaned-position checks) and
add a unit test case that inserts a row with tier='NOTABLE' but
conv_tier='WATCH' to ensure the auditor now rejects it.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/helius-client.ts (1)</summary><blockquote>

`183-186`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Parse HTTP-date `Retry-After` values too.**

`Retry-After` can be an HTTP-date, not just delta-seconds. With the current parser, those 429s degrade to `retryAfterSeconds = null`, so callers lose the provider backoff signal and may retry too aggressively.

   

<details>
<summary>Minimal fix</summary>

```diff
 function parseRetryAfter(header: string | null): number | null {
   if (!header) return null;
   const seconds = Number(header);
-  return Number.isFinite(seconds) ? seconds : null;
+  if (Number.isFinite(seconds)) return Math.max(0, seconds);
+  const at = Date.parse(header);
+  if (Number.isNaN(at)) return null;
+  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
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
function currently only handles numeric delta-seconds and returns null for
HTTP-date values; update parseRetryAfter to first attempt to parse the header as
an integer (delta-seconds) and if that fails, try parsing it as an HTTP-date
(using Date.parse) and compute seconds = (dateMs - Date.now())/1000, returning
Math.ceil(seconds) if positive, otherwise null; keep the function name
parseRetryAfter and ensure it still returns number | null and treats
invalid/negative values as null so callers receive correct backoff signals.
```

</details>

</blockquote></details>
<details>
<summary>src/jobs/leaderboard-refresh.ts (1)</summary><blockquote>

`6-16`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**This timeout never protects the synchronous refresh path.**

`refreshLeaderboard()` is synchronous, so while it is running the event loop cannot execute the timer on Line 8. If SQLite or filesystem work wedges, this still blocks indefinitely and the advertised 10-minute timeout never fires. A real timeout here needs a worker/child boundary; otherwise this guard is false confidence.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/jobs/leaderboard-refresh.ts` around lines 6 - 16, The current
runLeaderboardRefresh function uses a timer to reject after
LEADERBOARD_TIMEOUT_MS but calls the synchronous refreshLeaderboard directly, so
the event loop can be blocked and the timer never fires; change
runLeaderboardRefresh to execute the potentially blocking refreshLeaderboard
work in an isolated thread/process (e.g., Worker Threads or a child process) and
wire a real timeout: spawn a worker that runs refreshLeaderboard (or a wrapper
that imports and calls it), start a timeout for LEADERBOARD_TIMEOUT_MS that will
terminate the worker and reject if exceeded, and clear the timeout and resolve
only when the worker reports success; reference runLeaderboardRefresh,
refreshLeaderboard, LEADERBOARD_TIMEOUT_MS and ensure you call
worker.terminate() / child.kill() on timeout and handle its success/failure
messages to resolve/reject the returned Promise.
```

</details>

</blockquote></details>
<details>
<summary>scripts/leaderboard.ts (1)</summary><blockquote>

`175-189`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**BUY-only pre-cutoff seeding still creates phantom inventory.**

This query pulls in every pre-cutoff BUY but none of the pre-cutoff SELLs. A wallet that fully or partially exited before the window can therefore enter FIFO with lots it no longer owns, and an in-window SELL will match against that phantom inventory and overstate `realized_sol_30d` / `n_closed_30d`. Seed net inventory at cutoff instead: either replay full pre-cutoff history for seeded `(wallet, mint)` pairs or materialize opening lots.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/leaderboard.ts` around lines 175 - 189, The current trades query
(variable trades / RawTrade[]) pulls pre-cutoff BUYs but omits pre-cutoff SELLs,
creating phantom opening lots; fix by seeding net inventory at cutoff instead:
add a preliminary query to aggregate pre-cutoff activity per (wallet_address,
token_mint) (SUM of amount_token for BUY minus SELL and SUM of proceeds if
needed) to materialize opening lots or a net position, then change the main
trades feed to only stream post-cutoff trades (block_time > cutoff) plus any
intentional edge-case buys you want replayed; reference the trades
variable/RawTrade[] and ensure the FIFO processor consumes the generated opening
lots for each (wallet, mint) before applying the post-cutoff trades so in-window
SELLs cannot match phantom inventory.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/scorer.ts (1)</summary><blockquote>

`95-98`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**MEV/wash detection diverges from position scoring — live `heliusTxs` swaps are ignored.**

`computeHoldTimes(trades)` and `detectWashTrading(trades)` only inspect persisted `TradeRow[]`, but `buildPositions(trades, heliusTxs, walletAddress)` at line 91 includes live `heliusTxs`. Rapid buy→sell swaps in `heliusTxs` that haven't persisted to SQLite yet will avoid MEV/wash flagging until the next scoring run after ingestion lands those trades.

This creates a window where a wallet can appear clean during live evaluation but get flagged later — or vice versa, the P&L position includes fills that the MEV detector never sees.

Merge both sources before MEV/wash detection:
```typescript
const allHoldTimes = [...computeHoldTimes(trades), ...computeHoldTimesFromHelius(heliusTxs)];
```

As per coding guidelines, `src/engine/**`: Flag divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 95 - 98, The MEV/wash detection currently
only inspects persisted TradeRow[] (via computeHoldTimes and detectWashTrading)
while buildPositions uses live heliusTxs, causing divergence; fix by merging
live heliusTxs into the trade stream before running MEV/wash checks (e.g., build
a unified list used by computeHoldTimes and detectWashTrading or add a helper
like computeHoldTimesFromHelius and combine its results), so that
computeHoldTimes(...) and detectWashTrading(...) receive the same combined data
used by buildPositions(trades, heliusTxs, walletAddress) for scoring.
```

</details>

</blockquote></details>
<details>
<summary>src/index.ts (1)</summary><blockquote>

`37-44`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Close the HTTP server before tearing down SQLite.**

This still has the same shutdown race: `shutdown()` closes `db` and exits while the Fastify app and scheduled jobs are still alive. A signal during webhook ingestion or a scheduled write can hit a closed handle and drop the last update. Make shutdown async, await `app.close()`, stop/clear the background jobs, then close the DB.

   
<details>
<summary>Suggested fix</summary>

```diff
+  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
+  let shuttingDown = false;
   const shutdown = (signal: string) => {
-    logger.info(signal);
-    stopRecentTradesCleanup();
-    db.close();
-    process.exit(0);
+    if (shuttingDown) return;
+    shuttingDown = true;
+    void (async () => {
+      logger.info(signal);
+      await app?.close();
+      stopRecentTradesCleanup();
+      db.close();
+      process.exit(0);
+    })();
   };
@@
-  const app = await buildServer({ db, wallets, trades, convergences, engine, alerts });
+  app = await buildServer({ db, wallets, trades, convergences, engine, alerts });
```
</details>


Also applies to: 146-148

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 37 - 44, The shutdown flow currently closes db and
exits while the Fastify app and scheduled jobs may still be running; make the
shutdown function async (rename or update shutdown to async shutdown) and in it:
log the signal, await app.close() to stop the HTTP server, stop and clear
background jobs (invoke stopRecentTradesCleanup() and any other scheduled job
stop/clear functions and await them if they return promises), then close the
SQLite DB (await db.close() if async), and only call process.exit(0) after all
awaits complete; update the process.on("SIGTERM") and process.on("SIGINT")
handlers to call the async shutdown and properly handle rejections.
```

</details>

</blockquote></details>
<details>
<summary>docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md (1)</summary><blockquote>

`158-160`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**The documented “manual, safe” migration path is still not safe.**

Piping the raw SQL file bypasses the `PRAGMA table_info(wallets)` guard you describe above. On any DB that already has one of these columns, this command can fail mid-migration.

   
```shell
#!/bin/bash
set -euo pipefail
tmp_db="$(mktemp)"
trap 'rm -f "$tmp_db"' EXIT

sqlite3 "$tmp_db" 'CREATE TABLE wallets (address TEXT PRIMARY KEY, score REAL, state TEXT, active INTEGER, last_scored_at INTEGER);'
sqlite3 "$tmp_db" < src/storage/migrations/004_wallet_pnl_tracking.sql
sqlite3 "$tmp_db" < src/storage/migrations/004_wallet_pnl_tracking.sql
```

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md` around
lines 158 - 160, The documented manual migration (using sqlite3 ... <
src/storage/migrations/004_wallet_pnl_tracking.sql) is unsafe because it blindly
pipes SQL and can fail if the wallets table already has the new columns; update
the docs to show an idempotent, guarded migration command or small shell snippet
that queries PRAGMA table_info('wallets') (or uses "SELECT name FROM
pragma_table_info('wallets') WHERE name='...') for each new column and only
executes the corresponding ALTER TABLE statements from
004_wallet_pnl_tracking.sql if the column is missing, or provide a reproducible
wrapper script that applies the SQL file conditionally to avoid mid-migration
failures.
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
In `@scripts/leaderboard.ts`:
- Around line 108-114: The loop counting n_trades/n_buys/n_sells is incorrectly
including pre-window seed rows; modify the loop in refreshLeaderboard() that
iterates over trades so it only increments these counters for trades that are
within the 30-day window (i.e., skip trades with timestamps before the cutoff
used to seed FIFO). Use the same cutoff variable/logic already present in
refreshLeaderboard() to gate the increments (e.g., check trade.timestamp or
trade.date >= cutoff) and leave seeding behavior unchanged for order
reconciliation but prevent updating
metrics.get(trade.wallet).n_trades/n_buys/n_sells for pre-cutoff trades.
- Around line 170-283: The DatabaseConstructor-created SQLite handle (db) can
leak if an exception is thrown after construction; wrap all uses of db (the
queries, buildWalletMetrics call, file write, transactions, prune logic and
db.close()) in a try/finally so that db.close() always runs—i.e., create db with
DatabaseConstructor(DB_PATH) then immediately enter try { ...existing logic... }
finally { db.close(); } to guarantee closing the handle on success or failure
(reference DatabaseConstructor, db.prepare, writeBack transaction,
tx/pruneCandidates and db.close).

In `@src/__tests__/risk-engine-safety.test.ts`:
- Around line 31-38: Add a boundary test to lock the $5,000 TVL rule: create a
test that uses setupRisk({ volatility: 50, liquidityUsd: 5_000 }), call
engine.checkEntry(convergence, trades, 1) (same as the existing test), and
assert the expected behavior at exactly 5_000 (e.g.,
expect(result.allowed).toBe(true) if the live gate treats 5_000 as allowed, or
toBe(false) if it should be blocked), so the test verifies the exact >= vs >
semantics enforced by engine.checkEntry.

In `@src/__tests__/trade-executor-dedup.test.ts`:
- Around line 17-43: The test currently only inserts an OPEN position; add the
PARTIAL active-position case so dedup blocks reopening after a partial sell: in
the test body (the setup that uses db.prepare(...) to INSERT INTO positions)
either add a second INSERT with status = 'PARTIAL' for a different token_mint or
change the existing insertion to create a PARTIAL row (or add both rows) so that
when TradeExecutor.configure and executor.onConvergence(...) run, the dedup
logic is validated against 'PARTIAL' as well as 'OPEN' (keep references to the
existing TradeExecutor.configure, executor.onConvergence, and the
db.prepare("SELECT COUNT(*) AS count FROM executions") assertion).

In `@src/engine/manipulation-detector.ts`:
- Around line 43-55: computeFreshWalletFraction mixes replay-stable
referenceTime with live lifetime counters (w.total_trades), causing divergent
scores; change the freshness check to use trade counts as of referenceTime
instead of w.total_trades. Either call a historical-aware API on WalletModel
(e.g., a new walletModel.countTradesAsOf(addr, referenceTime) or
walletModel.findAsOf(addr, referenceTime)) or compute the count from the buys
input (count buys for addr with block_time <= referenceTime) and compare that
historical count to the threshold (15) when deciding freshness; keep the other
time-based check (w.added_at > fourteenDaysAgo) similarly evaluated as-of
referenceTime if using stored snapshots.

In `@src/execution/risk-engine.ts`:
- Around line 177-191: When jupiterClient.getPriceUsd(SOL_MINT) returns null/<=0
the code silently returns MIRROR_FALLBACK_PCT; add a warning log and context
before returning the fallback so the condition is observable. Inside the block
that checks "if (!solPriceUsd || solPriceUsd <= 0)" (in the same function that
calls jupiterClient.getPriceUsd), call logger.warn with the same error-context
style used in the catch (include trades.length and portfolioValueUsd and the
returned solPriceUsd) and then return MIRROR_FALLBACK_PCT; keep the existing
throw behavior unchanged for actual exceptions from jupiterClient.getPriceUsd.

In `@src/execution/trade-executor.ts`:
- Around line 197-210: The current amountLamports calculation forces sent = 1n
when the quantized token amount is <1 base unit, which can liquidate dust
positions; change the logic in the amountLamports IIFE (variables:
sellAmountToken, decimals, sent, actualSellTokenAmount) to treat
quantization-to-zero as a no-op: when total < 1n, set sent = 0n and set
actualSellTokenAmount = 0 (instead of forcing 1n), and ensure callers that rely
on amountLamports handle a zero-sell by skipping execution; update
amountLamports/actualSellTokenAmount paths accordingly.

---

Outside diff comments:
In `@src/execution/jupiter-client.ts`:
- Around line 186-192: The returned SwapResult currently uses quote.outAmount
for outputAmount which records quoted output instead of the actual filled
amount; change SwapResult.outputAmount to use the real balance delta computed
earlier (the post/pre balance difference verified in lines around balance
checks) converted via rawAmountToUi (pass the appropriate mint and decimals,
using BigInt for the delta) instead of BigInt(quote.outAmount), while keeping
txSignature, priceImpactPct and executedAt as-is; ensure this branch is used for
live execution (paper mode can keep quote.outAmount) and preserve types/decimals
(outputMint and quote.outputDecimals) when calling rawAmountToUi.

In `@src/execution/position-manager.ts`:
- Around line 228-241: markExit computes final P&L using position.amount_token
which has already been reduced by partial exits, causing underreported P&L;
update markExit to use either the original position size (e.g., a stored
original_amount or entry_amount field on PositionRow) when computing
pnlUsd/pnlPct for a complete close, or accumulate realized P&L on every exit by
adding the P&L for the tranche being removed to an existing realized_pnl field
before setting amount_token to remainingAmount; adjust the SQL in markExit (the
UPDATE prepared statement) and the P&L calculation so pnl_usd/pnl_pct are
incremented (or computed from original_amount) only for the tranche being closed
and not from the already-updated amount_token.

---

Duplicate comments:
In `@docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md`:
- Around line 158-160: The documented manual migration (using sqlite3 ... <
src/storage/migrations/004_wallet_pnl_tracking.sql) is unsafe because it blindly
pipes SQL and can fail if the wallets table already has the new columns; update
the docs to show an idempotent, guarded migration command or small shell snippet
that queries PRAGMA table_info('wallets') (or uses "SELECT name FROM
pragma_table_info('wallets') WHERE name='...') for each new column and only
executes the corresponding ALTER TABLE statements from
004_wallet_pnl_tracking.sql if the column is missing, or provide a reproducible
wrapper script that applies the SQL file conditionally to avoid mid-migration
failures.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-3.md`:
- Around line 26-37: The sample response-handling snippet is inconsistent with
the prose: instead of breaking for all non-429/5xx responses, ensure any
unexpected 4xx (including 401 and 403) throws a HeliusRequestError while only
404 is treated as terminal pagination exhaustion; update the logic around
response.ok/response.status (the snippet that uses response and
HeliusRequestError) so that if response.status === 404 you break, if
response.status === 429 || response.status >= 500 you throw a
HeliusRequestError, and for any other non-OK 4xx (e.g., 401/403/other) you also
throw a HeliusRequestError containing response.status and a descriptive message.

In `@scripts/leaderboard.ts`:
- Around line 175-189: The current trades query (variable trades / RawTrade[])
pulls pre-cutoff BUYs but omits pre-cutoff SELLs, creating phantom opening lots;
fix by seeding net inventory at cutoff instead: add a preliminary query to
aggregate pre-cutoff activity per (wallet_address, token_mint) (SUM of
amount_token for BUY minus SELL and SUM of proceeds if needed) to materialize
opening lots or a net position, then change the main trades feed to only stream
post-cutoff trades (block_time > cutoff) plus any intentional edge-case buys you
want replayed; reference the trades variable/RawTrade[] and ensure the FIFO
processor consumes the generated opening lots for each (wallet, mint) before
applying the post-cutoff trades so in-window SELLs cannot match phantom
inventory.

In `@scripts/start-funnel.sh`:
- Around line 21-31: The startup check for funnel is too eager: after running
"$TS_BIN" funnel --bg 3000 the script immediately runs "$TS_BIN" funnel status
and fails if the bind isn't visible; modify the logic around the existing funnel
--bg / funnel status sequence (referencing TS_BIN, funnel --bg, funnel status,
URL_FILE, URL, and log) to retry the bind check for a short period (e.g., loop
with a few attempts and small sleeps) before declaring failure, only
clearing/writing URL_FILE and exiting on final failure; on success write URL to
URL_FILE as before and keep existing log messages.

In `@src/blockchain/helius-client.ts`:
- Around line 183-186: The parseRetryAfter function currently only handles
numeric delta-seconds and returns null for HTTP-date values; update
parseRetryAfter to first attempt to parse the header as an integer
(delta-seconds) and if that fails, try parsing it as an HTTP-date (using
Date.parse) and compute seconds = (dateMs - Date.now())/1000, returning
Math.ceil(seconds) if positive, otherwise null; keep the function name
parseRetryAfter and ensure it still returns number | null and treats
invalid/negative values as null so callers receive correct backoff signals.

In `@src/engine/scorer.ts`:
- Around line 95-98: The MEV/wash detection currently only inspects persisted
TradeRow[] (via computeHoldTimes and detectWashTrading) while buildPositions
uses live heliusTxs, causing divergence; fix by merging live heliusTxs into the
trade stream before running MEV/wash checks (e.g., build a unified list used by
computeHoldTimes and detectWashTrading or add a helper like
computeHoldTimesFromHelius and combine its results), so that
computeHoldTimes(...) and detectWashTrading(...) receive the same combined data
used by buildPositions(trades, heliusTxs, walletAddress) for scoring.

In `@src/execution/position-auditor.ts`:
- Around line 22-29: The audit is incorrectly trusting the copied position's
tier (pos.tier); change the WATCH-tier rejection to validate the backing
convergence tier (pos.conv_tier === "WATCH") instead of pos.tier, and also add
an explicit regression check that flags any tier mismatch between pos.tier and
pos.conv_tier (e.g., reject or log when pos.tier !== pos.conv_tier) so
seeded/corrupted rows can't bypass quarantine; update the logic around the
violations array in position-auditor.ts (look for the existing WATCH-tier check
and the orphaned-position checks) and add a unit test case that inserts a row
with tier='NOTABLE' but conv_tier='WATCH' to ensure the auditor now rejects it.

In `@src/index.ts`:
- Around line 37-44: The shutdown flow currently closes db and exits while the
Fastify app and scheduled jobs may still be running; make the shutdown function
async (rename or update shutdown to async shutdown) and in it: log the signal,
await app.close() to stop the HTTP server, stop and clear background jobs
(invoke stopRecentTradesCleanup() and any other scheduled job stop/clear
functions and await them if they return promises), then close the SQLite DB
(await db.close() if async), and only call process.exit(0) after all awaits
complete; update the process.on("SIGTERM") and process.on("SIGINT") handlers to
call the async shutdown and properly handle rejections.

In `@src/jobs/leaderboard-refresh.ts`:
- Around line 6-16: The current runLeaderboardRefresh function uses a timer to
reject after LEADERBOARD_TIMEOUT_MS but calls the synchronous refreshLeaderboard
directly, so the event loop can be blocked and the timer never fires; change
runLeaderboardRefresh to execute the potentially blocking refreshLeaderboard
work in an isolated thread/process (e.g., Worker Threads or a child process) and
wire a real timeout: spawn a worker that runs refreshLeaderboard (or a wrapper
that imports and calls it), start a timeout for LEADERBOARD_TIMEOUT_MS that will
terminate the worker and reject if exceeded, and clear the timeout and resolve
only when the worker reports success; reference runLeaderboardRefresh,
refreshLeaderboard, LEADERBOARD_TIMEOUT_MS and ensure you call
worker.terminate() / child.kill() on timeout and handle its success/failure
messages to resolve/reject the returned Promise.
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

**Run ID**: `a2e76895-b458-4260-b707-18b2c68e3e16`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and 529c8e7502099fbc20698ab76742ee09f745b908.

</details>

<details>
<summary>📒 Files selected for processing (69)</summary>

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
* `src/storage/migrations/008_trades_wallet_token_time_index.sql`
* `src/storage/models/wallets.ts`
* `src/utils/retry.ts`

</details>

<details>
<summary>💤 Files with no reviewable changes (12)</summary>

* src/frontend/pages/Settings.tsx
* src/frontend/components/StatusBadge.tsx
* src/frontend/components/ConvergenceCard.tsx
* src/frontend/pages/Wallets.tsx
* src/frontend/pages/History.tsx
* src/frontend/hooks/useSSE.ts
* src/jobs/cleanup.ts
* src/utils/retry.ts
* src/jobs/catchup.ts
* src/frontend/components/WalletTable.tsx
* src/jobs/token-metadata.ts
* .env.example

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
