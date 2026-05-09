**Actionable comments posted: 6**

<details>
<summary>♻️ Duplicate comments (16)</summary><blockquote>

<details>
<summary>src/storage/database.ts (1)</summary><blockquote>

`38-59`: _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

**Concurrent startup race condition — use `tx.immediate()` instead of `tx()`.**

With deferred transactions (`tx()`), two concurrent startups can both execute `PRAGMA table_info` before either acquires a write lock. Both processes observe the pre-migration schema, attempt the same `ALTER TABLE` statements, and the second fails with "duplicate column" error after the first commits.

Using `tx.immediate()` acquires the write lock upfront, preventing both processes from seeing the pre-migration state simultaneously.

Line 58 still calls `tx()` (deferred mode) instead of `tx.immediate()`.

<details>
<summary>Fix</summary>

```diff
   });
-  tx();
+  tx.immediate();
 }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/storage/database.ts` around lines 38 - 59, The migration uses a deferred
transaction via tx() which allows a race; change the call at the end of
runWalletPnlTrackingMigration to use tx.immediate() so the transaction acquires
a write lock before probing/ALTERing the schema. In practice, locate
runWalletPnlTrackingMigration where you create const tx = db.transaction(() => {
... }) and replace the final invocation tx() with tx.immediate() to run the
migration in immediate mode and prevent concurrent ALTER TABLE races.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/dexscreener-client.ts (1)</summary><blockquote>

`38-68`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Don't collapse transport and parse failures into an empty-pairs result.**

`[]` should mean "DexScreener confirmed no pairs." Here, timeouts, network failures, invalid JSON, and unexpected statuses still get converted to the same signal, so downstream risk code can quietly fall back to stale liquidity data.

  
<details>
<summary>Suggested fix</summary>

```diff
     try {
       response = await fetch(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`, {
         signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
       });
     } catch (error) {
-      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "dexscreener: getTokenPairs network/timeout");
-      return [];
+      throw new Error(`DexScreener transport failure: ${error instanceof Error ? error.message : String(error)}`);
     }
@@
     if (!response.ok) {
-      logger.warn({ mint, status: response.status }, "dexscreener: unexpected non-OK status");
-      return [];
+      throw new Error(`DexScreener unexpected status ${response.status}`);
     }
