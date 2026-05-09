**Actionable comments posted: 13**

<details>
<summary>♻️ Duplicate comments (9)</summary><blockquote>

<details>
<summary>src/blockchain/helius-client.ts (1)</summary><blockquote>

`98-105`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Do not treat 401/403 as “end of history.”**

This branch still turns auth/config failures into a partial transaction history by logging and breaking pagination. An expired or revoked Helius key will look like a wallet with no more history instead of surfacing an operational failure.




<details>
<summary>Suggested fix</summary>

```diff
-        if (response.status === 429 || response.status >= 500) {
+        if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
           throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
         }
-        logger.warn({ address, status: response.status, beforeSignature }, "getWalletTransactions: non-OK 4xx, stopping pagination");
-        break;
+        if (response.status === 404) {
+          logger.warn({ address, status: response.status, beforeSignature }, "getWalletTransactions: wallet not found, stopping pagination");
+          break;
+        }
+        throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
```
</details>
As per coding guidelines, "`src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals)."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/helius-client.ts` around lines 98 - 105, The error handling in
getWalletTransactions currently treats 401/403 like a harmless end-of-history
and breaks pagination; instead detect authentication/config errors (status 401
or 403) in the response.ok false branch and throw a HeliusRequestError (same as
for 429/5xx) so callers can surface/retry the operational failure; update the
response.status checks inside getWalletTransactions to include 401 and 403 as
throwable conditions and keep only true client-4xx (non-auth) responses as the
silent pagination stop.
```

</details>

</blockquote></details>
<details>
<summary>scripts/leaderboard.ts (1)</summary><blockquote>

`166-180`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**30-day filtering still drops the cost basis for sells opened before the window.**

This query only feeds post-cutoff trades into `matchFifo`, so any in-window sell that closes inventory opened before the cutoff turns into `unmatched_sells` instead of realized P&L. That skews `realized_sol`, `n_closed`, `wallet_class`, and the prune decisions written back to `wallets`.

You need to seed FIFO with pre-cutoff inventory, or query enough history to build opening lots before folding in-window sells.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/leaderboard.ts` around lines 166 - 180, The current trades query only
selects post-cutoff rows so matchFifo is missing pre-cutoff opening lots; change
the logic so you first seed matchFifo with historical inventory by querying
trades before the cutoff (for the same wallet_address/token_mint set) and
passing those as the initial inventory before feeding the in-window trades to
matchFifo; specifically add or replace usage around the trades variable/RawTrade
results so you run a preCutoff query (or extend the WHERE to include earlier
opens) for seeding, then call matchFifo with [preCutoffTrades, inWindowTrades]
(or call matchFifo twice: seed then process) to ensure sells inside the 30-day
window realize P&L against pre-cutoff buys.
```

</details>

</blockquote></details>
<details>
<summary>scripts/backfill-usd.ts (1)</summary><blockquote>

`147-171`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**The SOL/USD fallback cache is still order-dependent within each hour.**

The first trade that hits a bucket fixes that hour’s price for every later trade in that bucket, so `amount_usd` changes with iteration order instead of the trade’s own `block_time`. On volatile hours that skews realized USD, leaderboard totals, and paper P&L.

<details>
<summary>Suggested fix</summary>

```diff
-      const bucket = Math.floor(trade.block_time / 3600);
+      const bucket = Math.floor(trade.block_time / 300);
```

