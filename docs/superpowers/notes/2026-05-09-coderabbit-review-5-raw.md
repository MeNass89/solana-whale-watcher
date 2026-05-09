**Actionable comments posted: 8**

<details>
<summary>♻️ Duplicate comments (12)</summary><blockquote>

<details>
<summary>src/storage/migrations/005_co_buyer_index.sql (1)</summary><blockquote>

`5-6`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Make the co-buyer index covering for the projected wallet column.**

Line 5–6 still misses `wallet_address`, so `SELECT DISTINCT wallet_address ...` pays extra table lookups on a hot scanner path.

  

<details>
<summary>Proposed fix</summary>

```diff
-CREATE INDEX IF NOT EXISTS idx_trades_token_type_time
-  ON trades(token_mint, trade_type, block_time);
+CREATE INDEX IF NOT EXISTS idx_trades_token_type_time_wallet
+  ON trades(token_mint, trade_type, block_time, wallet_address);
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/storage/migrations/005_co_buyer_index.sql` around lines 5 - 6, The
idx_trades_token_type_time index on trades should include wallet_address so
queries like SELECT DISTINCT wallet_address ... avoid extra table lookups;
update the index definition (idx_trades_token_type_time) to be covering by
adding the wallet_address column to the index key or as an included column on
trades so that wallet_address is available from the index itself.
```

</details>

</blockquote></details>
<details>
<summary>src/storage/database.ts (1)</summary><blockquote>

`39-52`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Close the migration startup race around schema detection.**

Line 40 reads schema state outside the transaction, so concurrent startups can both decide a column is missing and race on `ALTER TABLE`, causing a duplicate-column failure in one process.

  

<details>
<summary>Proposed fix</summary>

```diff
 function runWalletPnlTrackingMigration(db: AppDatabase): void {
-  const columns = new Set(
-    (db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>).map((column) => column.name)
-  );
-
   const tx = db.transaction(() => {
+    const columns = new Set(
+      (db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>).map((column) => column.name)
+    );
+
     if (!columns.has("realized_sol_30d")) {
-      db.exec("ALTER TABLE wallets ADD COLUMN realized_sol_30d REAL DEFAULT 0");
+      try { db.exec("ALTER TABLE wallets ADD COLUMN realized_sol_30d REAL DEFAULT 0"); } catch {}
     }
     if (!columns.has("n_closed_30d")) {
-      db.exec("ALTER TABLE wallets ADD COLUMN n_closed_30d INTEGER DEFAULT 0");
+      try { db.exec("ALTER TABLE wallets ADD COLUMN n_closed_30d INTEGER DEFAULT 0"); } catch {}
     }
     if (!columns.has("wallet_class")) {
-      db.exec("ALTER TABLE wallets ADD COLUMN wallet_class TEXT DEFAULT 'unknown'");
+      try { db.exec("ALTER TABLE wallets ADD COLUMN wallet_class TEXT DEFAULT 'unknown'"); } catch {}
     }
     db.exec("CREATE INDEX IF NOT EXISTS idx_wallets_class ON wallets(wallet_class)");
     db.exec("CREATE INDEX IF NOT EXISTS idx_wallets_realized_sol ON wallets(realized_sol_30d DESC)");
   });
   tx();
 }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/storage/database.ts` around lines 39 - 52, The schema check reads PRAGMA
table_info(wallets) into columns outside the db.transaction, allowing concurrent
processes to both think a column is missing and race on ALTER TABLE; move the
schema detection inside the same atomic transaction used for migrations (i.e.,
perform PRAGMA table_info(wallets) inside the db.transaction callback) or
acquire an exclusive/IMMEDIATE transaction before checking so the checks for
"realized_sol_30d", "n_closed_30d", and "wallet_class" and the subsequent
db.exec("ALTER TABLE wallets ...") calls are executed under the same lock;
update the code that defines columns, the db.transaction callback, and the ALTER
TABLE branches so the detection and alteration are performed together to prevent
duplicate-column failures.
```

</details>

</blockquote></details>
<details>
<summary>scripts/start-funnel.sh (1)</summary><blockquote>

`20-23`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Invalidate `tunnel-url.txt` on funnel startup/drop failure paths.**

Line 22 and Line 30 exit while leaving a previously written URL file, so consumers can keep using a dead endpoint.

  

<details>
<summary>Proposed fix</summary>