@@
     try {
       data = await response.json();
     } catch (error) {
-      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "dexscreener: invalid JSON");
-      return [];
+      throw new Error(`DexScreener invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
     }
-    if (!Array.isArray(data)) return [];
+    if (!Array.isArray(data)) throw new Error("DexScreener payload was not an array");
```
</details>
As per coding guidelines, "`src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals)."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/dexscreener-client.ts` around lines 38 - 68, The getTokenPairs
function currently converts network timeouts, fetch failures, non-JSON
responses, and unexpected statuses into an empty DexPair[] which hides upstream
errors; change the fetch and JSON parsing error paths to throw distinct errors
instead of returning [], e.g. throw a DexScreenerNetworkError (or similar) from
the catch around fetch, throw a DexScreenerParseError from the catch around
response.json(), and throw a DexScreenerUnexpectedStatusError for unexpected
non-OK, non-404 statuses (keep existing DexScreenerRateLimitError and
DexScreenerServerError behavior); preserve the logger.warn calls but return []
only when response.status === 404 or when the parsed JSON is an actual empty
array, so callers can differentiate “no pairs” from transport/parse failures.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/fifo-matcher.ts (1)</summary><blockquote>

`49-58`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Preserve original order for equal-timestamp trades.**

Forcing `BUY` before `SELL` on the same `block_time` can create inventory that did not exist at sell time. That changes realized P&L, hold times, and `unmatched_sells`.

  
<details>
<summary>Suggested fix</summary>

```diff
-  const sortedTrades = [...trades].sort((a, b) => {
-    if (a.block_time !== b.block_time) return a.block_time - b.block_time;
-    if (a.type === b.type) return 0;
-    return a.type === "BUY" ? -1 : 1;
-  });
+  const sortedTrades = trades
+    .map((trade, index) => ({ trade, index }))
+    .sort((a, b) => a.trade.block_time - b.trade.block_time || a.index - b.index)
+    .map(({ trade }) => trade);
```
</details>
As per coding guidelines, "`src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/fifo-matcher.ts` around lines 49 - 58, The comparator in
sortedTrades forces BUY before SELL for equal block_time which can create
inventory that didn't exist at sell time; instead preserve original input order
for equal-timestamp trades by stable-sorting using the original index as the
tie-breaker: capture the original index when mapping trades, sort primarily by
block_time and secondarily by that index (not by type), and then restore the
trade objects; update references to sortedTrades/trades and fields block_time
and type accordingly so equal-timestamp BUY/SELL keep their original sequence.
```

</details>

</blockquote></details>
<details>
<summary>src/storage/migrations/007_positions_active_unique.sql (1)</summary><blockquote>

`4-6`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Migration will fail if existing data has duplicate active positions per mint.**

If the database already has multiple `OPEN`/`PARTIAL` rows for the same `token_mint`, `CREATE UNIQUE INDEX` fails and halts migrations at startup. This was flagged in a prior review and remains unaddressed.

Add a deterministic cleanup step before the index creation:

<details>
<summary>Suggested migration with dedupe</summary>

```diff
 -- Ensure at most one OPEN/PARTIAL position per token_mint.
 -- Eliminates the SELECT -> openPosition race window that lets two concurrent
 -- convergences open duplicate positions on the same mint.
+
+-- Archive duplicate active positions, keeping the one with the highest id
+UPDATE positions
+SET status = 'CLOSED_DUPE'
+WHERE status IN ('OPEN', 'PARTIAL')
+  AND id NOT IN (
+    SELECT MAX(id) FROM positions
+    WHERE status IN ('OPEN', 'PARTIAL')
+    GROUP BY token_mint
+  );
+
 CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_active_mint
   ON positions(token_mint)
   WHERE status IN ('OPEN', 'PARTIAL');
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/storage/migrations/007_positions_active_unique.sql` around lines 4 - 6,
Existing duplicate active rows will make CREATE UNIQUE INDEX
idx_positions_active_mint fail; add a deterministic dedupe step that runs before
the index creation to remove all but one active row per token_mint (e.g., keep
the row with the greatest id or latest updated_at). Implement this as a single
transactional SQL CTE that deletes from positions where status IN
('OPEN','PARTIAL') and id NOT IN (SELECT MAX(id) FROM positions WHERE status IN
('OPEN','PARTIAL') GROUP BY token_mint) (or use MAX(updated_at) if updated_at
exists), then create the unique index; reference the table positions, column
token_mint, the status filter, and the index name idx_positions_active_mint so
the migration is deterministic and safe on existing data.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/risk-engine.ts (1)</summary><blockquote>

`152-153`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Jupiter pricing failures silently fall back to 1% mirror sizing.**

When `jupiterClient.getPriceUsd(SOL_MINT)` fails, the catch swallows the error and returns `MIRROR_FALLBACK_PCT` (1%). No warning is logged at the risk-engine level, so operators won't know sizing is disconnected from actual mirror history. This can systematically distort P&L if median SOL sizes differ materially from 1%.

<details>
<summary>Suggested: log warning on fallback</summary>

```diff
-    const solPriceUsd = await jupiterClient.getPriceUsd(SOL_MINT).catch(() => null);
-    if (!solPriceUsd || solPriceUsd <= 0) return MIRROR_FALLBACK_PCT;
+    const solPriceUsd = await jupiterClient.getPriceUsd(SOL_MINT).catch((err) => {
+      logger.warn({ err: err instanceof Error ? err : new Error(String(err)) }, "risk-engine: Jupiter pricing unavailable, using fallback mirror size");
+      return null;
+    });
+    if (!solPriceUsd || solPriceUsd <= 0) return MIRROR_FALLBACK_PCT;
```
</details>

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/risk-engine.ts` around lines 152 - 153, The code swallows
errors from jupiterClient.getPriceUsd(SOL_MINT) and silently returns
MIRROR_FALLBACK_PCT; update the call to capture the error and log a warning when
fallback is used (e.g., change .catch(() => null) to .catch(err => { /* log
warning with err and context */ return null; }) ) and also add a warning log
when solPriceUsd is null or <= 0 before returning MIRROR_FALLBACK_PCT; reference
solPriceUsd, jupiterClient.getPriceUsd, and MIRROR_FALLBACK_PCT and use the
existing risk-engine logger (or processLogger) to include the error and a clear
message that sizing will use the fallback.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-auditor.ts (1)</summary><blockquote>

`22-30`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Use backing convergence tier for WATCH quarantine, not only stored position tier.**

Line 22 checks `pos.tier` only. If `positions.tier` is stale but `conv_tier` is `WATCH`, the auditor can miss a position that should be quarantined.

 

<details>
<summary>Suggested fix</summary>

```diff
-    if (pos.tier === "WATCH") violations.push("WATCH tier position");
+    // Prefer backing convergence tier when present; fallback to stored position tier.
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

In `@src/execution/position-auditor.ts` around lines 22 - 30, The auditor
currently only checks pos.tier for WATCH quarantine and can miss positions whose
stored tier is stale but whose backing convergence tier (pos.conv_tier) is
WATCH; update the logic in position-auditor.ts to treat a position as WATCH if
either pos.tier === "WATCH" or pos.conv_tier === "WATCH" (taking care to not
dereference conv_tier when it's null), and ensure the orphan check
(pos.conv_tier === null || pos.wallet_count === null) remains correct so you
don't consult conv_tier before validating it's present; modify the WATCH check
that references pos.tier to include pos.conv_tier as described.
```

</details>

</blockquote></details>
<details>
<summary>scripts/leaderboard.ts (2)</summary><blockquote>

`166-180`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Seed FIFO with pre-window inventory before matching.**

The query still loads only trades newer than `cutoff`. A sell inside the 30-day window that closes inventory opened just before the cutoff becomes `unmatched_sells` and drops out of realized P&L, win rate, and the `wallet_class` write-back. For a realized 30-day leaderboard, the sell in-window still needs the opening lots that existed at the cutoff.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/leaderboard.ts` around lines 166 - 180, The query assigned to trades
(the RawTrade[] loaded into trades) currently filters only block_time > cutoff,
which omits pre-cutoff opening lots needed to seed FIFO; modify the WHERE clause
in the db.prepare call (the SQL used to populate trades) to include pre-cutoff
buys/lots for seeding—e.g., change the condition to "WHERE (block_time > ? OR
(block_time <= ? AND trade_type = 'buy')) AND wallet_address IN (SELECT address
FROM wallets WHERE active = 1)" (keep the ORDER BY wallet_address, token_mint,
block_time, id) so sells inside the window can match against inventory opened
before cutoff. Ensure you bind cutoff twice when calling .all(...).
```

</details>

---

`128-133`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**`n_partial` is still never populated.**

Open positions only increment `n_open`, so `n_partial` stays `0` even when a wallet both closes cycles and keeps residual inventory open for the same mint. That makes the exported JSON internally wrong on mixed closed/open books.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/leaderboard.ts` around lines 128 - 133, When counting open positions
in the loop over matched.open, detect mixed closed/open mints and increment
wallet.n_partial instead of wallet.n_open; specifically, for each position in
matched.open check if matched.closed.some(c => c.mint === position.mint) and if
true do wallet.n_partial += 1 (else wallet.n_open += 1), still adding
position.locked_sol to wallet.locked_sol—update the loop handling in
scripts/leaderboard.ts to use this mint-existence check so n_partial is
populated for wallets that both closed cycles and keep residual open inventory.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/scorer.ts (2)</summary><blockquote>