Using a 5-minute bucket matches the candle tolerance already used above and removes the worst of the hour-level drift. Exact `block_time` caching is even safer if the request volume is acceptable.
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/backfill-usd.ts` around lines 147 - 171, The solUsdCache currently
keys by Math.floor(trade.block_time / 3600) so the first trade in an hour fixes
that hour’s USD rate for all later trades; change the caching key to be
finer-grained (e.g. 5-minute buckets using Math.floor(trade.block_time / 300) or
use exact unixTime) so each trade looks up/getSolUsdAt(trade.block_time) for its
own time and store under that finer bucket in solUsdCache; update the code paths
around bucket, cached, and the cache.set/get so they use the new bucket
computation while preserving the BirdEyeRateLimitError retry loop and sleep
behavior.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/birdeye-client.ts (1)</summary><blockquote>

`168-171`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Parse `Retry-After` HTTP dates too, not just delta-seconds.**

HTTP allows `Retry-After` to be either a number of seconds or an HTTP-date. With the current numeric-only parse, a date-form header becomes `null`, so downstream callers fall back to the hardcoded 30s and can re-hit BirdEye before the throttle window actually expires.

<details>
<summary>Suggested fix</summary>

```diff
     if (response.status === 429) {
       const header = response.headers.get("retry-after");
-      const retryAfter = header && Number.isFinite(Number(header)) ? Number(header) : null;
+      const retryAfter =
+        header == null
+          ? null
+          : Number.isFinite(Number(header))
+            ? Number(header)
+            : (() => {
+                const retryAtMs = Date.parse(header);
+                return Number.isFinite(retryAtMs)
+                  ? Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000))
+                  : null;
+              })();
       throw new BirdEyeRateLimitError(retryAfter);
     }
