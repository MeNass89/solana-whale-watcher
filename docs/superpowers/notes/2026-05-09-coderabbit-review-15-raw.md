**Actionable comments posted: 2**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (1)</summary><blockquote>
> 
> <details>
> <summary>src/execution/risk-engine.ts (1)</summary><blockquote>
> 
> `117-165`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **Apply the hard cap before the other size-based gates.**
> 
> `sizeUsd` / `adjustedSizePct` are checked against pool TVL, portfolio exposure, and heat before the `$2k` / `MAX_POSITION_PORTFOLIO_PCT` cap is applied. On large portfolios that can reject a trade using the uncapped theoretical size even though the executed order would be much smaller. Compute `hardCapUsd` / `finalSizeUsd` / `finalSizePct` first, then run the remaining size-based guards against those final values.
> 
>  
> As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/risk-engine.ts` around lines 117 - 165, Compute and apply the
> hard cap before any size-based guards: move calculation of hardCapUsd,
> finalSizeUsd and finalSizePct (using MAX_POSITION_PORTFOLIO_PCT,
> MAX_POSITION_USD and portfolioValueUsd) ahead of the pool-TVl, exposure and
> portfolio-heat checks, then use finalSizeUsd/finalSizePct (not the uncapped
> sizeUsd/adjustedSizePct) in the following guards (the pool TVL check that
> references sizeUsd, the exposure check that adds adjustedSizePct to exposurePct,
> and the portfolioHeatPct comparison). Ensure references to
> sizeUsd/adjustedSizePct in those checks are replaced by
> finalSizeUsd/finalSizePct so the actual executed size is evaluated throughout
> the function (e.g., in the logic surrounding sizeUsd, adjustedSizePct,
> hardCapUsd, finalSizeUsd, finalSizePct, exposurePct, and portfolioHeatPct).
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>♻️ Duplicate comments (16)</summary><blockquote>

<details>
<summary>src/execution/jupiter-client.ts (2)</summary><blockquote>

`349-355`: _⚠️ Potential issue_ | _🔴 Critical_

**The safe-integer guard is still too late for live swaps.**

Lines 188-189 call `rawAmountToUi()` only after the swap is confirmed. If `params.amountLamports` or `quote.outAmount` trips this guard, the on-chain fill succeeded but local execution is recorded as failed, which desynchronizes positions and P&L. Reject unrepresentable amounts immediately after `freshQuote()` and before `buildSwapTransaction()`. As per coding guidelines, "Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/jupiter-client.ts` around lines 349 - 355, The safe-integer
guard in rawAmountToUi is currently applied only after swap confirmation,
risking on-chain success with local failure; add an immediate pre-check right
after freshQuote() and before buildSwapTransaction() to validate any amounts
that will be converted to JS Numbers (specifically params.amountLamports and
quote.outAmount) against Number.MAX_SAFE_INTEGER and reject/throw if they exceed
it. Keep rawAmountToUi as the canonical check but duplicate the validation early
in the execution path (where freshQuote() returns quote and before
buildSwapTransaction() runs) so you never submit or record a swap that will
later be unrepresentable; reference rawAmountToUi, freshQuote,
buildSwapTransaction, params.amountLamports, and quote.outAmount when making the
change.
```

</details>

---

`112-119`: _⚠️ Potential issue_ | _🟠 Major_

**Fallback pricing still rounds large quote amounts before validation.**

`getPriceUsd()` still converts `raw.outAmount` with `Number()` directly, so large raw outputs can lose precision before the sane-price filter runs. When paper execution falls back to `fallbackOutputAmount()`, that rounded price can skew recorded fills. Reuse the bigint bound check here or compute from `BigInt(raw.outAmount)` instead. As per coding guidelines, "Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."



```shell
#!/bin/bash
sed -n '95,120p' src/execution/jupiter-client.ts

python - <<'PY'
safe = 2**53 - 1
for raw in [safe, safe + 2]:
    as_float = float(raw)
    print({
        "raw": raw,
        "after_number_like_coercion": int(as_float),
        "lost_units": raw - int(as_float),
    })
PY
```

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/jupiter-client.ts` around lines 112 - 119, getPriceUsd
currently coerces raw.outAmount to a floating Number which can lose precision
for large quotes; instead parse raw.outAmount with BigInt (e.g.
BigInt(raw.outAmount)), apply the same bigint bounds check used by
fallbackOutputAmount()/other existing bigint guard to reject outs that exceed
safe limits, then compute the price using integer/decimal-safe arithmetic (or a
BigDecimal library) before converting to Number only after the sanity check;
ensure isSanePrice(price) runs after a lossless bigint-based check and that
decimals handling uses the token decimals with integer math; update references
in getPriceUsd to use raw.outAmount as BigInt and mirror fallbackOutputAmount’s
validation logic.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/helius-client.ts (1)</summary><blockquote>