`95-98`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Manipulation flags still run on a different dataset than scoring.**

`buildPositions()` and `totalTrades` fold in `heliusTxs`, but `computeHoldTimes()` / `detectWashTrading()` still inspect only persisted `trades`. When ingestion lags, the same wallet can avoid demotion in this pass and then flip on the next run once SQLite catches up. Run the manipulation scan over the same unified fills used for P&L/activity.
  
As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 95 - 98, computeHoldTimes() and
detectWashTrading() are still using the persisted trades array while
buildPositions()/totalTrades incorporate heliusTxs, causing divergent flags when
ingestion lags; change the calls so both computeHoldTimes(...) and
detectWashTrading(...) receive the same unified fills used by
buildPositions/totalTrades (the merged/normalized fills array derived from
heliusTxs + persisted trades) instead of the local persisted trades variable,
and update signatures if needed to accept that unified fills collection so
manipulation scanning runs over the exact dataset used for P&L/activity.
```

</details>

---

`37-84`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**MEV/wash matching is still not quantity-aware.**

Both helpers dequeue a whole BUY row as soon as any SELL for that mint appears. A tiny partial exit can therefore create a full round trip, shorten the median hold time, and inflate the wash fraction enough to demote a wallet incorrectly. Track remaining quantity per lot and match partial fills proportionally.
  
As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 37 - 84, computeHoldTimes and
detectWashTrading currently treat each BUY/SELL row as indivisible, causing
partial sells to incorrectly consume whole buy lots; modify both functions
(computeHoldTimes, detectWashTrading) to track remaining quantity per queued buy
lot (e.g., wrap TradeRow into an object with remainingQty) and perform FIFO
matching using matchedQty = min(buy.remainingQty, sell.quantityRemaining),
decrement both sides, re-queue buys if remainingQty > 0, and only consider a
round-trip or push a hold-time for the matchedQty portion (emit the buy->sell
hold time matchedQty times or otherwise weight the holdTimes/roundTripCount by
quantity) so partial fills are matched proportionally; keep the same
WASH_TRADE_WINDOW_SEC and WASH_TRADE_FRACTION_THRESHOLD logic but compute
washCount and roundTripCount using matched quantities rather than per-row
counts.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/trade-executor.ts (2)</summary><blockquote>

`187-198`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Exit base-unit conversion is still lossy in `Number` space.**

Scaling before flooring fixed whole-token truncation, but `sellAmountToken * 10 ** decimals` is still a JS float. Once that product crosses safe-integer precision, `Math.floor(baseUnitsFloat)` can produce the wrong base-unit integer and sell the wrong on-chain amount. Do the scale/truncate step in decimal or string space and only then convert to `BigInt`.
   

```web
What precision limits does JavaScript Number have around Number.MAX_SAFE_INTEGER, and what precision-safe pattern is recommended for converting decimal token amounts into integer base units before converting to BigInt?
```

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/trade-executor.ts` around lines 187 - 198, The
scaling-to-base-units step uses floating-point math and can lose precision for
large values; fix it by doing the scale/truncate in string/BigInt space instead
of using Number: take the sellAmountToken as a string (or toString()), split
integer and fractional parts, right-pad or truncate the fractional part to
tokenDecimals (from tokenDecimals(current.token_mint)), concatenate
integer+fractional into a whole-number string, convert that to BigInt and use
that as amountLamports (with a fallback min of 1n); replace the
Math.floor/Number.isFinite logic in the executeSwap call with this
string-to-BigInt path so swaps.executeSwap receives an exact base-unit BigInt
for inputMint current.token_mint -> USDC_MINT conversion.
```

</details>

---

`52-58`: _⚠️ Potential issue_ | _🔴 Critical_ | _🏗️ Heavy lift_

**Reserve the mint before the external BUY.**

This is still only a read-side pre-check. Two workers can both pass here, both execute the swap, and then one only “dedupes” when `openPosition()` hits the unique constraint — after `fillExecution()` and `updatePaperBalance()` already ran. That still double-buys the mint and corrupts paper P&L. Claim the mint in the DB before `executeSwap()`, then release or finalize that claim on failure.
  
As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/trade-executor.ts` around lines 52 - 58, The current pre-check
using requireDb().prepare(...).get(...) in the existingPosition logic is racy
and can allow two workers to both pass and double-buy; instead, create an atomic
reservation step before calling executeSwap(): insert or upsert a
reservation/position row (e.g., status='RESERVED' or 'IN_PROGRESS') for
convergence.token_mint using a unique constraint inside a DB transaction so only
one worker can claim the mint, then proceed to executeSwap(); on success
transition that reservation to OPEN via
openPosition()/fillExecution()/updatePaperBalance() and on any failure rollback
or mark the reservation as FAILED and release the mint. Ensure the claim uses
the same DB (requireDb()) and unique token_mint constraint so the race is
prevented and always finalized on both success and error paths.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-manager.ts (3)</summary><blockquote>