```diff
   if ! "$TS_BIN" funnel --bg 3000 >> "$LOGFILE" 2>&1; then
+    rm -f "$URL_FILE"
     log "ERROR: failed to start funnel"
     exit 1
   fi
 fi
@@
   if ! "$TS_BIN" funnel status 2>/dev/null | grep -q "127.0.0.1:3000"; then
+    rm -f "$URL_FILE"
     log "WARN: funnel dropped — exiting to trigger launchd restart"
     exit 1
   fi
 done
```
</details>


Also applies to: 28-30

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/start-funnel.sh` around lines 20 - 23, When the background funnel
start or funnel drop fail (the commands invoking "$TS_BIN" funnel --bg 3000 and
the drop path that currently exits), ensure you invalidate the previously
written tunnel URL so consumers don't use a stale endpoint: remove or truncate
the tunnel-url.txt (e.g. rm -f "$DIR/tunnel-url.txt" or : >
"$DIR/tunnel-url.txt") immediately before each exit path and also consider
truncating it before attempting to start the funnel; reference the TS_BIN funnel
--bg 3000 invocation, the LOGFILE handling, and the tunnel-url.txt file in your
changes.
```

</details>

</blockquote></details>
<details>
<summary>src/config/thresholds.ts (1)</summary><blockquote>

`7-13`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Remove silent fallback in tier floor mapping.**

Line 12 silently downgrades unknown/new tiers to `2`, which can mis-gate alert severity when `AlertTier` expands.

  

<details>
<summary>Proposed fix</summary>

```diff
 export function getMinWalletsForTier(tier: AlertTier): number {
   switch (tier) {
     case "CRITICAL": return 3;
     case "NOTABLE": return 2;
     case "WATCH": return 1;
-    default: return 2;
   }
+
+  const exhaustive: never = tier;
+  return exhaustive;
 }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/config/thresholds.ts` around lines 7 - 13, The function
getMinWalletsForTier currently returns a silent default of 2 for unknown
AlertTier values; replace that fallback with an explicit failure to avoid
misclassifying new/unknown tiers—update the switch in getMinWalletsForTier to
handle only the known cases ("CRITICAL","NOTABLE","WATCH") and in the default
branch throw an Error (or assert exhaustiveness using a never-check) that
includes the unexpected tier value so failures are loud and traceable; ensure
the error text mentions AlertTier and the offending value so callers can see
which tier caused the failure.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/jupiter-client.ts (1)</summary><blockquote>

`193-206`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Malformed quote fields still crash paper mode before the fallback can run.**

The new sanity check only runs after `BigInt(quote.inAmount)` / `BigInt(quote.outAmount)`. If Jupiter returns a malformed amount field in an otherwise successful response, paper execution still throws before `fallbackOutputAmount(...)` is tried, so one bad quote can drop the paper fill entirely instead of degrading safely.

<details>
<summary>Suggested fix</summary>

```diff
-    const inputAmount = quote
-      ? await this.rawAmountToUi(params.inputMint, BigInt(quote.inAmount), quote.inputDecimals)
-      : await this.rawAmountToUi(params.inputMint, params.amountLamports);
-    let outputAmount: number;
-    if (quote) {
-      outputAmount = await this.rawAmountToUi(params.outputMint, BigInt(quote.outAmount), quote.outputDecimals);
-    } else {
-      outputAmount = await this.fallbackOutputAmount(params, inputAmount);
-    }
+    let inputAmount = await this.rawAmountToUi(params.inputMint, params.amountLamports);
+    let outputAmount: number;
+    if (quote) {
+      try {
+        inputAmount = await this.rawAmountToUi(params.inputMint, BigInt(quote.inAmount), quote.inputDecimals);
+        outputAmount = await this.rawAmountToUi(params.outputMint, BigInt(quote.outAmount), quote.outputDecimals);
+      } catch (error) {
+        logger.warn({ error, inputMint: params.inputMint, outputMint: params.outputMint, quote }, "Jupiter paper quote malformed; using price fallback");
+        outputAmount = await this.fallbackOutputAmount(params, inputAmount);
+      }
+    } else {
+      outputAmount = await this.fallbackOutputAmount(params, inputAmount);
+    }
```
</details>