`183-186`: _⚠️ Potential issue_ | _🟠 Major_

**`Retry-After` still loses HTTP-date backoff values.**

This helper only accepts numeric seconds. `Retry-After` can also be sent as an HTTP-date, so some 429s will still surface `retryAfterSeconds = null` and callers lose the provider’s backoff signal. Parse both forms before constructing `HeliusRequestError`. As per coding guidelines, "Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals)."



```shell
#!/bin/bash
sed -n '183,187p' src/blockchain/helius-client.ts

python - <<'PY'
from email.utils import parsedate_to_datetime

header = "Wed, 21 Oct 2015 07:28:00 GMT"
try:
    current = float(header)
except ValueError:
    current = None

print({"current_numeric_only_result": current})
print({"http_date_supported_by_stdlib": parsedate_to_datetime(header).isoformat()})
PY
```

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/helius-client.ts` around lines 183 - 186, parseRetryAfter
currently only parses numeric seconds and ignores HTTP-date values, so update
parseRetryAfter to accept both formats: if header parses as a finite Number
return that, otherwise attempt to parse header as an HTTP-date (use
Date.parse(header)), compute the seconds until that date (ceil((parsedDate -
Date.now())/1000)) and return that if positive, otherwise return null; ensure
callers that construct HeliusRequestError (where retryAfterSeconds is used)
continue to accept the returned number|null and that no other place assumes only
numeric-string headers.
```

</details>

</blockquote></details>
<details>
<summary>docs/superpowers/plans/2026-05-09-coderabbit-review-4.md (2)</summary><blockquote>

`149-176`: _⚠️ Potential issue_ | _🟠 Major_

**Task 7 still bakes in replay-divergent tiering.**

This recipe reintroduces the earlier bug by anchoring the narrow-window check to `Date.now()` and `Math.max(threshold, ...)`. Historical replays will drift over time, and the recheck no longer matches the tier’s own floor. Anchor to the latest buy timestamp and revalidate against `getMinWalletsForTier(tier)` only.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-4.md` around lines 149 -
176, The revalidation loop added after the alpha boost uses Date.now() and
Math.max(threshold, ...) which causes replay divergence and reintroduces the
bug; change the loop in the hasTopAlpha branch to compute tierSince using the
latest buy timestamp (e.g., derive a latestBuyTs from recentBuys or the trade
being considered) instead of Date.now(), and drop the Math.max(threshold, ...)
floor so the check uses only getMinWalletsForTier(tier); keep the same loop
structure and variables (tierWindowSeconds, tierSince, tierWallets, recentBuys,
getMinWalletsForTier) and otherwise preserve the boosted/pickTier logic and
logger call.
```

</details>

---

`291-299`: _⚠️ Potential issue_ | _🟠 Major_

**Guard the startup leaderboard refresh too.**

Line 291 still schedules the startup run outside the mutex. A slow startup refresh can overlap with the guarded 06:00 path because `leaderboardRunning` is never set for that first invocation. Route both entry points through `leaderboardJobGuarded`.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-4.md` around lines 291 -
299, The startup one-shot call uses leaderboardJob directly, which bypasses the
mutex (leaderboardRunning) and can overlap with the guarded 06:00 path; change
the setTimeout caller that currently invokes leaderboardJob to call
leaderboardJobGuarded instead so both entry points (the 90s startup setTimeout
and the hourly setInterval 06:00 branch) go through the same guard and prevent
concurrent runs.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/scorer.ts (2)</summary><blockquote>

`95-98`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**MEV/wash demotion still ignores live `heliusTxs`.**

`buildPositions()` and `totalTrades` fold in Helius swaps, but the demotion signals are computed from persisted `trades` only. During ingestion lag, the same wallet can pass this run and flip on the next one with no new market activity. Run `computeHoldTimes` / `detectWashTrading` on the same unified fills used for P&L/activity.

  
As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 95 - 98, The MEV/wash demotion is computed
from persisted trades only but should use the same unified fills that
buildPositions()/totalTrades use (which already fold in heliusTxs); update the
calls to computeHoldTimes and detectWashTrading to run on the unified fills
collection (the same variable passed into buildPositions/used by
totalTrades/that includes heliusTxs) instead of `trades`, keep using `median()`
and the existing MEV_HOLD_TIME_THRESHOLD_SEC check, and ensure detectWashTrading
receives the merged fills so demotion decisions converge between live and
backtest paths (check functions computeHoldTimes, median, detectWashTrading,
buildPositions, totalTrades, and the heliusTxs merge point to locate the
change).
```