`333-343`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Portfolio loss cap still measures one position, not the portfolio.**

This compares only the current position’s unrealized loss against total NAV. Several OPEN/PARTIAL positions can exceed the 3% portfolio cap in aggregate while each one individually stays below it, so the safety stop never triggers. Sum unrealized losses across all open positions before evaluating `MAX_DOLLAR_LOSS_PORTFOLIO_PCT`.
  
As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 333 - 343, The
checkDollarStop currently compares only the single position's unrealized loss to
portfolio NAV; change it to compute total unrealized loss across all open
positions (sum of amount_token * (entry_price_usd - currentPrice) for positions
where that value > 0) using your positions storage or a helper like
getOpenPositions(), then compute (totalUnrealizedLoss /
this.portfolioValueUsd()) * 100 and compare to MAX_DOLLAR_LOSS_PORTFOLIO_PCT; if
the threshold is exceeded, call this.exit(...) as before (or loop and exit all
open positions if intended) using the same parameters, and return true.
Reference: checkDollarStop, portfolioValueUsd, MAX_DOLLAR_LOSS_PORTFOLIO_PCT,
exit, PositionRow.
```

</details>

---

`75-77`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Don't let whale-sell exits fail open when `wallets` is missing.**

Making `wallets` optional means `onWhaleSell()` skips the trust gate entirely whenever this model is not wired. The same sell event then exits positions in one process and is ignored in another, including sells from `loser` / `accumulation_bot` wallets. Fail closed here or abort whale-sell exits when wallet quality data is unavailable.
  
As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 75 - 77, The configure method
currently treats wallets as optional which allows onWhaleSell to bypass the
trust gate when this.wallets is null; update the behavior so whale-sell exits
never "fail open": either make wallets required in configure (throw or assert
inside configure if input.wallets is missing) or add a guard inside onWhaleSell
that aborts the whale-sell exit flow when this.wallets is null and logs/returns
an error; reference the configure method and the onWhaleSell flow in
PositionManager and ensure any code paths that rely on WalletModel
(this.wallets) abort early rather than proceeding with a missing trust-gate.
```