```
</details>

   
As per coding guidelines, `src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals).

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/birdeye-client.ts` around lines 168 - 171, The code only
treats the Retry-After header as delta-seconds, so HTTP-date values become null
and callers may retry too early; update the parsing logic around
response.headers.get("retry-after") (the block that throws
BirdEyeRateLimitError) to: first attempt to parse the header as an integer
seconds value, and if that fails attempt to parse it as an HTTP-date
(Date.parse) and compute the seconds until that date (Math.ceil((dateMs -
Date.now())/1000)); if the computed seconds is NaN or negative treat it as null
(or a safe minimum), then pass that numeric retryAfter into new
BirdEyeRateLimitError(retryAfter). Ensure you reference the existing variable
names (response, header, retryAfter, BirdEyeRateLimitError) and preserve current
behavior when parsing yields null.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/dexscreener-client.ts (1)</summary><blockquote>

`38-68`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Stop mapping transport and schema failures to `[]`.**

`[]` should mean “DexScreener confirmed no pairs”. Here Line 44, Line 56, Line 64, and Line 68 also return `[]` for timeouts, invalid JSON, unexpected statuses, and schema drift, so callers cannot distinguish provider failure from a genuinely empty token. On the risk path that silently degrades into stale-liquidity fallback instead of surfacing that the live source is unavailable.

<details>
<summary>Suggested direction</summary>

```diff
+export class DexScreenerResponseError extends Error {
+  constructor(message: string) {
+    super(message);
+    this.name = "DexScreenerResponseError";
+  }
+}
+
 export class DexScreenerClient {
   async getTokenPairs(mint: string): Promise<DexPair[]> {
     let response: Response;
     try {
       response = await fetch(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`, {
         signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
       });
     } catch (error) {
       logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "dexscreener: getTokenPairs network/timeout");
-      return [];
+      throw new DexScreenerResponseError("DexScreener network/timeout");
     }
@@
     if (response.status === 404) return [];
     if (!response.ok) {
       logger.warn({ mint, status: response.status }, "dexscreener: unexpected non-OK status");
-      return [];
+      throw new DexScreenerResponseError(`DexScreener unexpected status ${response.status}`);
     }
@@
     } catch (error) {
       logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "dexscreener: invalid JSON");
-      return [];
+      throw new DexScreenerResponseError("DexScreener invalid JSON");
     }
-    if (!Array.isArray(data)) return [];
+    if (!Array.isArray(data)) throw new DexScreenerResponseError("DexScreener payload was not an array");
```
</details>

   
As per coding guidelines, `src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals).

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/dexscreener-client.ts` around lines 38 - 68, The getTokenPairs
function currently maps network/timeout failures, non-OK/unexpected statuses,
invalid JSON, and schema drift to an empty array which conflates provider
failures with a genuine empty result; change getTokenPairs to only return []
when the parsed response is a confirmed empty list from DexScreener, and throw
distinct errors for transport/timeouts, unexpected HTTP statuses, rate limits
(keep DexScreenerRateLimitError), server errors (keep DexScreenerServerError),
and parse/schema problems (introduce DexScreenerParseError or
DexScreenerSchemaError); update error handling in the fetch block
(network/AbortSignal timeout) to throw a network/fetch error instead of
returning [], change the non-OK branch that logs and returns [] to throw an
unexpected-status error, and when response.json() fails or the JSON schema is
not the expected array shape throw the parse/schema error so callers can
differentiate provider unavailability from a true empty pair list (adjust
calling code to catch these new error types as needed).
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-auditor.ts (1)</summary><blockquote>

`14-26`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Quarantine positions with no real backing convergence.**

The `LEFT JOIN` still lets orphaned `OPEN`/`PARTIAL` rows through. A manually seeded position with sane prices and `tier !== "WATCH"` but no matching `convergences` row will pass because `conv_tier` and null `wallet_count` are ignored.

  

<details>
<summary>🐛 Minimal fix</summary>

```diff
-    if (pos.tier === "WATCH") violations.push("WATCH tier position");
+    if (pos.conv_tier == null) violations.push("missing backing convergence");
+    else if (pos.conv_tier === "WATCH") violations.push("WATCH tier position");
@@
-    if (pos.wallet_count !== null && pos.wallet_count < 2) violations.push(`convergence had only ${pos.wallet_count} wallet(s)`);
+    if (pos.wallet_count == null) violations.push("missing convergence wallet count");
+    else if (pos.wallet_count < 2) violations.push(`convergence had only ${pos.wallet_count} wallet(s)`);
```
</details>

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-auditor.ts` around lines 14 - 26, The query in the
.prepare(...) call currently uses LEFT JOIN so orphaned OPEN/PARTIAL positions
with no matching convergence pass validation; change the join to an INNER JOIN
(or add an explicit WHERE c.id IS NOT NULL) so only positions with a real
convergence are returned, and update the validation around
pos.wallet_count/pos.conv_tier in the loop (in the positions handling code) to
treat null wallet_count or null conv_tier as a quarantine violation (e.g., push
a reason like "missing convergence" when wallet_count === null or conv_tier ===
null) so orphaned positions are flagged rather than ignored.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-manager.ts (2)</summary><blockquote>

`190-196`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Whale-sell exits still fail open when wallet metadata is unavailable.**

If `this.wallets` is unset, every qualifying sell is treated as trusted and can liquidate positions. In the execution path this should fail closed: require `WalletModel` at configure time or return early here when classifications are unavailable.

  

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 190 - 196, The whale-sell
guard incorrectly "fails open" when this.wallets is undefined; update the
execution path so wallet classifications are always required: enforce that a
WalletModel instance is provided during configuration (constructor or configure
method) and throw/return an error if missing, or add an early-return/abort in
the sell path when this.wallets is falsy so no sell proceeds without
classifications. Locate the check around this.wallets and
qualityFor([walletAddress]) in position-manager (use symbols this.wallets,
WalletModel, qualityFor, walletAddress, tokenMint, logger.info) and change the
behavior to fail closed (reject or abort execution) rather than treating
unclassified wallets as trusted. Ensure the change surfaces a clear error/log
entry and prevents downstream position liquidation when classifications are
unavailable.
```

</details>

---

`333-340`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**The portfolio loss cap still measures only the current position.**

This compares one row's unrealized loss to total NAV, so several sub-threshold losers can breach the 3% portfolio cap without ever tripping it. Sum unrealized losses across all `OPEN`/`PARTIAL` positions, using `priceUsd` for the current row and stored prices for the rest, before deciding.

  

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 333 - 340, The
checkDollarStop method incorrectly compares only the current position's
unrealized loss against NAV; update checkDollarStop to compute the aggregated
unrealized loss across all OPEN/PARTIAL positions (use priceUsd for the position
under evaluation and each other position's stored current price field for their
unrealized loss) before comparing to MAX_DOLLAR_LOSS_PORTFOLIO_PCT, then call
exit(position, "DOLLAR_LOSS_CAP", 100, true) only if the summed loss breaches
the threshold; ensure you iterate the in-memory/store of positions (the same
collection used elsewhere in this class), convert token amounts/prices with the
same decimals/units as used by position.amount_token and entry_price_usd to
avoid lamport/decimal mismatches, and keep using portfolioValueUsd() for NAV.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/convergence.ts (1)</summary><blockquote>

`155-180`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**The narrow-window recheck is still over-downgrading high tiers.**

`threshold` is the wide-window admission gate. Reusing it inside `Math.max(threshold, getMinWalletsForTier(tier))` means a token can satisfy CRITICAL's 30-minute floor of 3 wallets and still be downgraded whenever the global threshold grows above 3. The revalidation step should use the candidate tier's own narrow-window floor only.

  

<details>
<summary>🐛 Minimal fix</summary>

```diff
-function validateTierWindow(
+function validateTierWindow(
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

As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/convergence.ts` around lines 155 - 180, validateTierWindow is
incorrectly using the global wide-window `threshold` during the narrow recheck
(Math.max(threshold, getMinWalletsForTier(tier))) which allows a high-tier
candidate to be downgraded when the global threshold > the tier's own floor;
change the revalidation to use only the candidate tier's narrow-window floor by
replacing Math.max(threshold, getMinWalletsForTier(tier)) with
getMinWalletsForTier(tier), keeping the rest of the logic (tierWindowSeconds,
tierSince, tierWallets) intact so the CRITICAL/NOTABLE 30/60-minute floors are
enforced independently of the global threshold.
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
In `@docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md`:
- Around line 150-153: Remove the incorrect recommendation to use "ADD COLUMN IF
NOT EXISTS" in the migration guidance and instead reference the idempotent
approach already described earlier: check column existence with PRAGMA
table_info(wallets) before applying the migration or run the migration via your
migration runner so it handles idempotency; mention the specific migration file
004_wallet_pnl_tracking.sql as the one to apply manually if the runner is not
available, and ensure the guidance notes the wallets table and wallet_class
column checks rather than suggesting unsupported SQLite syntax.

In `@docs/superpowers/plans/2026-05-06-pnl-leaderboard.md`:
- Around line 87-103: The plan currently aggregates by (wallet, token_mint) into
single cycles; instead, implement FIFO lot matching over the 30-day window when
processing `trades` for each active `wallet`: sort buys by `block_time` and
consume those buy lots against sells in chronological order to form close events
(full close, partial close, or open lot) rather than netting by token; compute
cycle status per lot (CLOSED if a buy lot is fully consumed, PARTIAL if
partially consumed, OPEN if remaining), and derive per-wallet metrics
(`realized_sol`, `realized_usd`, `wins`, `win_rate`, `avg_hold_time_s`,
`locked_sol`, `n_closed`, `n_open`, `n_partial`, `n_buys`, `n_sells`,
`n_trades`) from those FIFO-close events (realized = sum(sell - buy) over CLOSED
lots, win when sell_sol > buy_sol, avg_hold_time_s from sell.block_time -
buy.block_time for closed lots, locked_sol = sum(buy_sol of remaining OPEN
lots).

In `@scripts/leaderboard.ts`:
- Around line 128-153: The wallet field n_partial is never incremented; update
the open-processing logic to detect wallets that both closed cycles and still
have residual open inventory by building a set of (wallet, mint) pairs from
matched.cycles and then, when iterating matched.open, if the pair exists in that
set increment the corresponding wallet.n_partial in addition to wallet.n_open
and locked_sol; use the existing symbols matched.cycles, matched.open, metrics,
wallet.n_partial and ensure the pair key (e.g., `${wallet}-${mint}`) is
consistently created and checked so n_partial reflects partial positions.

In `@scripts/start-funnel.sh`:
- Around line 14-24: The script currently writes the tunnel endpoint to URL_FILE
before verifying funnel status or successfully starting it; move the write so
that the URL is published only after confirmation that the funnel is configured
or started (i.e., after the successful branch of the `if "$TS_BIN" funnel status
...` check and after a successful `"$TS_BIN" funnel --bg 3000`), and ensure on
failure the URL_FILE is cleared (use the existing `: > "$URL_FILE"` behavior)
and exit with error; update references around URL_FILE, TS_BIN, `funnel status`,
`funnel --bg 3000`, and LOGFILE accordingly so monitor mode writes the URL only
when the funnel is actually up.

In `@src/engine/fifo-matcher.ts`:
- Around line 49-58: The current sort in FIFO matcher forces BUY before SELL on
equal block_time which can create artificial inventory; change the comparator in
sortedTrades to only order by block_time and return 0 for ties (i.e., remove the
a.type tie-breaker) so the original stable order from trades is preserved, or if
true intra-timestamp ordering is required, add a monotonic sequence/id field to
RawTrade and sort by (block_time, sequence) instead while keeping no ordering by
type.

In `@src/execution/position-manager.ts`:
- Around line 131-138: The catch block in PositionManager.insert (the code
handling insertion errors) currently uses isSqliteConstraint(error) which
matches any SQLITE_CONSTRAINT_* and can hide real insert bugs; change it to only
treat the UNIQUE constraint as the "active-position" collision by checking for
the specific SQLITE_CONSTRAINT_UNIQUE code (or the exact full error string)
before calling findOpenByMint(input.tokenMint) and returning the existing row;
keep the existing logger.info({ mint: input.tokenMint, positionId: existing.id
}, ...) path only for this UNIQUE-case and let other constraint errors rethrow
so real NOT NULL/CHECK/FOREIGN KEY issues surface.

In `@src/execution/risk-engine.ts`:
- Around line 84-90: volatility being null/zero or extremely high currently
yields volAdj=1 and lets positions through; change the gating so unknown
(null/<=0) or outsized volatility (> MAX_VOL_PCT, e.g. 300) blocks entry by
forcing size to zero. Update the logic around volatility/volAdj in the risk
calculation (the code using
numberConfig(`token:${convergence.token_mint}:realized_vol_24h_pct`) and the
volAdj/floorApplied/adjustedSizePct computation): introduce a MAX_VOL_PCT
constant, treat volatility === null || volatility <= 0 || volatility >
MAX_VOL_PCT as a hard-fail path that sets adjustedSizePct = 0 (or returns early)
instead of applying MIRROR_MIN_PCT; otherwise keep the existing downscaling math
(volAdj = Math.min(1, 50 / volatility)) and then compute
floorApplied/adjustedSizePct as before. Ensure this change references
computeMirrorSizePct, volatility/volAdj, floorApplied, adjustedSizePct and
preserves drawdownHalve behavior.
- Around line 143-156: computeMirrorSizePct currently swallows Jupiter pricing
failures by using .catch(() => null) which causes silent fallback to
MIRROR_FALLBACK_PCT; instead surface the failure: remove the silent catch and
either let jupiterClient.getPriceUsd(SOL_MINT) throw naturally or catch the
error inside computeMirrorSizePct, log/warn with context (include SOL_MINT,
trades.length, portfolioValueUsd) via the module's logger and then rethrow a
descriptive Error so callers of computeMirrorSizePct can fail fast (or
explicitly handle the fallback), referencing computeMirrorSizePct and
jupiterClient.getPriceUsd(SOL_MINT) when making the change.

In `@src/execution/trade-executor.ts`:
- Around line 190-193: The amountLamports calculation currently rounds
sellAmountToken before applying decimals causing fractional tokens to be lost;
change the logic in the amountLamports expression so you first scale
sellAmountToken by 10**decimals, then truncate to an integer (e.g., floor) and
convert to BigInt, ensuring you still enforce a minimum of 1 lamport; reference
the amountLamports field and the sellAmountToken and decimals variables and, for
large decimals where float precision may be insufficient, use a
decimal/bignumber library to perform the scaling and truncation before
converting to BigInt.

In `@src/index.ts`:
- Line 99: The startup timer currently invokes leaderboardJob directly,
bypassing the mutex-protected path and risking concurrent DB writes; change the
setTimeout call to invoke leaderboardJobGuarded (the guarded wrapper that
acquires the leaderboard mutex) instead of leaderboardJob so the
startup-triggered run goes through the same locking logic as the periodic minute
check; ensure any arguments passed to leaderboardJob are forwarded to
leaderboardJobGuarded if needed.

In `@src/storage/database.ts`:
- Around line 39-59: Replace the deferred transaction with an immediate one so
the migration acquires the write lock before probing schema: change the call
that creates tx from db.transaction(() => { ... }) to
db.transaction.immediate(() => { ... }) (keep invoking tx() afterwards). This
ensures the transaction obtains the write lock up-front and prevents concurrent
processes from both seeing the pre-migration schema and running the same ALTER
TABLE.

In `@src/storage/migrations/006_co_buyer_index_covering.sql`:
- Around line 3-5: The migration unconditionally drops
idx_trades_token_type_time then recreates it, causing repeated full index
rebuilds on trades; instead make the change idempotent by either removing the
DROP and using only CREATE INDEX IF NOT EXISTS idx_trades_token_type_time ON
trades(token_mint, trade_type, block_time, wallet_address), or (safer) replace
the statements with a conditional DO block that queries
pg_indexes/pg_get_indexdef for idx_trades_token_type_time and only executes DROP
+ CREATE when the existing index definition differs from the desired definition
(compare column list token_mint, trade_type, block_time, wallet_address) so the
index is rebuilt only when its definition is outdated.

In `@src/storage/migrations/007_positions_active_unique.sql`:
- Around line 4-6: Before creating the unique partial index
idx_positions_active_mint on positions(token_mint) for statuses
'OPEN'/'PARTIAL', add a deterministic cleanup step that finds token_mint groups
with >1 active row and keeps exactly one (e.g., by highest id or latest
updated_at) while archiving or marking the others as non-active; update the
migration to run that dedupe (move rows to an archive table or set
status='ARCHIVED'/'CLOSED' deterministically) then create the unique index so
migration won't fail due to existing duplicates.

---

Duplicate comments:
In `@scripts/backfill-usd.ts`:
- Around line 147-171: The solUsdCache currently keys by
Math.floor(trade.block_time / 3600) so the first trade in an hour fixes that
hour’s USD rate for all later trades; change the caching key to be finer-grained
(e.g. 5-minute buckets using Math.floor(trade.block_time / 300) or use exact
unixTime) so each trade looks up/getSolUsdAt(trade.block_time) for its own time
and store under that finer bucket in solUsdCache; update the code paths around
bucket, cached, and the cache.set/get so they use the new bucket computation
while preserving the BirdEyeRateLimitError retry loop and sleep behavior.

In `@scripts/leaderboard.ts`:
- Around line 166-180: The current trades query only selects post-cutoff rows so
matchFifo is missing pre-cutoff opening lots; change the logic so you first seed
matchFifo with historical inventory by querying trades before the cutoff (for
the same wallet_address/token_mint set) and passing those as the initial
inventory before feeding the in-window trades to matchFifo; specifically add or
replace usage around the trades variable/RawTrade results so you run a preCutoff
query (or extend the WHERE to include earlier opens) for seeding, then call
matchFifo with [preCutoffTrades, inWindowTrades] (or call matchFifo twice: seed
then process) to ensure sells inside the 30-day window realize P&L against
pre-cutoff buys.

In `@src/blockchain/birdeye-client.ts`:
- Around line 168-171: The code only treats the Retry-After header as
delta-seconds, so HTTP-date values become null and callers may retry too early;
update the parsing logic around response.headers.get("retry-after") (the block
that throws BirdEyeRateLimitError) to: first attempt to parse the header as an
integer seconds value, and if that fails attempt to parse it as an HTTP-date
(Date.parse) and compute the seconds until that date (Math.ceil((dateMs -
Date.now())/1000)); if the computed seconds is NaN or negative treat it as null
(or a safe minimum), then pass that numeric retryAfter into new
BirdEyeRateLimitError(retryAfter). Ensure you reference the existing variable
names (response, header, retryAfter, BirdEyeRateLimitError) and preserve current
behavior when parsing yields null.

In `@src/blockchain/dexscreener-client.ts`:
- Around line 38-68: The getTokenPairs function currently maps network/timeout
failures, non-OK/unexpected statuses, invalid JSON, and schema drift to an empty
array which conflates provider failures with a genuine empty result; change
getTokenPairs to only return [] when the parsed response is a confirmed empty
list from DexScreener, and throw distinct errors for transport/timeouts,
unexpected HTTP statuses, rate limits (keep DexScreenerRateLimitError), server
errors (keep DexScreenerServerError), and parse/schema problems (introduce
DexScreenerParseError or DexScreenerSchemaError); update error handling in the
fetch block (network/AbortSignal timeout) to throw a network/fetch error instead
of returning [], change the non-OK branch that logs and returns [] to throw an
unexpected-status error, and when response.json() fails or the JSON schema is
not the expected array shape throw the parse/schema error so callers can
differentiate provider unavailability from a true empty pair list (adjust
calling code to catch these new error types as needed).

In `@src/blockchain/helius-client.ts`:
- Around line 98-105: The error handling in getWalletTransactions currently
treats 401/403 like a harmless end-of-history and breaks pagination; instead
detect authentication/config errors (status 401 or 403) in the response.ok false
branch and throw a HeliusRequestError (same as for 429/5xx) so callers can
surface/retry the operational failure; update the response.status checks inside
getWalletTransactions to include 401 and 403 as throwable conditions and keep
only true client-4xx (non-auth) responses as the silent pagination stop.

In `@src/engine/convergence.ts`:
- Around line 155-180: validateTierWindow is incorrectly using the global
wide-window `threshold` during the narrow recheck (Math.max(threshold,
getMinWalletsForTier(tier))) which allows a high-tier candidate to be downgraded
when the global threshold > the tier's own floor; change the revalidation to use
only the candidate tier's narrow-window floor by replacing Math.max(threshold,
getMinWalletsForTier(tier)) with getMinWalletsForTier(tier), keeping the rest of
the logic (tierWindowSeconds, tierSince, tierWallets) intact so the
CRITICAL/NOTABLE 30/60-minute floors are enforced independently of the global
threshold.

In `@src/execution/position-auditor.ts`:
- Around line 14-26: The query in the .prepare(...) call currently uses LEFT
JOIN so orphaned OPEN/PARTIAL positions with no matching convergence pass
validation; change the join to an INNER JOIN (or add an explicit WHERE c.id IS
NOT NULL) so only positions with a real convergence are returned, and update the
validation around pos.wallet_count/pos.conv_tier in the loop (in the positions
handling code) to treat null wallet_count or null conv_tier as a quarantine
violation (e.g., push a reason like "missing convergence" when wallet_count ===
null or conv_tier === null) so orphaned positions are flagged rather than
ignored.

In `@src/execution/position-manager.ts`:
- Around line 190-196: The whale-sell guard incorrectly "fails open" when
this.wallets is undefined; update the execution path so wallet classifications
are always required: enforce that a WalletModel instance is provided during
configuration (constructor or configure method) and throw/return an error if
missing, or add an early-return/abort in the sell path when this.wallets is
falsy so no sell proceeds without classifications. Locate the check around
this.wallets and qualityFor([walletAddress]) in position-manager (use symbols
this.wallets, WalletModel, qualityFor, walletAddress, tokenMint, logger.info)
and change the behavior to fail closed (reject or abort execution) rather than
treating unclassified wallets as trusted. Ensure the change surfaces a clear
error/log entry and prevents downstream position liquidation when
classifications are unavailable.
- Around line 333-340: The checkDollarStop method incorrectly compares only the
current position's unrealized loss against NAV; update checkDollarStop to
compute the aggregated unrealized loss across all OPEN/PARTIAL positions (use
priceUsd for the position under evaluation and each other position's stored
current price field for their unrealized loss) before comparing to
MAX_DOLLAR_LOSS_PORTFOLIO_PCT, then call exit(position, "DOLLAR_LOSS_CAP", 100,
true) only if the summed loss breaches the threshold; ensure you iterate the
in-memory/store of positions (the same collection used elsewhere in this class),
convert token amounts/prices with the same decimals/units as used by
position.amount_token and entry_price_usd to avoid lamport/decimal mismatches,
and keep using portfolioValueUsd() for NAV.
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

**Run ID**: `d4256ebf-d5ef-4648-890f-99e35714efe5`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and 150a98550302f41832e5aa9493403e04db7ccf80.

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
* src/frontend/pages/Settings.tsx
* src/frontend/hooks/useSSE.ts
* src/frontend/components/StatusBadge.tsx
* src/frontend/components/ConvergenceCard.tsx
* src/utils/retry.ts
* src/frontend/components/WalletTable.tsx
* src/frontend/pages/Wallets.tsx
* src/jobs/catchup.ts
* src/jobs/token-metadata.ts
* .env.example
* src/jobs/cleanup.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