</details>

---

`37-53`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Partial exits still consume whole lots.**

Both helpers drop the entire BUY row on the first matching SELL. A 1-token exit can therefore close a 100-token lot for hold-time and wash-trade purposes, which can falsely demote wallets and diverges from the quantity-aware FIFO P&L path.

  
As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.


Also applies to: 65-84

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/engine/scorer.ts` around lines 37 - 53, computeHoldTimes currently drops
an entire BUY row on the first matching SELL, ignoring quantities; change it to
be quantity-aware by tracking remaining quantity per buy lot (e.g., extend the
buyQueueByMint entries to include remainingQty on each TradeRow or use a small
{row, remaining} tuple), then on a SELL consume FIFO buys decrementing
remainingQty (removing the buy only when remainingQty reaches zero) and for each
unit (or by emitting repeated entries or weighted entries) record the hold time
as sell.block_time - buy.block_time for the quantity actually sold; use the
TradeRow fields trade_type, token_mint, block_time and the numeric quantity
field (e.g., quantity or amount) to implement this and apply the same
quantity-aware logic to the other helper mentioned (lines ~65-84).
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/dexscreener-client.ts (1)</summary><blockquote>

`68-75`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**A 200 schema mismatch still gets downgraded to “no pairs.”**

`!Array.isArray(data)` returns `[]`, so a proxy/WAF/error payload with HTTP 200 is still indistinguishable from a real empty-pairs response. That reintroduces the silent-swallow path this client was meant to remove; throw `DexScreenerTransientError` here instead.

<details>
<summary>🔧 Minimal fix</summary>

```diff
-    if (!Array.isArray(data)) return [];
+    if (!Array.isArray(data)) {
+      logger.warn({ mint, payloadType: typeof data }, "dexscreener: unexpected payload shape");
+      throw new DexScreenerTransientError(new Error("payload was not an array"));
+    }
```
</details>

   

```web
Does DexScreener's `GET /tokens/v1/solana/{tokenAddresses}` endpoint guarantee that successful 200 responses are JSON arrays, and how are unexpected/error payload shapes documented?
```

As per coding guidelines, `src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals).

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/dexscreener-client.ts` around lines 68 - 75, The current code
treats non-array 200 responses as a valid empty result by returning [], which
hides proxy/WAF/error payloads; in the block where you parse response.json()
(the variable data) after the try/catch, replace the Array.isArray(data)
early-return with an explicit throw of DexScreenerTransientError (include
context like mint and the raw data or its type) instead of returning []; ensure
the logger.warn or logger.error logs the unexpected payload shape before
throwing so callers get a transient error rather than silently receiving an
empty pairs list.
```

</details>

</blockquote></details>
<details>
<summary>src/__tests__/convergence-quality-gate.test.ts (1)</summary><blockquote>

`32-56`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**These assertions still don't prove the alpha-boost path ran.**

Both boost tests only check the final tier. If the base convergence logic already reaches `NOTABLE` / `CRITICAL` for these fixtures, the suite stays green even when `hasTopAlpha` stops affecting tiering. Add a control run without the alpha wallet, or assert a boost-specific observable.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/__tests__/convergence-quality-gate.test.ts` around lines 32 - 56, The
tests only assert final tiers so they don't prove the alpha-boost path executed;
rerun a control without the alpha wallet (or remove the alpha-triggering
insertWallet call) and call engine.checkConvergence to assert the base tier is
lower, then re-run with insertWallet("alpha-1", ...) to assert the tier
increases (using engine.checkConvergence and the same newTrade), or
alternatively assert a boost-specific observable returned by checkConvergence
(e.g., a field or reason like convergence.boosted or convergence.reasons
containing "top-alpha"); update the tests around insertWallet, insertBuy, and
engine.checkConvergence to include the control run or the boost-specific
assertion.
```

</details>

</blockquote></details>
<details>
<summary>src/engine/convergence.ts (1)</summary><blockquote>

`35-36`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Tier windowing still depends on wall clock and over-downgrades.**

`since`/`tierSince` are ultimately anchored to `Date.now()`, so replaying an older trade batch produces different `recentBuys` and tier outcomes than live evaluation. On top of that, `Math.max(threshold, getMinWalletsForTier(tier))` still demotes valid narrow-window tiers whenever the global threshold is higher than the tier floor.