</details>

---

`428-437`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Only swallow the active-position UNIQUE constraint here.**

This helper matches every `SQLITE_CONSTRAINT_*`. If the insert fails for NOT NULL, CHECK, or foreign-key reasons while another row for the mint exists, `openPosition()` will return that existing row and hide the real write bug. Restrict this to the specific UNIQUE violation for the active-position index and rethrow the rest.
   

```web
Does better-sqlite3 expose UNIQUE violations via a distinct `error.code` such as `SQLITE_CONSTRAINT_UNIQUE`, separate from generic `SQLITE_CONSTRAINT` and other constraint classes?
```

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 428 - 437, The helper is too
broad and swallows all SQLITE_CONSTRAINT_* errors; change isSqliteConstraint
(used by openPosition) to only treat UNIQUE violations for the active-position
index as ignorable: detect the error as an object with a string code and either
code === "SQLITE_CONSTRAINT_UNIQUE" or code === "SQLITE_CONSTRAINT" combined
with the error.message including the specific active-position index name (or the
engine-specific UNIQUE indicator); for any other constraint (NOT NULL, CHECK,
FK, or other SQLITE_CONSTRAINT_*) rethrow the error so callers can surface real
write bugs. Ensure you reference isSqliteConstraint and the openPosition call
path when implementing the stricter check.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/convergence.ts (1)</summary><blockquote>

`155-181`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**`validateTierWindow()` still diverges on replay and over-downgrades tiers.**

The cutoff is anchored to `Date.now()`, so the same historical buy set can lose NOTABLE/CRITICAL status as it ages in replay. It also requires `Math.max(threshold, getMinWalletsForTier(tier))` wallets inside the narrow window, which incorrectly downgrades cases like `threshold = 4` with 3 wallets in the CRITICAL 30-minute window even though the CRITICAL floor is 3. Use the latest buy timestamp as the reference clock, and validate the narrow window against the tier’s own floor.
  
As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/convergence.ts` around lines 155 - 181, validateTierWindow is
anchoring windows to Date.now() and using Math.max(threshold,
getMinWalletsForTier(tier)) for the narrow-window check, which causes replay
divergence and over-downgrades; change the time anchor to the latest buy
timestamp from recentBuys (e.g., compute latest = Math.max(...recentBuys.map(t
=> t.block_time))) and compute tierSince = latest - tierWindowSeconds instead of
using Date.now(), and when checking tierWallets require at least
getMinWalletsForTier(tier) (not Math.max with threshold) so the tier's own floor
governs the narrow-window validation; keep existing use of scoreForTier(tier)
and the tier fallback sequence (CRITICAL → NOTABLE → WATCH) intact.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

````
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@docs/superpowers/plans/2026-05-06-pnl-leaderboard.md`:
- Around line 87-103: The doc's P&L plan describes token-level netting by
grouping trades per (wallet, token_mint) into aggregate cycles, but the
implementation actually performs FIFO lot matching (see
src/engine/fifo-matcher.ts); update the plan to reflect FIFO behavior or mark
the aggregate-cycle section as superseded. Specifically, replace the "Group by
(wallet, token_mint)" cycle logic and all cycle-based metrics (realized_sol/usd,
wins, win_rate, avg_hold_time_s, locked_sol, n_closed/n_open/n_partial) with a
FIFO-based description that references the FIFO lot matching algorithm in
fifo-matcher.ts (including how partial fills and re-entries are handled) or add
a clear note that the FIFO implementation supersedes the token-level netting
section.

In `@docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md`:
- Line 36: Two unlabeled fenced code blocks should be given a language
identifier to satisfy MD040; change the opening triple-backticks for the block
that begins "for each trade in chronological order:" and for the block that
begins "fix(leaderboard): FIFO inventory matching for accurate per-cycle PnL"
from ``` to ```text so both fenced blocks are labeled and the markdown lint
check passes.

