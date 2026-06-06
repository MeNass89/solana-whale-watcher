**Actionable comments posted: 7**

<details>
<summary>♻️ Duplicate comments (7)</summary><blockquote>

<details>
<summary>src/execution/position-auditor.ts (1)</summary><blockquote>

`22-29`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Use the backing convergence tier for WATCH quarantine.**

This still keys off `pos.tier`, so an `OPEN`/`PARTIAL` position with a stale stored tier can survive startup audit even when the joined convergence is now `WATCH`. That leaves an ineligible position alive in the P&L/exit path.

  

<details>
<summary>Suggested fix</summary>

```diff
-    if (pos.tier === "WATCH") violations.push("WATCH tier position");
+    const effectiveTier = pos.conv_tier ?? pos.tier;
+    if (effectiveTier === "WATCH") violations.push("WATCH tier position");
```
</details>

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-auditor.ts` around lines 22 - 29, The audit currently
quarantines WATCH based on the stored pos.tier which can be stale; change the
WATCH check to use the joined convergence tier (pos.conv_tier) instead (treat
null conv_tier as orphaned as already handled), i.e., replace or augment the
pos.tier === "WATCH" check with a check against pos.conv_tier === "WATCH" so
positions whose backing convergence is WATCH are flagged into violations (use
the same violations array and message like "WATCH tier position" and preserve
existing null-handling for conv_tier and wallet_count).
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/helius-client.ts (1)</summary><blockquote>

`183-186`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Parse HTTP-date `Retry-After` values too.**

Right now this only handles delta-seconds. If Helius returns an HTTP-date `Retry-After`, every 429/5xx path above degrades to `retryAfterSeconds = null`, so callers lose the provider’s backoff signal and can immediately retry into the same limit window.

   

<details>
<summary>Suggested fix</summary>

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

```web
Does the HTTP Retry-After header allow both delta-seconds and HTTP-date formats?
```

As per coding guidelines, `src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals).

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/helius-client.ts` around lines 183 - 186, The parseRetryAfter
function only handles delta-seconds and must also accept HTTP-date values;
update parseRetryAfter to first try parsing header as a Number (delta-seconds)
and if that yields null/NaN, parse it as an HTTP-date using Date.parse(header)
and compute seconds = (parsedDate - Date.now())/1000, returning a finite,
non-negative integer (e.g., Math.ceil) or null if parsing fails; ensure you only
reference the existing parseRetryAfter function and return null for invalid
inputs.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/fifo-matcher.ts (1)</summary><blockquote>

`87-127`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Emit one `ClosedCycle` per consumed BUY lot.**

Collapsing a multi-lot SELL into one cycle keeps aggregate P&L, but `hold_time_s` becomes the oldest lot’s age for the whole fill. Any leaderboard/scoring path that uses hold time will drift from the actual FIFO lifecycle when one sell drains inventory bought at different times.

  

<details>
<summary>Suggested direction</summary>

```diff
-    let matchedTok = 0;
-    let cycleCostSol = 0;
-    let cycleCostUsd = 0;
-    let oldestBuyTime: number | null = null;
-
     while (remaining > LOT_EMPTY_EPSILON && pair.lots.length > 0) {
       const lot = pair.lots[0];
       const take = Math.min(remaining, lot.tok);
       const ratio = take / lot.tok;
       const takeSol = lot.sol * ratio;
       const takeUsd = lot.usd * ratio;
-
-      cycleCostSol += takeSol;
-      cycleCostUsd += takeUsd;
-      if (oldestBuyTime == null) oldestBuyTime = lot.time;
+      const proceedsRatio = take / trade.amount_token;
+      const proceedsSol = sellSol * proceedsRatio;
+      const proceedsUsd = sellUsd * proceedsRatio;
+      cycles.push({
+        wallet: trade.wallet,
+        mint: trade.mint,
+        cost_sol: takeSol,
+        cost_usd: takeUsd,
+        proceeds_sol: proceedsSol,
+        proceeds_usd: proceedsUsd,
+        pnl_sol: proceedsSol - takeSol,
+        pnl_usd: proceedsUsd - takeUsd,
+        hold_time_s: Math.max(0, trade.block_time - lot.time),
+        closed_at: trade.block_time
+      });
 
       lot.tok -= take;
       lot.sol -= takeSol;
       lot.usd -= takeUsd;
-      matchedTok += take;
       remaining -= take;
 
       if (Math.abs(lot.tok) < LOT_EMPTY_EPSILON) pair.lots.shift();
     }