<details>
<summary>🔧 Minimal fix</summary>

```diff
-    const nowSeconds = Math.floor(Date.now() / 1000);
+    const nowSeconds = newTrade.blockTime;
...
-    if (tierWallets.size >= Math.max(threshold, getMinWalletsForTier(tier))) return tier;
+    if (tierWallets.size >= getMinWalletsForTier(tier)) return tier;
```
</details>

  
As per coding guidelines, `src/engine/**`: Convergence + scoring. Flag math errors, off-by-one on time windows, and divergent scoring between live and backtest paths.


Also applies to: 156-177

</blockquote></details>
<details>
<summary>src/__tests__/leaderboard-script.test.ts (1)</summary><blockquote>

`18-21`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**This still misses the seeded-inventory regression.**

All seeded trades are `block_time > 0`, and the query still uses `.all(0)`, so this never exercises the `pre-cutoff BUY -> in-window SELL` case that was breaking `realized_sol_30d` / `n_closed_30d`. Add one BUY at-or-before the cutoff for the same `(wallet, mint)` and a SELL after the cutoff, and query with the same cutoff predicate as the production leaderboard path.

  


Also applies to: 23-37

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/__tests__/leaderboard-script.test.ts` around lines 18 - 21, The test is
missing the seeded-inventory regression: add a seeded BUY trade at-or-before the
leaderboard cutoff and a later SELL for the same (wallet, mint) so the
pre-cutoff BUY -> in-window SELL path is exercised; specifically, add an
insertTrade call with block_time <= cutoff (e.g., 0 or the production cutoff
value) for the same "wallet-a","mint-a" and a subsequent SELL with block_time >
cutoff, and update the query that currently uses .all(0) to use the same cutoff
predicate as the production leaderboard path so realized_sol_30d and
n_closed_30d are computed under the correct cutoff logic.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/trade-executor.ts (2)</summary><blockquote>

`52-58`: _⚠️ Potential issue_ | _🔴 Critical_ | _🏗️ Heavy lift_

**The mint dedup is still TOCTOU; two workers can still buy before `openPosition()`.**

This only observes existing `OPEN` / `PARTIAL` rows before the external BUY. Two workers can pass the check, both swaps can execute, and the loser only discovers the conflict when position creation hits the active-position uniqueness guard. By then the second fill and paper-balance mutation are already real. Reserve the mint in the DB before `executeSwap()`, or persist a pending active row and only swap after that succeeds.

  
As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.


Also applies to: 105-146

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/trade-executor.ts` around lines 52 - 58, The current check
using requireDb().prepare(...).get(...) with existingPosition is TOCTOU because
it only inspects OPEN/PARTIAL before executeSwap() — two workers can pass the
check and both perform buys. Fix by persisting a reservation row in positions
(e.g., insert a PENDING or RESERVED row for token_mint) inside a transaction
before calling executeSwap(), or use a DB-level uniqueness constraint and an
atomic INSERT ... WHERE NOT EXISTS pattern to reserve the mint; then only call
executeSwap() after the reservation INSERT succeeds and, on swap success,
transition the row to OPEN (or delete/rollback on failure). Update the code
paths around existingPosition, openPosition(), and executeSwap() to use this
reservation flow so no external swap occurs before the DB has reserved the mint.
```

</details>

---

`181-201`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**`actualSellTokenAmount` still goes through lossy `Number(...)` conversions.**

The swap amount is built in base units as `bigint`, but `fracBaseUnits`, `Number(scale)`, and `Number(amountLamports) / Number(scale)` reintroduce IEEE-754 rounding. For high-decimal tokens that can skew the executed token amount used for `remaining`, `exitPrice`, and realized P&L even though the on-chain swap used the exact bigint value. Keep this path in integer/string space, or hard-fail before any unsafe coercion.

   

```shell
#!/bin/bash
set -euo pipefail

rg -n -C2 'Number\(amountLamports\)|Number\(scale\)|fracBaseUnits|tokenDecimals\(' src/execution/trade-executor.ts

python - <<'PY'
MAX_SAFE = 2**53 - 1
print(f"Number.MAX_SAFE_INTEGER = {MAX_SAFE}")
for decimals in (6, 9, 12, 18):
    max_token_amount = MAX_SAFE / (10 ** decimals)
    print(f"decimals={decimals}: largest token amount that stays exact after Number(baseUnits)/10**decimals ~= {max_token_amount}")