In `@scripts/backfill-usd.ts`:
- Around line 158-171: The unbounded retry in the loop calling
birdEyeClient.getSolUsdAt(unixTime) can hang on persistent
BirdEyeRateLimitError; add a max retry limit (e.g., maxRetries constant) and a
retry counter in the loop, apply the existing wait logic (sleep) on rate-limit
errors but break out and throw a clear error when retries exceed maxRetries,
optionally increasing waitMs (exponential/backoff) between retries; update
references to BirdEyeRateLimitError, getSolUsdAt, sleep and the variable used to
store value/unixTime so the new counter and error path are easily found.

In `@src/__tests__/dexscreener-client.test.ts`:
- Around line 25-28: Update the test so it not only asserts that getTokenPairs
throws DexScreenerRateLimitError on a 429 response but also verifies the parsed
retry-after value: stub fetch to return a Response with status 429 and header
"retry-after": "2", call new DexScreenerClient().getTokenPairs("anymint"), catch
the thrown DexScreenerRateLimitError and assert its retryAfterSeconds (or
equivalent property) equals 2; reference the DexScreenerClient.getTokenPairs
call and DexScreenerRateLimitError type when locating where to add the
additional assertion.

In `@src/execution/jupiter-client.ts`:
- Around line 195-205: The code accepts a Jupiter quote even when quote.inAmount
disagrees with the requested params.amountLamports, which can produce impossible
fill prices; update the execution path (in function using rawAmountToUi /
rawAmountToUi call site) to validate that BigInt(quote.inAmount) ===
params.amountLamports and, if not, reject the quote immediately (throw an error
or return a failure result) instead of only logging a warning; ensure this
validation happens before computing inputAmount or outputAmount and propagate
the rejection so downstream P&L/position sizing logic cannot use mismatched
quote values.

In `@src/execution/risk-engine.ts`:
- Around line 84-90: The code treats null/zero volatility as volAdj = 1,
allowing full size for tokens without volatility data; change the logic in
risk-engine.ts around the
numberConfig(`token:${convergence.token_mint}:realized_vol_24h_pct`) ->
volatility and volAdj calculation so unknown or zero volatility is handled
conservatively: if volatility is null/undefined or <= 0, set volatility to a
conservative fallback (e.g., a high default volatility) or directly set volAdj
to a lower cap (e.g., minVolAdj like 0.2), then use that volAdj when computing
floorApplied and adjustedSizePct; update references to volatility, volAdj,
MIRROR_MIN_PCT, computeMirrorSizePct, floorApplied and adjustedSizePct
accordingly.

---

Duplicate comments:
In `@scripts/leaderboard.ts`:
- Around line 166-180: The query assigned to trades (the RawTrade[] loaded into
trades) currently filters only block_time > cutoff, which omits pre-cutoff
opening lots needed to seed FIFO; modify the WHERE clause in the db.prepare call
(the SQL used to populate trades) to include pre-cutoff buys/lots for
seeding—e.g., change the condition to "WHERE (block_time > ? OR (block_time <= ?
AND trade_type = 'buy')) AND wallet_address IN (SELECT address FROM wallets
WHERE active = 1)" (keep the ORDER BY wallet_address, token_mint, block_time,
id) so sells inside the window can match against inventory opened before cutoff.
Ensure you bind cutoff twice when calling .all(...).
- Around line 128-133: When counting open positions in the loop over
matched.open, detect mixed closed/open mints and increment wallet.n_partial
instead of wallet.n_open; specifically, for each position in matched.open check
if matched.closed.some(c => c.mint === position.mint) and if true do
wallet.n_partial += 1 (else wallet.n_open += 1), still adding
position.locked_sol to wallet.locked_sol—update the loop handling in
scripts/leaderboard.ts to use this mint-existence check so n_partial is
populated for wallets that both closed cycles and keep residual open inventory.

In `@src/blockchain/dexscreener-client.ts`:
- Around line 38-68: The getTokenPairs function currently converts network
timeouts, fetch failures, non-JSON responses, and unexpected statuses into an
empty DexPair[] which hides upstream errors; change the fetch and JSON parsing
error paths to throw distinct errors instead of returning [], e.g. throw a
DexScreenerNetworkError (or similar) from the catch around fetch, throw a
DexScreenerParseError from the catch around response.json(), and throw a
DexScreenerUnexpectedStatusError for unexpected non-OK, non-404 statuses (keep
existing DexScreenerRateLimitError and DexScreenerServerError behavior);
preserve the logger.warn calls but return [] only when response.status === 404
or when the parsed JSON is an actual empty array, so callers can differentiate
“no pairs” from transport/parse failures.