```web
Jupiter Swap API v1 quote response: are `inAmount` and `outAmount` guaranteed to be integer strings, and what payload/error shapes can still be returned on HTTP 200 responses?
```

   
As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/jupiter-client.ts` around lines 193 - 206, The code converts
quote.inAmount/outAmount directly with BigInt before the sanity check, so a
malformed quote string will throw and prevent fallbackOutputAmount from running;
wrap the BigInt parsing/usage for quote.inAmount and quote.outAmount in a safe
validation/try-catch (or pre-validate with a /^\d+$/ check) and if parsing fails
treat quote as absent (or call fallbackOutputAmount(params, inputAmount)) so the
fallbackOutputAmount(...) path is used instead of crashing; update the logic
around rawAmountToUi, the BigInt(...) calls, and the conditional that sets
outputAmount to ensure malformed quote fields never throw synchronously and
always fall back to fallbackOutputAmount when invalid.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/manipulation-detector.ts (1)</summary><blockquote>

`59-69`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Still leaking future convergences into historical co-occurrence scores.**

This query has no upper time bound, so replaying an old convergence can still count later convergences and produce a higher `coOccurrenceScore` than live. Anchor it to the batch's max `block_time` and filter convergences at or before that reference time.

<details>
<summary>Suggested fix</summary>

```diff
 function computeCoOccurrence(buys: TradeRow[], db: AppDatabase): number {
   const wallets = [...new Set(buys.map((b) => b.wallet_address))];
   if (wallets.length < 3) return 0;
+  const referenceTime = Math.max(...buys.map((b) => b.block_time));
 
   const placeholders = wallets.map(() => "?").join(",");
   const rows = db.prepare(`
     SELECT ct.convergence_id, t.wallet_address
     FROM convergence_trades ct
     JOIN trades t ON t.id = ct.trade_id
+    JOIN convergences c ON c.id = ct.convergence_id
     WHERE t.wallet_address IN (${placeholders})
-  `).all(...wallets) as Array<{ convergence_id: number; wallet_address: string }>;
+      AND c.first_trade_at <= ?
+  `).all(...wallets, referenceTime) as Array<{ convergence_id: number; wallet_address: string }>;
```
</details>

  
As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/manipulation-detector.ts` around lines 59 - 69,
computeCoOccurrence currently queries all convergence_trades for wallets without
any time bound, leaking future convergences into historical co-occurrence;
modify computeCoOccurrence to take a reference time (e.g., maxBlockTime or
batchMaxBlockTime) and restrict the SQL to only include convergences whose
convergences.block_time (or equivalent timestamp column) is <= that reference
time, adding the extra placeholder/parameter to the prepared statement and
passing the reference time when calling computeCoOccurrence so coOccurrenceScore
matches backtest/live windows; update references to computeCoOccurrence
accordingly.
```

</details>

</blockquote></details>
<details>
<summary>src/api/middleware/hmac.ts (1)</summary><blockquote>

`22-27`: _⚠️ Potential issue_ | _🟡 Minor_ | _💤 Low value_

**Empty `rawBody` check is overly strict.**

Line 23 uses `!rawBody`, which treats an empty string `""` as misconfiguration. While Helius webhooks always send JSON payloads (so this is unlikely in practice), the explicit `rawBody === undefined` check would be more precise — an empty body is still valid for HMAC computation.




<details>
<summary>Suggested fix</summary>

```diff
-    if (!rawBody) {
+    if (rawBody === undefined) {
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/api/middleware/hmac.ts` around lines 22 - 27, The check that treats an
empty string as missing rawBody is too strict; in the middleware function
(verifyHeliusHmac) replace the falsy check `!rawBody` with a precise undefined
check (`rawBody === undefined`) so only absence of the captured raw body
triggers the error path; keep the same logging and reply behavior but only run
it when rawBody is strictly undefined.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/dexscreener-client.ts (1)</summary><blockquote>

`38-68`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Transport failures are still being collapsed into "no pairs".**

429/5xx now surface, but timeouts, DNS failures, and invalid JSON still return `[]`. Downstream that is indistinguishable from a real empty token response, so liquidity/age checks silently fall back to stale data during DexScreener outages.

   

Raise a distinct retryable error for these paths as well; `[]` should stay reserved for confirmed empty responses only.

```shell
#!/bin/bash
# Verify which callers currently treat DexScreener empty results as a normal no-data path.
rg -n -C3 '\b(getBestPair|getTokenPairs)\s*\(' --type ts
rg -n -C3 'tokenLiquidityLive|tokenAgeLive' --type ts
```

Expected result: the caller paths treat `[]`/`null` as a normal fallback, which confirms these transient failures are still being masked. As per coding guidelines, `src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals).

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/dexscreener-client.ts` around lines 38 - 68, getTokenPairs
currently returns [] for transport failures (fetch catch), JSON parse errors,
and non-array responses which masks transient DexScreener outages; instead, keep
[] reserved for confirmed empty 404/empty-array responses and throw a distinct
retryable error for transient failures. Update the fetch catch block, the JSON
parse catch, and the post-parse non-array check in getTokenPairs to throw a
DexScreenerTransientError (or a new retryable error type you add) with context
(mint and original error/response) rather than returning [], leaving existing
DexScreenerRateLimitError and DexScreenerServerError behavior unchanged. Ensure
callers of getTokenPairs can catch this transient error to trigger
retry/fallback logic.
```

</details>

</blockquote></details>
<details>
<summary>src/jobs/webhook-health.ts (1)</summary><blockquote>

`52-72`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Separate webhook healing from Discord notification failures.**

`discord.send()` is inside the same `try` as `helius.updateWebhook()`. If the webhook update succeeds but the NOTABLE alert throws, this path logs `"re-enable failed"` and emits a CRITICAL failure alert even though the webhook is already healthy.

 

<details>
<summary>Suggested fix</summary>

```diff
-    try {
-      await helius.updateWebhook(webhookId, addresses, publicWebhookUrl);
-      logger.info({ webhookId }, "webhook-health: webhook re-enabled successfully");
-      await discord.send({
-        embeds: [{
-          title: "🔧 Webhook Auto-Healed",
-          description: `Webhook \`${webhookId.substring(0, 8)}…\` was disabled/unreachable and has been re-enabled with ${addresses.length} wallets.`,
-          color: 0xffcc00,
-          timestamp: new Date().toISOString()
-        }]
-      }, "NOTABLE");
-    } catch (error) {
+    try {
+      await helius.updateWebhook(webhookId, addresses, publicWebhookUrl);
+    } catch (error) {
       logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "webhook-health: re-enable failed");
       await discord.send({
         embeds: [{
           title: "🚨 Webhook Re-Enable FAILED",
           description: `Webhook \`${webhookId.substring(0, 8)}…\` could not be re-enabled. Manual intervention required.`,
           color: 0xff3366,
           timestamp: new Date().toISOString()
         }]
       }, "CRITICAL");
+      return;
     }
+    logger.info({ webhookId }, "webhook-health: webhook re-enabled successfully");
+    await discord.send({
+      embeds: [{
+        title: "🔧 Webhook Auto-Healed",
+        description: `Webhook \`${webhookId.substring(0, 8)}…\` was disabled/unreachable and has been re-enabled with ${addresses.length} wallets.`,
+        color: 0xffcc00,
+        timestamp: new Date().toISOString()
+      }]
+    }, "NOTABLE").catch((notifyError) => {
+      logger.warn(
+        { err: notifyError instanceof Error ? notifyError : new Error(String(notifyError)), webhookId },
+        "webhook-health: success alert failed"
+      );
+    });
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/jobs/webhook-health.ts` around lines 52 - 72, The current try-catch wraps
both helius.updateWebhook and discord.send so a Discord failure masks a
successful helius.updateWebhook; split the operations so helius.updateWebhook is
awaited inside its own try/catch (log success via logger.info and on error log
and send the CRITICAL alert), then in a separate try/catch call discord.send for
the NOTABLE success message (on failure log the discord error but do not treat
the webhook re-enable as failed); refer to helius.updateWebhook,
logger.info/logger.error and discord.send to locate where to separate the flows
and add the additional try/catch around the Discord notification.
```

</details>

</blockquote></details>
<details>
<summary>src/index.ts (2)</summary><blockquote>

`84-93`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Leaderboard job lacks mutex — concurrent runs can corrupt data.**

The startup timer (90s) and the 06:00 scheduler can race on deploys around that time. Both fire `runLeaderboardRefresh()` without serialization, risking concurrent writes to `data/leaderboard.json` and `wallets` table.

The webhook-health job has a mutex (lines 97-107); apply the same pattern here.



<details>
<summary>🛠️ Proposed fix</summary>

```diff
+  let leaderboardRunning = false;
-  const leaderboardJob = () => runLeaderboardRefresh().catch((err) => {
-    logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "leaderboard-refresh: job failed");
-  });
+  const leaderboardJob = async () => {
+    if (leaderboardRunning) return;
+    leaderboardRunning = true;
+    try {
+      await runLeaderboardRefresh();
+    } catch (err) {
+      logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "leaderboard-refresh: job failed");
+    } finally {
+      leaderboardRunning = false;
+    }
+  };
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 84 - 93, The leaderboard job can run concurrently
(startup setTimeout and scheduled 06:00 tick) and must use the same mutex
pattern as the webhook-health job to serialize runs: wrap
runLeaderboardRefresh() call in a mutex guard (e.g., a boolean or Promise-based
lock variable like the one used in the webhook-health implementation),
check-and-set the lock before invoking runLeaderboardRefresh(), release the lock
in finally (including after errors), and update leaderboardJob to use this guard
so concurrent invocations (from setTimeout or setInterval) are skipped while a
run is in progress.
```

</details>

---

`37-44`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Server not closed before database on shutdown — in-flight requests can fail.**

The shutdown handler closes the database while the Fastify server is still accepting requests. A SIGTERM during active webhook processing can race with `db.close()`, causing mid-request failures or dropped writes.



<details>
<summary>🛠️ Proposed fix</summary>

```diff
+  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
+
   const shutdown = async (signal: string) => {
     logger.info(signal);
+    if (app) {
+      try { await app.close(); } catch {}
+    }
     stopRecentTradesCleanup();
     db.close();
     process.exit(0);
   };
-  process.on("SIGTERM", () => shutdown("SIGTERM"));
-  process.on("SIGINT", () => shutdown("SIGINT"));
+  process.on("SIGTERM", () => void shutdown("SIGTERM"));
+  process.on("SIGINT", () => void shutdown("SIGINT"));
```

Then assign `app` after `buildServer()`:

```diff
-  const app = await buildServer({ wallets, trades, convergences, engine, alerts });
+  app = await buildServer({ wallets, trades, convergences, engine, alerts });
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 37 - 44, The shutdown handler currently calls
db.close() while the Fastify server (app) may still be handling requests; make
shutdown asynchronous and first stop accepting new requests by awaiting
app.close() (the Fastify instance returned by buildServer), then await
stopRecentTradesCleanup() and await db.close(), and only then call
process.exit(0); also ensure app is assigned from buildServer() in module scope
so shutdown can reference it.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/risk-engine.ts (1)</summary><blockquote>

`89-90`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Mirror floor still overrides TVL bracket cap — oversizing low-liquidity positions.**

The clamp order is wrong. For pools in the `$5k–$25k` bracket, `tvlBracketCapPct = 0.2`, but Line 90 can raise `adjustedSizePct` back to `0.3` (MIRROR_MIN_PCT). This defeats the TVL-based protection for the exact low-liquidity tokens it's meant to guard.

Example: `tvlBracketCapPct = 0.2`, computed mirror = `0.15` → Line 89 gives `0.15` → Line 90 raises to `0.3`, exceeding the 0.2 cap.




<details>
<summary>🛠️ Proposed fix — apply floor before cap</summary>

```diff
-    let adjustedSizePct = Math.min(tvlBracketCapPct, mirrorPct * volAdj * drawdownHalve);
-    adjustedSizePct = Math.max(MIRROR_MIN_PCT, adjustedSizePct);
+    const mirroredSizePct = Math.max(MIRROR_MIN_PCT, mirrorPct * volAdj * drawdownHalve);
+    const adjustedSizePct = Math.min(tvlBracketCapPct, mirroredSizePct);
```
</details>

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/risk-engine.ts` around lines 89 - 90, The clamp order is
reversed causing MIRROR_MIN_PCT to override the TVL bracket cap; change the
clamp so you apply the floor first then the cap: compute adjustedSizePct =
Math.max(MIRROR_MIN_PCT, mirrorPct * volAdj * drawdownHalve) and then apply
adjustedSizePct = Math.min(tvlBracketCapPct, adjustedSizePct) so
tvlBracketCapPct can never be exceeded; update the code that sets
adjustedSizePct in risk-engine.ts where the variables adjustedSizePct,
MIRROR_MIN_PCT, tvlBracketCapPct, mirrorPct, volAdj, and drawdownHalve are used.
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
In `@docs/audit-report.md`:
- Around line 3-7: Update the snapshot header path to point to the correct alert
manager file: replace the referenced path string "src/services/alert-manager.ts"
with "src/engine/alert-manager.ts" so the “current state” note correctly links
to the actual alert manager implementation; ensure the change is made in the
header text of docs/audit-report.md where the post-convergence hook is
mentioned.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-3.md`:
- Around line 182-189: Step 7's expected staged-file count is wrong: it says "5
files" but lists seven paths (src/blockchain/helius-client.ts,
src/engine/scorer.ts, src/jobs/wallet-scorer.ts,
src/__tests__/mev-filter.test.ts, src/jobs/webhook-health.ts,
src/engine/convergence.ts, src/__tests__/convergence-quality-gate.test.ts);
update the step so the numeric count matches the list (change "5 files" to "7
files") or remove the two files that shouldn't be staged so the list and count
are consistent, and ensure any verification text or commands referencing the
count reflect the corrected number.

In `@scripts/backfill-usd.ts`:
- Around line 147-155: The SOL/USD fallback path uses
birdEyeClient.getSolUsdAt(unixTime) without handling BirdEyeRateLimitError, so
wrap the call in a retry/backoff loop like the token-history logic: catch
BirdEyeRateLimitError around birdEyeClient.getSolUsdAt in the block that
populates solUsdCache, on catch await sleep(RATE_LIMIT_DELAY_MS) (or exponential
backoff) and retry until success, then set solUsdCache.set(bucket, { unixTime,
value }) and proceed; ensure other exceptions still bubble up.

In `@src/blockchain/transaction-parser.ts`:
- Around line 20-28: The isRapidReversal function currently updates recentTrades
before checking order, allowing an older out-of-order trade to be treated as a
reversal and overwrite a newer entry; change the logic in isRapidReversal to
first fetch previous from recentTrades, then only consider a reversal if
trade.blockTime > previous.blockTime, previous.tradeType is opposite (use
oppositeType), and the time difference is < RAPID_REVERSAL_WINDOW_SEC; only
after these checks (or if previous is absent or older) update
recentTrades.set(key, { tradeType: trade.tradeType, blockTime: trade.blockTime
}) for newer trades so stale deliveries do not advance the cache.

In `@src/engine/fifo-matcher.ts`:
- Around line 48-120: The matcher assumes trades are pre-sorted but must enforce
FIFO itself: inside matchFifo, sort the incoming trades array by
trade.block_time (and break ties deterministically, e.g., by type or a stable
field) before building lotsByPair and processing; update references to the
original trades variable (or copy and sort into a local sortedTrades) so the
rest of the logic (loops, oldestBuyTime, unmatched_sells, cycles pushes)
operates on the time-ordered sequence to guarantee correct FIFO matching and
reproducible results.

In `@src/engine/scorer.ts`:
- Around line 95-98: The manipulation flags (isMev, isWashTrader) are computed
from persisted trades while buildPositions()/totalTrades include heliusTxs,
causing divergence; update the calls to computeHoldTimes(...) and
detectWashTrading(...) to use the same unified fills/trades collection used by
buildPositions and totalTrades (the combined array that includes heliusTxs—e.g.,
the "unified" or "allTrades" variable you already build for P&L/activity)
instead of the persisted trades variable, and ensure the same time-window
constants (MEV_HOLD_TIME_THRESHOLD_SEC and any window logic inside
detectWashTrading) are applied so live scoring and replay/backtest use identical
inputs and thresholds.
- Around line 37-84: computeHoldTimes and detectWashTrading treat an entire BUY
row as closed on any SELL for the same mint, which breaks partial-fill logic;
change both functions to use per-mint lots with a remaining_qty (like
src/engine/fifo-matcher.ts) instead of shifting whole TradeRow objects: when
seeing a BUY push a lot {block_time, remaining_qty} into buyQueueByMint, and
when seeing a SELL consume the lot(s) with min(remaining_qty, sell_qty) in a
loop reducing remaining_qty (and removing empty lots), recording the matched
quantity and the hold time for that matched quantity (either by emitting
(holdTime, qty) pairs or by pushing the holdTime repeated by qty if you keep
number[]); in detectWashTrading count roundTripQuantity and washQuantity as
quantities (use WASH_TRADE_WINDOW_SEC and WASH_TRADE_FRACTION_THRESHOLD
unchanged) so the wash fraction = washQuantity / roundTripQuantity rather than
counting entire rows.

In `@src/execution/position-auditor.ts`:
- Around line 22-23: The auditor currently allows entry_price_usd > 0 but
runtime uses isSanePrice which rejects values ≤ 1e-15; update the checks in
position-auditor (the conditions using pos.entry_price_usd and
pos.current_price_usd) to use the same lower bound as isSanePrice (e.g. require
> 1e-15) or call the isSanePrice helper for both entry and current prices so
positions with tiny positive prices are flagged at audit time.

---

Duplicate comments:
In `@scripts/start-funnel.sh`:
- Around line 20-23: When the background funnel start or funnel drop fail (the
commands invoking "$TS_BIN" funnel --bg 3000 and the drop path that currently
exits), ensure you invalidate the previously written tunnel URL so consumers
don't use a stale endpoint: remove or truncate the tunnel-url.txt (e.g. rm -f
"$DIR/tunnel-url.txt" or : > "$DIR/tunnel-url.txt") immediately before each exit
path and also consider truncating it before attempting to start the funnel;
reference the TS_BIN funnel --bg 3000 invocation, the LOGFILE handling, and the
tunnel-url.txt file in your changes.

In `@src/api/middleware/hmac.ts`:
- Around line 22-27: The check that treats an empty string as missing rawBody is
too strict; in the middleware function (verifyHeliusHmac) replace the falsy
check `!rawBody` with a precise undefined check (`rawBody === undefined`) so
only absence of the captured raw body triggers the error path; keep the same
logging and reply behavior but only run it when rawBody is strictly undefined.

In `@src/blockchain/dexscreener-client.ts`:
- Around line 38-68: getTokenPairs currently returns [] for transport failures
(fetch catch), JSON parse errors, and non-array responses which masks transient
DexScreener outages; instead, keep [] reserved for confirmed empty
404/empty-array responses and throw a distinct retryable error for transient
failures. Update the fetch catch block, the JSON parse catch, and the post-parse
non-array check in getTokenPairs to throw a DexScreenerTransientError (or a new
retryable error type you add) with context (mint and original error/response)
rather than returning [], leaving existing DexScreenerRateLimitError and
DexScreenerServerError behavior unchanged. Ensure callers of getTokenPairs can
catch this transient error to trigger retry/fallback logic.

In `@src/config/thresholds.ts`:
- Around line 7-13: The function getMinWalletsForTier currently returns a silent
default of 2 for unknown AlertTier values; replace that fallback with an
explicit failure to avoid misclassifying new/unknown tiers—update the switch in
getMinWalletsForTier to handle only the known cases
("CRITICAL","NOTABLE","WATCH") and in the default branch throw an Error (or
assert exhaustiveness using a never-check) that includes the unexpected tier
value so failures are loud and traceable; ensure the error text mentions
AlertTier and the offending value so callers can see which tier caused the
failure.

In `@src/engine/manipulation-detector.ts`:
- Around line 59-69: computeCoOccurrence currently queries all
convergence_trades for wallets without any time bound, leaking future
convergences into historical co-occurrence; modify computeCoOccurrence to take a
reference time (e.g., maxBlockTime or batchMaxBlockTime) and restrict the SQL to
only include convergences whose convergences.block_time (or equivalent timestamp
column) is <= that reference time, adding the extra placeholder/parameter to the
prepared statement and passing the reference time when calling
computeCoOccurrence so coOccurrenceScore matches backtest/live windows; update
references to computeCoOccurrence accordingly.

In `@src/execution/jupiter-client.ts`:
- Around line 193-206: The code converts quote.inAmount/outAmount directly with
BigInt before the sanity check, so a malformed quote string will throw and
prevent fallbackOutputAmount from running; wrap the BigInt parsing/usage for
quote.inAmount and quote.outAmount in a safe validation/try-catch (or
pre-validate with a /^\d+$/ check) and if parsing fails treat quote as absent
(or call fallbackOutputAmount(params, inputAmount)) so the
fallbackOutputAmount(...) path is used instead of crashing; update the logic
around rawAmountToUi, the BigInt(...) calls, and the conditional that sets
outputAmount to ensure malformed quote fields never throw synchronously and
always fall back to fallbackOutputAmount when invalid.

In `@src/execution/risk-engine.ts`:
- Around line 89-90: The clamp order is reversed causing MIRROR_MIN_PCT to
override the TVL bracket cap; change the clamp so you apply the floor first then
the cap: compute adjustedSizePct = Math.max(MIRROR_MIN_PCT, mirrorPct * volAdj *
drawdownHalve) and then apply adjustedSizePct = Math.min(tvlBracketCapPct,
adjustedSizePct) so tvlBracketCapPct can never be exceeded; update the code that
sets adjustedSizePct in risk-engine.ts where the variables adjustedSizePct,
MIRROR_MIN_PCT, tvlBracketCapPct, mirrorPct, volAdj, and drawdownHalve are used.

In `@src/index.ts`:
- Around line 84-93: The leaderboard job can run concurrently (startup
setTimeout and scheduled 06:00 tick) and must use the same mutex pattern as the
webhook-health job to serialize runs: wrap runLeaderboardRefresh() call in a
mutex guard (e.g., a boolean or Promise-based lock variable like the one used in
the webhook-health implementation), check-and-set the lock before invoking
runLeaderboardRefresh(), release the lock in finally (including after errors),
and update leaderboardJob to use this guard so concurrent invocations (from
setTimeout or setInterval) are skipped while a run is in progress.
- Around line 37-44: The shutdown handler currently calls db.close() while the
Fastify server (app) may still be handling requests; make shutdown asynchronous
and first stop accepting new requests by awaiting app.close() (the Fastify
instance returned by buildServer), then await stopRecentTradesCleanup() and
await db.close(), and only then call process.exit(0); also ensure app is
assigned from buildServer() in module scope so shutdown can reference it.

In `@src/jobs/webhook-health.ts`:
- Around line 52-72: The current try-catch wraps both helius.updateWebhook and
discord.send so a Discord failure masks a successful helius.updateWebhook; split
the operations so helius.updateWebhook is awaited inside its own try/catch (log
success via logger.info and on error log and send the CRITICAL alert), then in a
separate try/catch call discord.send for the NOTABLE success message (on failure
log the discord error but do not treat the webhook re-enable as failed); refer
to helius.updateWebhook, logger.info/logger.error and discord.send to locate
where to separate the flows and add the additional try/catch around the Discord
notification.

In `@src/storage/database.ts`:
- Around line 39-52: The schema check reads PRAGMA table_info(wallets) into
columns outside the db.transaction, allowing concurrent processes to both think
a column is missing and race on ALTER TABLE; move the schema detection inside
the same atomic transaction used for migrations (i.e., perform PRAGMA
table_info(wallets) inside the db.transaction callback) or acquire an
exclusive/IMMEDIATE transaction before checking so the checks for
"realized_sol_30d", "n_closed_30d", and "wallet_class" and the subsequent
db.exec("ALTER TABLE wallets ...") calls are executed under the same lock;
update the code that defines columns, the db.transaction callback, and the ALTER
TABLE branches so the detection and alteration are performed together to prevent
duplicate-column failures.

In `@src/storage/migrations/005_co_buyer_index.sql`:
- Around line 5-6: The idx_trades_token_type_time index on trades should include
wallet_address so queries like SELECT DISTINCT wallet_address ... avoid extra
table lookups; update the index definition (idx_trades_token_type_time) to be
covering by adding the wallet_address column to the index key or as an included
column on trades so that wallet_address is available from the index itself.
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

**Run ID**: `40496b4b-ca4a-4714-93a1-caaa31308104`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and 4d8f5ce96b30cb79f5872c54cf74fb648b83410a.

</details>

<details>
<summary>📒 Files selected for processing (66)</summary>

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
* `src/storage/models/wallets.ts`
* `src/utils/retry.ts`

</details>

<details>
<summary>💤 Files with no reviewable changes (12)</summary>

* src/frontend/pages/Wallets.tsx
* src/jobs/token-metadata.ts
* src/frontend/components/ConvergenceCard.tsx
* src/frontend/hooks/useSSE.ts
* src/jobs/catchup.ts
* src/frontend/pages/History.tsx
* src/frontend/pages/Settings.tsx
* src/frontend/components/StatusBadge.tsx
* src/jobs/cleanup.ts
* src/frontend/components/WalletTable.tsx
* src/utils/retry.ts
* .env.example

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