PY
```

As per coding guidelines, `src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/trade-executor.ts` around lines 181 - 201, The code currently
converts bigints to Number (via Number(scale) and Number(amountLamports)) which
reintroduces IEEE-754 rounding; update the path that computes
actualSellTokenAmount to stay in integer/string space: keep using
tokenDecimals()/scale/total/amountLamports as bigint and produce
actualSellTokenAmount as a decimal string (compute integerPart = amountLamports
/ scale and fracPart = amountLamports % scale, pad fracPart to tokenDecimals
length) or else throw if amountLamports exceeds safe bounds; replace any
downstream uses that expect a Number (e.g., remaining, exitPrice, realized P&L
calculations) to accept the bigint or decimal string (or convert using a precise
decimal library) rather than Number to avoid loss of precision.
```

</details>

</blockquote></details>
<details>
<summary>docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md (1)</summary><blockquote>

`89-99`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Pre-cutoff BUY-only seeding still creates phantom inventory.**

This plan/query seeds FIFO with every pre-cutoff BUY but none of the pre-cutoff SELLs, so a wallet that bought and already sold before the window enters with extra lots at cutoff. An in-window SELL can then match against inventory that no longer exists, which corrupts `realized_sol_30d`, `n_closed_30d`, and downstream `wallet_class`. Seed net inventory as of cutoff instead: either feed the full pre-cutoff history into the matcher or materialize opening lots/cost basis at cutoff.

  


Also applies to: 136-145

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md` around lines
89 - 99, The current seeding logic for matchFifo seeds only pre-cutoff BUYs,
creating phantom inventory that lets in-window SELLs match non-existent lots and
corrupt metrics like realized_sol_30d, n_closed_30d, and wallet_class; fix by
seeding net inventory as of the cutoff instead: either feed the matcher the full
pre-cutoff trade history (both BUYS and SELLs) so matchFifo computes true
opening lots, or materialize opening lots/cost basis at cutoff (net lots per
wallet/token) and supply those to matchFifo/unmatched_sells; update the seeding
code paths (the pre-cutoff BUY seeding block and the analogous code referenced
around the second occurrence) to implement one of these approaches so in-window
SELLs only match real pre-window inventory.
```

</details>

</blockquote></details>
<details>
<summary>src/index.ts (1)</summary><blockquote>

`37-44`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Close Fastify before closing SQLite on shutdown.**

Line 40 can close the shared DB while the server from Line 155 is still serving requests, so in-flight webhook ingestion or scheduled writes can fail mid-request. Make `shutdown` async, await `app.close()` first, then stop background work and close the DB.




<details>
<summary>Suggested fix</summary>

```diff
-  const shutdown = (signal: string) => {
+  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
+  const shutdown = async (signal: string) => {
     logger.info(signal);
-    stopRecentTradesCleanup();
-    db.close();
+    await app?.close();
+    stopRecentTradesCleanup();
+    db.close();
     process.exit(0);
   };
-  process.on("SIGTERM", () => shutdown("SIGTERM"));
-  process.on("SIGINT", () => shutdown("SIGINT"));
+  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
+  process.on("SIGINT", () => { void shutdown("SIGINT"); });
…
-  const app = await buildServer({ db, wallets, trades, convergences, engine, alerts });
+  app = await buildServer({ db, wallets, trades, convergences, engine, alerts });
```
</details>


Also applies to: 155-157

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 37 - 44, The shutdown function currently closes
the DB before the Fastify server, risking in-flight requests being interrupted;
make shutdown async, await app.close() first to stop accepting new requests,
then await/stop background workers (stopRecentTradesCleanup), then close the DB
via db.close(), and update the SIGTERM/SIGINT handlers to call the async
shutdown (e.g., use an async wrapper or attach an unhandled promise handler) so
app.close() completes before db.close().
```

</details>

</blockquote></details>
<details>
<summary>src/api/routes/webhooks.ts (1)</summary><blockquote>

`81-85`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**`tx_signature != ?` still treats future same-second fills as prior balance.**

This predicate includes every other row from the same second, regardless of whether it happened before or after the current SELL. If webhook delivery is out of order and a later same-second BUY/SELL is already persisted, `preSellBalance` is wrong and Line 53 sends the wrong `sellPct` into `onWhaleSell(...)`. You still need a true strict ordering key for fills within the second, or a per-request running balance instead of querying “all same-second rows except me”.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/api/routes/webhooks.ts` around lines 81 - 85, The query that computes
preSellBalance in src/api/routes/webhooks.ts is incorrect because using
"tx_signature != ?" still includes same-second fills that happened after the
current SELL; change the ordering predicate to use a strict tie-breaker (e.g.,
add a monotonic per-fill column like fill_sequence or tx_sequence and pass the
current tx's sequence) and update the WHERE to (block_time < ? OR (block_time =
? AND tx_sequence < ?)) so only prior fills are summed; update the DB schema and
any insert code to populate tx_sequence (or use an existing unique incremental
column), and update the call sites that currently pass excludeTxSignature to
instead pass the current tx_sequence (or, alternatively, replace this query with
a per-request running balance calculation before persisting the new fill and use
that result when calling onWhaleSell).
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
In `@src/execution/trade-executor.ts`:
- Around line 98-103: The second live-liquidity call to
risk.tokenLiquidityLive(convergence.token_mint) in onConvergence() must be
removed or made fail-closed: reuse the liquidity value returned by checkEntry()
(the risk check result) when computing slippage via
swaps.slippageBpsForLiquidity(...) so you don't make a new external provider
call after approval, or if you must call tokenLiquidityLive() again wrap it in
the same try/catch/fail-closed logic used in checkEntry() to convert
provider-availability errors into the normal execution-failed/rejection flow;
update onConvergence(), checkEntry(), and the call-site that uses
slippageBpsForLiquidity() to consume the previously fetched liquidityUsd instead
of calling tokenLiquidityLive() a second time.