In `@src/engine/convergence.ts`:
- Around line 155-181: validateTierWindow is anchoring windows to Date.now() and
using Math.max(threshold, getMinWalletsForTier(tier)) for the narrow-window
check, which causes replay divergence and over-downgrades; change the time
anchor to the latest buy timestamp from recentBuys (e.g., compute latest =
Math.max(...recentBuys.map(t => t.block_time))) and compute tierSince = latest -
tierWindowSeconds instead of using Date.now(), and when checking tierWallets
require at least getMinWalletsForTier(tier) (not Math.max with threshold) so the
tier's own floor governs the narrow-window validation; keep existing use of
scoreForTier(tier) and the tier fallback sequence (CRITICAL → NOTABLE → WATCH)
intact.

In `@src/engine/fifo-matcher.ts`:
- Around line 49-58: The comparator in sortedTrades forces BUY before SELL for
equal block_time which can create inventory that didn't exist at sell time;
instead preserve original input order for equal-timestamp trades by
stable-sorting using the original index as the tie-breaker: capture the original
index when mapping trades, sort primarily by block_time and secondarily by that
index (not by type), and then restore the trade objects; update references to
sortedTrades/trades and fields block_time and type accordingly so
equal-timestamp BUY/SELL keep their original sequence.

In `@src/engine/scorer.ts`:
- Around line 95-98: computeHoldTimes() and detectWashTrading() are still using
the persisted trades array while buildPositions()/totalTrades incorporate
heliusTxs, causing divergent flags when ingestion lags; change the calls so both
computeHoldTimes(...) and detectWashTrading(...) receive the same unified fills
used by buildPositions/totalTrades (the merged/normalized fills array derived
from heliusTxs + persisted trades) instead of the local persisted trades
variable, and update signatures if needed to accept that unified fills
collection so manipulation scanning runs over the exact dataset used for
P&L/activity.
- Around line 37-84: computeHoldTimes and detectWashTrading currently treat each
BUY/SELL row as indivisible, causing partial sells to incorrectly consume whole
buy lots; modify both functions (computeHoldTimes, detectWashTrading) to track
remaining quantity per queued buy lot (e.g., wrap TradeRow into an object with
remainingQty) and perform FIFO matching using matchedQty = min(buy.remainingQty,
sell.quantityRemaining), decrement both sides, re-queue buys if remainingQty >
0, and only consider a round-trip or push a hold-time for the matchedQty portion
(emit the buy->sell hold time matchedQty times or otherwise weight the
holdTimes/roundTripCount by quantity) so partial fills are matched
proportionally; keep the same WASH_TRADE_WINDOW_SEC and
WASH_TRADE_FRACTION_THRESHOLD logic but compute washCount and roundTripCount
using matched quantities rather than per-row counts.

In `@src/execution/position-auditor.ts`:
- Around line 22-30: The auditor currently only checks pos.tier for WATCH
quarantine and can miss positions whose stored tier is stale but whose backing
convergence tier (pos.conv_tier) is WATCH; update the logic in
position-auditor.ts to treat a position as WATCH if either pos.tier === "WATCH"
or pos.conv_tier === "WATCH" (taking care to not dereference conv_tier when it's
null), and ensure the orphan check (pos.conv_tier === null || pos.wallet_count
=== null) remains correct so you don't consult conv_tier before validating it's
present; modify the WATCH check that references pos.tier to include
pos.conv_tier as described.

In `@src/execution/position-manager.ts`:
- Around line 333-343: The checkDollarStop currently compares only the single
position's unrealized loss to portfolio NAV; change it to compute total
unrealized loss across all open positions (sum of amount_token *
(entry_price_usd - currentPrice) for positions where that value > 0) using your
positions storage or a helper like getOpenPositions(), then compute
(totalUnrealizedLoss / this.portfolioValueUsd()) * 100 and compare to
MAX_DOLLAR_LOSS_PORTFOLIO_PCT; if the threshold is exceeded, call this.exit(...)
as before (or loop and exit all open positions if intended) using the same
parameters, and return true. Reference: checkDollarStop, portfolioValueUsd,
MAX_DOLLAR_LOSS_PORTFOLIO_PCT, exit, PositionRow.
- Around line 75-77: The configure method currently treats wallets as optional
which allows onWhaleSell to bypass the trust gate when this.wallets is null;
update the behavior so whale-sell exits never "fail open": either make wallets
required in configure (throw or assert inside configure if input.wallets is
missing) or add a guard inside onWhaleSell that aborts the whale-sell exit flow
when this.wallets is null and logs/returns an error; reference the configure
method and the onWhaleSell flow in PositionManager and ensure any code paths
that rely on WalletModel (this.wallets) abort early rather than proceeding with
a missing trust-gate.
- Around line 428-437: The helper is too broad and swallows all
SQLITE_CONSTRAINT_* errors; change isSqliteConstraint (used by openPosition) to
only treat UNIQUE violations for the active-position index as ignorable: detect
the error as an object with a string code and either code ===
"SQLITE_CONSTRAINT_UNIQUE" or code === "SQLITE_CONSTRAINT" combined with the
error.message including the specific active-position index name (or the
engine-specific UNIQUE indicator); for any other constraint (NOT NULL, CHECK,
FK, or other SQLITE_CONSTRAINT_*) rethrow the error so callers can surface real
write bugs. Ensure you reference isSqliteConstraint and the openPosition call
path when implementing the stricter check.