-
-    if (matchedTok > 0 && oldestBuyTime != null) {
-      const proceedsRatio = matchedTok / trade.amount_token;
-      const proceedsSol = sellSol * proceedsRatio;
-      const proceedsUsd = sellUsd * proceedsRatio;
-      cycles.push({
-        wallet: trade.wallet,
-        mint: trade.mint,
-        cost_sol: cycleCostSol,
-        cost_usd: cycleCostUsd,
-        proceeds_sol: proceedsSol,
-        proceeds_usd: proceedsUsd,
-        pnl_sol: proceedsSol - cycleCostSol,
-        pnl_usd: proceedsUsd - cycleCostUsd,
-        hold_time_s: Math.max(0, trade.block_time - oldestBuyTime),
-        closed_at: trade.block_time
-      });
-    }
```
</details>

As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/fifo-matcher.ts` around lines 87 - 127, The current code
aggregates all consumed BUY lots into a single cycle (using matchedTok,
cycleCostSol, cycleCostUsd, oldestBuyTime and a single cycles.push), which
misstates hold_time_s; change the logic to emit one ClosedCycle per consumed BUY
lot: inside the while loop where you compute take, takeSol and takeUsd for the
current lot (pair.lots[0]), compute proceeds for that specific take (proceedsSol
= sellSol * (take / trade.amount_token), proceedsUsd = sellUsd * (take /
trade.amount_token)), build and push a ClosedCycle using trade.wallet,
trade.mint, cost_sol = takeSol, cost_usd = takeUsd, proceeds_sol, proceeds_usd,
pnl_* = proceeds - cost, hold_time_s = Math.max(0, trade.block_time - lot.time)
and closed_at = trade.block_time; then decrement lot tokens/values and shift the
lot when empty. Remove or stop using the aggregated matchedTok/cycleCost* logic
and the single cycles.push after the loop.
```

</details>

</blockquote></details>
<details>
<summary>scripts/backfill-usd.ts (1)</summary><blockquote>

`146-175`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Cache the bucket price at the bucket timestamp, not the first trade timestamp.**

This is still order-dependent within each 5-minute bucket: the first trade to hit a bucket fetches `getSolUsdAt(trade.block_time)`, and every later trade in that bucket reuses that exact-time price. Backfilled USD can therefore drift based on token iteration order instead of a deterministic bucket anchor.  
  

<details>
<summary>Suggested fix</summary>

```diff
-      const bucket = Math.floor(trade.block_time / 300);
+      const bucket = Math.floor(trade.block_time / 300);
+      const unixTime = bucket * 300;
       let cached = solUsdCache.get(bucket);
       if (!cached) {
-        const unixTime = trade.block_time;
         let value: number | null = null;
         const MAX_RETRIES = 5;
         let attempt = 0;
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/backfill-usd.ts` around lines 146 - 175, The code currently sets
unixTime = trade.block_time before fetching and caching, which makes the cached
SOL/USD tied to the first trade's timestamp in a 5-minute bucket; change the
fetch anchor to the deterministic bucket timestamp (use unixTime = bucket * 300)
so every trade in the same bucket uses the same bucket-aligned time when calling
birdEyeClient.getSolUsdAt and when storing into solUsdCache (refer to bucket,
unixTime, solUsdCache, and birdEyeClient.getSolUsdAt).
```

</details>

</blockquote></details>
<details>
<summary>src/api/routes/webhooks.ts (1)</summary><blockquote>

`39-40`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**This pre-sell fence is still unstable for same-second fills.**

`tx_signature != ?` only excludes the current transaction; it still includes other rows from the same second, including later fills, and it cannot disambiguate same-tx multi-instruction trades. That means `sellPct` can still be wrong and drive the wrong behavioral exit size. Use a deterministic sequence key here (for example `(block_time, tx_signature, instruction_index)`) or a per-batch running balance instead of the current same-second predicate.  
  


Also applies to: 68-85

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/api/routes/webhooks.ts` around lines 39 - 40, The pre-sell fencing using
tx_signature != ? is racey for same-second and same-tx multi-instruction fills;
update computePreSellBalance (and its callers where similar logic appears) to
use a deterministic sequence key—pass and use instruction_index together with
block_time and tx_signature (i.e., (block_time, tx_signature,
instruction_index)) or implement a per-batch running balance so you only
consider rows strictly before the current sequence tuple; change the call site
where trade.tradeType === "SELL" to pass trade.instructionIndex (or the
per-batch identifier) and alter the query logic inside computePreSellBalance to
compare the full tuple ordering instead of just excluding tx_signature.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-manager.ts (2)</summary><blockquote>

`75-78`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Do not let whale-sell exits run without wallet classifications.**

If `configure(...)` is called without `wallets`, `onWhaleSell(...)` skips the loser/accumulation-bot filter and the execution path fails open on untrusted sellers. Make `wallets` required, or abort whale-sell handling when it is missing.  
  

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute.


Also applies to: 193-203

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 75 - 78, The configure method
currently allows wallets to be omitted which causes onWhaleSell to bypass seller
classification and trust unverified sellers; update configure (and related logic
around onWhaleSell and any whale-sell handling at the block referenced near
lines 193-203) to require a WalletModel: either make the configure signature
require wallets (remove the optional type and the null coalescing) or add a
guard that disables/aborts all whale-sell execution when this.wallets is null
and log/throw an error; ensure any code paths in onWhaleSell check this.wallets
before applying loser/accumulation-bot filters to prevent open execution on
untrusted sellers.
```

</details>

---

`340-346`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Aggregate portfolio unrealized loss before firing `DOLLAR_LOSS_CAP`.**

This compares one position's unrealized loss against total portfolio value. A distributed drawdown across several `OPEN`/`PARTIAL` positions can exceed the 3% cap without any single row tripping this guard, so the portfolio stop never fires.  
  

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 340 - 346, The current
checkDollarStop only measures the single position's unrealizedLoss; instead
compute the aggregated unrealized loss across all non-closed positions before
triggering DOLLAR_LOSS_CAP. In checkDollarStop(PositionRow, priceUsd) iterate
your positions collection (filter by OPEN/PARTIAL), compute each position's
unrealized loss using each position's amount_token and its current market price
(retrieve current prices from your market/price feed used elsewhere), sum only
positive losses, then compare (aggregateUnrealizedLoss /
this.portfolioValueUsd()) * 100 to MAX_DOLLAR_LOSS_PORTFOLIO_PCT and call
this.exit(position, "DOLLAR_LOSS_CAP", 100, true) when the aggregate threshold
is exceeded; keep the single-position unrealizedLoss logic only for bookkeeping
but use the aggregate for the stop decision.
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
- Around line 327-329: The step that runs the hard-coded command "launchctl
kickstart -k gui/501/com.nassim.whale-watcher" must be made portable: remove the
fixed UID (501) and machine-specific label (com.nassim.whale-watcher) and
instead derive the current user's UID at runtime and accept or discover the
service label (e.g., via a placeholder/service lookup), then use that dynamic
UID and label when calling launchctl; update the verification instructions to
show a parameterized command and/or a short note to run a lookup (e.g.,
launchctl list) to find the correct service label before kicking it.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-6.md`:
- Around line 109-113: The current conversion path for
amountLamports/baseUnitsFloat uses Number-based scaling and Math.floor which can
lose precision for large/high-decimal amounts; change the default implementation
used by the amount-to-base-unit conversion (where baseUnitsFloat,
sellAmountToken, amountLamports are computed) to a bigint-safe algorithm: split
the token amount into integer and fractional parts, convert the integer part to
BigInt and compute intPart * (10n ** BigInt(decimals)), compute fracPart * scale
and floor to BigInt for fracBaseUnits, and sum them to produce the exact
base-unit BigInt; replace any remaining Math.floor(Number(...)).toString() paths
with this precise conversion so the stricter path is the default rather than an
optional fallback.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-7.md`:
- Around line 188-210: The doc contains two conflicting better-sqlite3
transaction examples for db.transaction(...) — remove the duplicate/incorrect
variant that treats db.transaction(fn).immediate as a value and keep the correct
pattern that calls the immediate variant via tx.immediate(); update the example
using db.transaction(...) and tx() to instead show db.transaction(...) followed
by tx.immediate() (with the explanatory comment about acquiring a RESERVED
lock), and delete the obsolete example that suggests assigning .immediate as a
property or calling tx() to avoid copy/paste mistakes.

In `@scripts/start-funnel.sh`:
- Around line 8-10: The script hardcodes user-specific paths and the tailscale
binary into LOGFILE, URL_FILE and TS_BIN; change them to be configurable via
environment variables with sensible defaults (e.g. default data files under
$HOME or a configurable DATA_DIR) and resolve the tailscale binary dynamically
(use PATH lookup such as command -v tailscale fallback) so different
accounts/hosts can run the script without editing it; update the assignments for
LOGFILE, URL_FILE and TS_BIN in start-funnel.sh to read from env vars (e.g.
LOGFILE=${LOGFILE:-"$HOME/..."} etc.) and fall back to a discovered binary for
TS_BIN.

In `@src/__tests__/birdeye-client.test.ts`:
- Around line 1-14: Add tests to src/__tests__/birdeye-client.test.ts that mock
fetch responses for BirdEyeClient.getTokenOverview to cover rate limit and
availability error paths: stub global.fetch (e.g., via vi.stubGlobal or
equivalent) to return a 429 response and assert it throws BirdEyeRateLimitError,
return a 5xx response and assert it throws BirdEyeUnavailableError, and simulate
a network failure (fetch rejects) and assert it throws BirdEyeUnavailableError;
reference the BirdEyeClient class and getTokenOverview method in the test
descriptions so the new cases mirror the DexScreener coverage.

In `@src/__tests__/webhook-health.test.ts`:
- Around line 48-52: The test "does not heal when getWebhook throws (transient)"
currently only asserts mockUpdateWebhook wasn't called but doesn't assert no
Discord alert was sent; update the test to also assert
mockDiscordSend.not.toHaveBeenCalled() after calling checkWebhookHealth so
transient getWebhook failures do not trigger Discord alerts. Locate the test
using mockGetWebhook, checkWebhookHealth, mockUpdateWebhook and add the
assertion against mockDiscordSend to lock down the transient-skip behavior.

In `@src/config/index.ts`:
- Around line 60-64: Update the comment about BIRDEYE_API_KEY to avoid
overstating behavior: replace the phrase "every BirdEye client method" with a
scoped note that only specific methods degrade gracefully by returning null or
using cached fallbacks (specifically getSolUsdAt, getTokenOverview,
getWalletPnl, getHistoricalPrices on the BirdEye client), and clarify that other
BirdEye methods may not have the same fallback behavior; keep the existing
rationale about reduced enrichment quality and DexScreener/DB fallbacks for risk
engine and wallet scorer but limit the claim to those named methods.

---

Duplicate comments:
In `@scripts/backfill-usd.ts`:
- Around line 146-175: The code currently sets unixTime = trade.block_time
before fetching and caching, which makes the cached SOL/USD tied to the first
trade's timestamp in a 5-minute bucket; change the fetch anchor to the
deterministic bucket timestamp (use unixTime = bucket * 300) so every trade in
the same bucket uses the same bucket-aligned time when calling
birdEyeClient.getSolUsdAt and when storing into solUsdCache (refer to bucket,
unixTime, solUsdCache, and birdEyeClient.getSolUsdAt).

In `@src/api/routes/webhooks.ts`:
- Around line 39-40: The pre-sell fencing using tx_signature != ? is racey for
same-second and same-tx multi-instruction fills; update computePreSellBalance
(and its callers where similar logic appears) to use a deterministic sequence
key—pass and use instruction_index together with block_time and tx_signature
(i.e., (block_time, tx_signature, instruction_index)) or implement a per-batch
running balance so you only consider rows strictly before the current sequence
tuple; change the call site where trade.tradeType === "SELL" to pass
trade.instructionIndex (or the per-batch identifier) and alter the query logic
inside computePreSellBalance to compare the full tuple ordering instead of just
excluding tx_signature.

In `@src/blockchain/helius-client.ts`:
- Around line 183-186: The parseRetryAfter function only handles delta-seconds
and must also accept HTTP-date values; update parseRetryAfter to first try
parsing header as a Number (delta-seconds) and if that yields null/NaN, parse it
as an HTTP-date using Date.parse(header) and compute seconds = (parsedDate -
Date.now())/1000, returning a finite, non-negative integer (e.g., Math.ceil) or
null if parsing fails; ensure you only reference the existing parseRetryAfter
function and return null for invalid inputs.

In `@src/engine/fifo-matcher.ts`:
- Around line 87-127: The current code aggregates all consumed BUY lots into a
single cycle (using matchedTok, cycleCostSol, cycleCostUsd, oldestBuyTime and a
single cycles.push), which misstates hold_time_s; change the logic to emit one
ClosedCycle per consumed BUY lot: inside the while loop where you compute take,
takeSol and takeUsd for the current lot (pair.lots[0]), compute proceeds for
that specific take (proceedsSol = sellSol * (take / trade.amount_token),
proceedsUsd = sellUsd * (take / trade.amount_token)), build and push a
ClosedCycle using trade.wallet, trade.mint, cost_sol = takeSol, cost_usd =
takeUsd, proceeds_sol, proceeds_usd, pnl_* = proceeds - cost, hold_time_s =
Math.max(0, trade.block_time - lot.time) and closed_at = trade.block_time; then
decrement lot tokens/values and shift the lot when empty. Remove or stop using
the aggregated matchedTok/cycleCost* logic and the single cycles.push after the
loop.

In `@src/execution/position-auditor.ts`:
- Around line 22-29: The audit currently quarantines WATCH based on the stored
pos.tier which can be stale; change the WATCH check to use the joined
convergence tier (pos.conv_tier) instead (treat null conv_tier as orphaned as
already handled), i.e., replace or augment the pos.tier === "WATCH" check with a
check against pos.conv_tier === "WATCH" so positions whose backing convergence
is WATCH are flagged into violations (use the same violations array and message
like "WATCH tier position" and preserve existing null-handling for conv_tier and
wallet_count).

In `@src/execution/position-manager.ts`:
- Around line 75-78: The configure method currently allows wallets to be omitted
which causes onWhaleSell to bypass seller classification and trust unverified
sellers; update configure (and related logic around onWhaleSell and any
whale-sell handling at the block referenced near lines 193-203) to require a
WalletModel: either make the configure signature require wallets (remove the
optional type and the null coalescing) or add a guard that disables/aborts all
whale-sell execution when this.wallets is null and log/throw an error; ensure
any code paths in onWhaleSell check this.wallets before applying
loser/accumulation-bot filters to prevent open execution on untrusted sellers.
- Around line 340-346: The current checkDollarStop only measures the single
position's unrealizedLoss; instead compute the aggregated unrealized loss across
all non-closed positions before triggering DOLLAR_LOSS_CAP. In
checkDollarStop(PositionRow, priceUsd) iterate your positions collection (filter
by OPEN/PARTIAL), compute each position's unrealized loss using each position's
amount_token and its current market price (retrieve current prices from your
market/price feed used elsewhere), sum only positive losses, then compare
(aggregateUnrealizedLoss / this.portfolioValueUsd()) * 100 to
MAX_DOLLAR_LOSS_PORTFOLIO_PCT and call this.exit(position, "DOLLAR_LOSS_CAP",
100, true) when the aggregate threshold is exceeded; keep the single-position
unrealizedLoss logic only for bookkeeping but use the aggregate for the stop
decision.
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

**Run ID**: `7d9dabbd-8d80-4dcd-8915-d92fb2504f62`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and d44d819fb99183a3315e2c31db2b6f6519b68657.

</details>

<details>
<summary>📒 Files selected for processing (92)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `docs/audit-report.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-10-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-11-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-12-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-13-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-14-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-15-raw.md`
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
* `docs/superpowers/plans/2026-05-09-coderabbit-review-15.md`
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
* `src/storage/migrations/009_wallet_class_default_incomplete.sql`
* `src/storage/models/wallets.ts`
* `src/utils/retry.ts`

</details>

<details>
<summary>💤 Files with no reviewable changes (1)</summary>

* .env.example

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