In `@src/storage/models/wallets.ts`:
- Around line 19-23: New wallet rows are being created with schema defaults that
appear as valid computed values; update insertIfMissing to mark newly created
wallets as uncomputed by explicitly setting wallet_class = 'incomplete' when
inserting, so qualityFor returns an object that convergence.ts (which checks
wallet_class === "incomplete") can recognize; ensure the WalletQuality-related
types/logic still accept this value and that any places that expect the old
default ('unknown') are updated to handle 'incomplete' instead.

---

Outside diff comments:
In `@src/execution/risk-engine.ts`:
- Around line 117-165: Compute and apply the hard cap before any size-based
guards: move calculation of hardCapUsd, finalSizeUsd and finalSizePct (using
MAX_POSITION_PORTFOLIO_PCT, MAX_POSITION_USD and portfolioValueUsd) ahead of the
pool-TVl, exposure and portfolio-heat checks, then use finalSizeUsd/finalSizePct
(not the uncapped sizeUsd/adjustedSizePct) in the following guards (the pool TVL
check that references sizeUsd, the exposure check that adds adjustedSizePct to
exposurePct, and the portfolioHeatPct comparison). Ensure references to
sizeUsd/adjustedSizePct in those checks are replaced by
finalSizeUsd/finalSizePct so the actual executed size is evaluated throughout
the function (e.g., in the logic surrounding sizeUsd, adjustedSizePct,
hardCapUsd, finalSizeUsd, finalSizePct, exposurePct, and portfolioHeatPct).

---

Duplicate comments:
In `@docs/superpowers/plans/2026-05-09-coderabbit-review-4.md`:
- Around line 149-176: The revalidation loop added after the alpha boost uses
Date.now() and Math.max(threshold, ...) which causes replay divergence and
reintroduces the bug; change the loop in the hasTopAlpha branch to compute
tierSince using the latest buy timestamp (e.g., derive a latestBuyTs from
recentBuys or the trade being considered) instead of Date.now(), and drop the
Math.max(threshold, ...) floor so the check uses only
getMinWalletsForTier(tier); keep the same loop structure and variables
(tierWindowSeconds, tierSince, tierWallets, recentBuys, getMinWalletsForTier)
and otherwise preserve the boosted/pickTier logic and logger call.
- Around line 291-299: The startup one-shot call uses leaderboardJob directly,
which bypasses the mutex (leaderboardRunning) and can overlap with the guarded
06:00 path; change the setTimeout caller that currently invokes leaderboardJob
to call leaderboardJobGuarded instead so both entry points (the 90s startup
setTimeout and the hourly setInterval 06:00 branch) go through the same guard
and prevent concurrent runs.

In `@docs/superpowers/plans/2026-05-09-leaderboard-fifo-refactor.md`:
- Around line 89-99: The current seeding logic for matchFifo seeds only
pre-cutoff BUYs, creating phantom inventory that lets in-window SELLs match
non-existent lots and corrupt metrics like realized_sol_30d, n_closed_30d, and
wallet_class; fix by seeding net inventory as of the cutoff instead: either feed
the matcher the full pre-cutoff trade history (both BUYS and SELLs) so matchFifo
computes true opening lots, or materialize opening lots/cost basis at cutoff
(net lots per wallet/token) and supply those to matchFifo/unmatched_sells;
update the seeding code paths (the pre-cutoff BUY seeding block and the
analogous code referenced around the second occurrence) to implement one of
these approaches so in-window SELLs only match real pre-window inventory.