In `@src/execution/risk-engine.ts`:
- Around line 152-153: The code swallows errors from
jupiterClient.getPriceUsd(SOL_MINT) and silently returns MIRROR_FALLBACK_PCT;
update the call to capture the error and log a warning when fallback is used
(e.g., change .catch(() => null) to .catch(err => { /* log warning with err and
context */ return null; }) ) and also add a warning log when solPriceUsd is null
or <= 0 before returning MIRROR_FALLBACK_PCT; reference solPriceUsd,
jupiterClient.getPriceUsd, and MIRROR_FALLBACK_PCT and use the existing
risk-engine logger (or processLogger) to include the error and a clear message
that sizing will use the fallback.

In `@src/execution/trade-executor.ts`:
- Around line 187-198: The scaling-to-base-units step uses floating-point math
and can lose precision for large values; fix it by doing the scale/truncate in
string/BigInt space instead of using Number: take the sellAmountToken as a
string (or toString()), split integer and fractional parts, right-pad or
truncate the fractional part to tokenDecimals (from
tokenDecimals(current.token_mint)), concatenate integer+fractional into a
whole-number string, convert that to BigInt and use that as amountLamports (with
a fallback min of 1n); replace the Math.floor/Number.isFinite logic in the
executeSwap call with this string-to-BigInt path so swaps.executeSwap receives
an exact base-unit BigInt for inputMint current.token_mint -> USDC_MINT
conversion.
- Around line 52-58: The current pre-check using
requireDb().prepare(...).get(...) in the existingPosition logic is racy and can
allow two workers to both pass and double-buy; instead, create an atomic
reservation step before calling executeSwap(): insert or upsert a
reservation/position row (e.g., status='RESERVED' or 'IN_PROGRESS') for
convergence.token_mint using a unique constraint inside a DB transaction so only
one worker can claim the mint, then proceed to executeSwap(); on success
transition that reservation to OPEN via
openPosition()/fillExecution()/updatePaperBalance() and on any failure rollback
or mark the reservation as FAILED and release the mint. Ensure the claim uses
the same DB (requireDb()) and unique token_mint constraint so the race is
prevented and always finalized on both success and error paths.

In `@src/storage/database.ts`:
- Around line 38-59: The migration uses a deferred transaction via tx() which
allows a race; change the call at the end of runWalletPnlTrackingMigration to
use tx.immediate() so the transaction acquires a write lock before
probing/ALTERing the schema. In practice, locate runWalletPnlTrackingMigration
where you create const tx = db.transaction(() => { ... }) and replace the final
invocation tx() with tx.immediate() to run the migration in immediate mode and
prevent concurrent ALTER TABLE races.

In `@src/storage/migrations/007_positions_active_unique.sql`:
- Around line 4-6: Existing duplicate active rows will make CREATE UNIQUE INDEX
idx_positions_active_mint fail; add a deterministic dedupe step that runs before
the index creation to remove all but one active row per token_mint (e.g., keep
the row with the greatest id or latest updated_at). Implement this as a single
transactional SQL CTE that deletes from positions where status IN
('OPEN','PARTIAL') and id NOT IN (SELECT MAX(id) FROM positions WHERE status IN
('OPEN','PARTIAL') GROUP BY token_mint) (or use MAX(updated_at) if updated_at
exists), then create the unique index; reference the table positions, column
token_mint, the status filter, and the index name idx_positions_active_mint so
the migration is deterministic and safe on existing data.
````

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

**Run ID**: `df972390-4832-4e0d-9d0d-4cdd3f2b22f8`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and e3b77836fffa38fabd414c2d70927bef10fe9197.

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
* src/utils/retry.ts
* src/frontend/pages/History.tsx
* src/frontend/components/StatusBadge.tsx
* src/jobs/cleanup.ts
* src/frontend/components/ConvergenceCard.tsx
* src/frontend/pages/Settings.tsx
* src/frontend/pages/Wallets.tsx
* src/frontend/hooks/useSSE.ts
* src/jobs/catchup.ts
* .env.example

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