In `@src/__tests__/convergence-quality-gate.test.ts`:
- Around line 32-56: The tests only assert final tiers so they don't prove the
alpha-boost path executed; rerun a control without the alpha wallet (or remove
the alpha-triggering insertWallet call) and call engine.checkConvergence to
assert the base tier is lower, then re-run with insertWallet("alpha-1", ...) to
assert the tier increases (using engine.checkConvergence and the same newTrade),
or alternatively assert a boost-specific observable returned by checkConvergence
(e.g., a field or reason like convergence.boosted or convergence.reasons
containing "top-alpha"); update the tests around insertWallet, insertBuy, and
engine.checkConvergence to include the control run or the boost-specific
assertion.

In `@src/__tests__/leaderboard-script.test.ts`:
- Around line 18-21: The test is missing the seeded-inventory regression: add a
seeded BUY trade at-or-before the leaderboard cutoff and a later SELL for the
same (wallet, mint) so the pre-cutoff BUY -> in-window SELL path is exercised;
specifically, add an insertTrade call with block_time <= cutoff (e.g., 0 or the
production cutoff value) for the same "wallet-a","mint-a" and a subsequent SELL
with block_time > cutoff, and update the query that currently uses .all(0) to
use the same cutoff predicate as the production leaderboard path so
realized_sol_30d and n_closed_30d are computed under the correct cutoff logic.

In `@src/api/routes/webhooks.ts`:
- Around line 81-85: The query that computes preSellBalance in
src/api/routes/webhooks.ts is incorrect because using "tx_signature != ?" still
includes same-second fills that happened after the current SELL; change the
ordering predicate to use a strict tie-breaker (e.g., add a monotonic per-fill
column like fill_sequence or tx_sequence and pass the current tx's sequence) and
update the WHERE to (block_time < ? OR (block_time = ? AND tx_sequence < ?)) so
only prior fills are summed; update the DB schema and any insert code to
populate tx_sequence (or use an existing unique incremental column), and update
the call sites that currently pass excludeTxSignature to instead pass the
current tx_sequence (or, alternatively, replace this query with a per-request
running balance calculation before persisting the new fill and use that result
when calling onWhaleSell).

In `@src/blockchain/dexscreener-client.ts`:
- Around line 68-75: The current code treats non-array 200 responses as a valid
empty result by returning [], which hides proxy/WAF/error payloads; in the block
where you parse response.json() (the variable data) after the try/catch, replace
the Array.isArray(data) early-return with an explicit throw of
DexScreenerTransientError (include context like mint and the raw data or its
type) instead of returning []; ensure the logger.warn or logger.error logs the
unexpected payload shape before throwing so callers get a transient error rather
than silently receiving an empty pairs list.

In `@src/blockchain/helius-client.ts`:
- Around line 183-186: parseRetryAfter currently only parses numeric seconds and
ignores HTTP-date values, so update parseRetryAfter to accept both formats: if
header parses as a finite Number return that, otherwise attempt to parse header
as an HTTP-date (use Date.parse(header)), compute the seconds until that date
(ceil((parsedDate - Date.now())/1000)) and return that if positive, otherwise
return null; ensure callers that construct HeliusRequestError (where
retryAfterSeconds is used) continue to accept the returned number|null and that
no other place assumes only numeric-string headers.

In `@src/engine/scorer.ts`:
- Around line 95-98: The MEV/wash demotion is computed from persisted trades
only but should use the same unified fills that buildPositions()/totalTrades use
(which already fold in heliusTxs); update the calls to computeHoldTimes and
detectWashTrading to run on the unified fills collection (the same variable
passed into buildPositions/used by totalTrades/that includes heliusTxs) instead
of `trades`, keep using `median()` and the existing MEV_HOLD_TIME_THRESHOLD_SEC
check, and ensure detectWashTrading receives the merged fills so demotion
decisions converge between live and backtest paths (check functions
computeHoldTimes, median, detectWashTrading, buildPositions, totalTrades, and
the heliusTxs merge point to locate the change).
- Around line 37-53: computeHoldTimes currently drops an entire BUY row on the
first matching SELL, ignoring quantities; change it to be quantity-aware by
tracking remaining quantity per buy lot (e.g., extend the buyQueueByMint entries
to include remainingQty on each TradeRow or use a small {row, remaining} tuple),
then on a SELL consume FIFO buys decrementing remainingQty (removing the buy
only when remainingQty reaches zero) and for each unit (or by emitting repeated
entries or weighted entries) record the hold time as sell.block_time -
buy.block_time for the quantity actually sold; use the TradeRow fields
trade_type, token_mint, block_time and the numeric quantity field (e.g.,
quantity or amount) to implement this and apply the same quantity-aware logic to
the other helper mentioned (lines ~65-84).

In `@src/execution/jupiter-client.ts`:
- Around line 349-355: The safe-integer guard in rawAmountToUi is currently
applied only after swap confirmation, risking on-chain success with local
failure; add an immediate pre-check right after freshQuote() and before
buildSwapTransaction() to validate any amounts that will be converted to JS
Numbers (specifically params.amountLamports and quote.outAmount) against
Number.MAX_SAFE_INTEGER and reject/throw if they exceed it. Keep rawAmountToUi
as the canonical check but duplicate the validation early in the execution path
(where freshQuote() returns quote and before buildSwapTransaction() runs) so you
never submit or record a swap that will later be unrepresentable; reference
rawAmountToUi, freshQuote, buildSwapTransaction, params.amountLamports, and
quote.outAmount when making the change.
- Around line 112-119: getPriceUsd currently coerces raw.outAmount to a floating
Number which can lose precision for large quotes; instead parse raw.outAmount
with BigInt (e.g. BigInt(raw.outAmount)), apply the same bigint bounds check
used by fallbackOutputAmount()/other existing bigint guard to reject outs that
exceed safe limits, then compute the price using integer/decimal-safe arithmetic
(or a BigDecimal library) before converting to Number only after the sanity
check; ensure isSanePrice(price) runs after a lossless bigint-based check and
that decimals handling uses the token decimals with integer math; update
references in getPriceUsd to use raw.outAmount as BigInt and mirror
fallbackOutputAmount’s validation logic.

In `@src/execution/trade-executor.ts`:
- Around line 52-58: The current check using requireDb().prepare(...).get(...)
with existingPosition is TOCTOU because it only inspects OPEN/PARTIAL before
executeSwap() — two workers can pass the check and both perform buys. Fix by
persisting a reservation row in positions (e.g., insert a PENDING or RESERVED
row for token_mint) inside a transaction before calling executeSwap(), or use a
DB-level uniqueness constraint and an atomic INSERT ... WHERE NOT EXISTS pattern
to reserve the mint; then only call executeSwap() after the reservation INSERT
succeeds and, on swap success, transition the row to OPEN (or delete/rollback on
failure). Update the code paths around existingPosition, openPosition(), and
executeSwap() to use this reservation flow so no external swap occurs before the
DB has reserved the mint.
- Around line 181-201: The code currently converts bigints to Number (via
Number(scale) and Number(amountLamports)) which reintroduces IEEE-754 rounding;
update the path that computes actualSellTokenAmount to stay in integer/string
space: keep using tokenDecimals()/scale/total/amountLamports as bigint and
produce actualSellTokenAmount as a decimal string (compute integerPart =
amountLamports / scale and fracPart = amountLamports % scale, pad fracPart to
tokenDecimals length) or else throw if amountLamports exceeds safe bounds;
replace any downstream uses that expect a Number (e.g., remaining, exitPrice,
realized P&L calculations) to accept the bigint or decimal string (or convert
using a precise decimal library) rather than Number to avoid loss of precision.

In `@src/index.ts`:
- Around line 37-44: The shutdown function currently closes the DB before the
Fastify server, risking in-flight requests being interrupted; make shutdown
async, await app.close() first to stop accepting new requests, then await/stop
background workers (stopRecentTradesCleanup), then close the DB via db.close(),
and update the SIGTERM/SIGINT handlers to call the async shutdown (e.g., use an
async wrapper or attach an unhandled promise handler) so app.close() completes
before db.close().
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

**Run ID**: `f04e61e4-6f61-40cd-b37b-e7e18ebd8b9f`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and 93a6388fa40b3cdfaf10f7332ac2c53f33f93a51.

</details>

<details>
<summary>📒 Files selected for processing (89)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `docs/audit-report.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-10-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-11-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-12-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-13-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-review-14-raw.md`
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

* .env.example
* src/frontend/components/StatusBadge.tsx
* src/frontend/pages/Settings.tsx
* src/frontend/components/WalletTable.tsx
* src/jobs/token-metadata.ts
* src/frontend/pages/History.tsx
* src/frontend/pages/Wallets.tsx
* src/frontend/hooks/useSSE.ts
* src/jobs/cleanup.ts
* src/utils/retry.ts
* src/frontend/components/ConvergenceCard.tsx
* src/jobs/catchup.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
