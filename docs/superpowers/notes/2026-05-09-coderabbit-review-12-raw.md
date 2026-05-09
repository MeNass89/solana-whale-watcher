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
> <summary>src/execution/risk-engine.ts (1)</summary><blockquote>
> 
> `116-164`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **Run the risk gates against the final capped size, not the pre-cap size.**
> 
> `sizeUsd` / `adjustedSizePct` are checked against pool TVL, exposure, and heat before line 160 clamps the order to `finalSizeUsd`. On larger portfolios that can reject entries that would be safe once the 3% / $2k cap is applied, and the returned size no longer matches the size that was actually validated.
> 
> Compute `finalSizeUsd` / `finalSizePct` first, then use those final values for the downstream risk checks.
> 
> As per coding guidelines, "`src/execution/**`: Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/risk-engine.ts` around lines 116 - 164, The risk checks
> currently use the pre-cap size (sizeUsd and adjustedSizePct) causing false
> rejects and mismatches with the returned final size; compute hardCapUsd,
> finalSizeUsd and finalSizePct immediately after sizeUsd is computed (replacing
> where finalSizeUsd/finalSizePct are now set) and then use
> finalSizeUsd/finalSizePct in all downstream checks (pool TVL check using
> finalSizeUsd, exposure check using finalSizePct added to exposurePct from
> openExposurePct, and heat check using finalSizePct) and return adjustedSizePct:
> finalSizePct and sizeUsd: finalSizeUsd so the validated and returned sizes match
> (update references to sizeUsd/adjustedSizePct in the checks to
> finalSizeUsd/finalSizePct).
> ```
> 
> </details>
> 
> </blockquote></details>
> <details>
> <summary>src/execution/position-manager.ts (1)</summary><blockquote>
> 
> `193-214`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **`onWhaleSell` fails open when `wallets` is not configured.**
> 
> When `this.wallets` is `null` (lines 197-203), the quality filter is skipped entirely. Whale sells from wallets classified as `loser` or `accumulation_bot` would trigger exits if the wallets model isn't wired.
> 
> In production this may always be configured, but for defensive execution code, consider either requiring `wallets` or logging/skipping whale-sell behavior when quality data is unavailable.
> 
> 
> <details>
> <summary>🛡️ Proposed fix</summary>
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
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/position-manager.ts` around lines 193 - 214, The onWhaleSell
> handler currently skips wallet-quality checks when this.wallets is null, causing
> trusted-class filters to be bypassed; update onWhaleSell to defensively handle
> missing wallet model (this.wallets) by logging a warning and skipping whale-sell
> exits (early return) or by treating unknown wallets as trusted/untrusted
> consistently — e.g., at start of the wallet-quality block in onWhaleSell, check
> if (!this.wallets) { logger.warn(..., "wallet quality unavailable: skipping
> whale-sell handling"); return; } and keep the existing
> qualityFor/quality.wallet_class logic unchanged (references: onWhaleSell,
> this.wallets, qualityFor, logger).
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
<summary>docs/superpowers/plans/2026-05-09-coderabbit-review-3.md (2)</summary><blockquote>

`26-38`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Don't keep the silent `break` path for auth and unexpected 4xx responses.**

The prose says only `404` is terminal, but the sample code and commit message still make non-429/5xx responses fall through to `break`. Following this plan would reintroduce partial wallet histories on `401`/`403`/other unexpected 4xx instead of surfacing the failure.

  
<details>
<summary>Suggested correction</summary>

```diff
 if (!response.ok) {
-  // Rate-limit / server errors should surface to callers (so wallet-scorer
-  // can log + retry next cycle); 4xx-other means malformed request and
-  // pagination must stop, not throw.
-  if (response.status === 429 || response.status >= 500) {
+  if (response.status === 404) {
+    break;
+  }
+  if (
+    response.status === 401 ||
+    response.status === 403 ||
+    response.status === 429 ||
+    response.status >= 500 ||
+    response.status >= 400
+  ) {
     throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
   }
-  break;
 }
```

```diff
-- helius-client.getWalletTransactions: throw on 429/5xx instead of breaking silently;
-  4xx-other still breaks pagination cleanly
+- helius-client.getWalletTransactions: throw on 401/403/429/5xx and unexpected
+  4xx; only 404 ends pagination cleanly
```
</details>


Also applies to: 195-197

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-3.md` around lines 26 -
38, The sample fetch handling currently uses a silent break for non-429/5xx 4xx
responses which contradicts the plan; update the logic in the
getWalletTransactions/fetch response handling so that any 401, 403, 429, any
5xx, and any unexpected 4xx (i.e., response.status !== 404) throw a
HeliusRequestError with the status and descriptive message instead of falling
through to break, and only treat 404 as the terminal no-more-data case;
reference the response.ok check, response.status and the HeliusRequestError
constructor when making this change.
```

</details>

---

`179-180`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**Make the restart step machine-local.**

`gui/501/com.nassim.whale-watcher` is workstation-specific, so this verification sequence is wrong for any other contributor.

  
<details>
<summary>Suggested correction</summary>

```diff
-4. `launchctl kickstart -k gui/501/com.nassim.whale-watcher` — restart service
-5. Verify PID changed via `launchctl list | grep whale-watcher`
+4. `launchctl kickstart -k gui/$(id -u)/<SERVICE_LABEL>` — restart service
+5. Verify PID changed via `launchctl list | grep <SERVICE_LABEL>`
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-3.md` around lines 179 -
180, The restart and verification steps use a hardcoded user domain
"gui/501/com.nassim.whale-watcher" and "grep whale-watcher", which is
workstation-specific; change the restart to use the current user's GUI domain
(e.g., replace "gui/501" with "gui/$(id -u)" or similar) and verify by matching
the service label "com.nassim.whale-watcher" (e.g., use "launchctl list | grep
com.nassim.whale-watcher" or inspect the PID for that label) so the commands are
machine-local and work for any contributor.
```

</details>

</blockquote></details>
<details>
<summary>docs/superpowers/plans/2026-05-04-safety-gates-fix.md (1)</summary><blockquote>

`368-377`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Use `pos.conv_tier` in the audit sample.**

Line 368 aliases `c.tier` as `conv_tier`, but Line 376 checks `pos.tier`. Copied as written, the sample can miss WATCH-tier quarantines when the position row itself is not WATCH.

  
<details>
<summary>Suggested correction</summary>

```diff
-    if (pos.tier === "WATCH") violations.push("WATCH tier position");
+    if (pos.conv_tier === "WATCH") violations.push("WATCH tier position");
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-04-safety-gates-fix.md` around lines 368 -
377, The audit loop is checking the wrong field for convergence tier: change the
tier check to use the joined alias pos.conv_tier instead of pos.tier so
WATCH-tier convergences are quarantined; locate the loop iterating over
positions (variable positions) that builds AuditResult and replace the
conditional if (pos.tier === "WATCH") with a check against pos.conv_tier in that
same block.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/jupiter-client.ts (2)</summary><blockquote>

`108-117`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Line 109 still does an unsafe string→`Number` cast.**

For cheap 8/9-decimal tokens, a 1 USDC quote can legitimately produce `outAmount` above `Number.MAX_SAFE_INTEGER`. That rounds before the sanity filter runs and feeds wrong fallback prices into paper fills and risk checks. Reject oversized `outAmount` before coercion, or compute this price with bigint/decimal math.

   
<details>
<summary>Suggested correction</summary>

```diff
-      const outAmount = Number(raw.outAmount);
+      const rawOutAmount = BigInt(String(raw.outAmount ?? "0"));
+      if (rawOutAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
+        logger.warn({ mint, outAmount: raw.outAmount }, "getPriceUsd: outAmount exceeds safe integer range");
+        return null;
+      }
+      const outAmount = Number(rawOutAmount);
```
</details>

Run this to verify the overflow threshold for a 1 USDC quote:

```shell
#!/bin/bash
sed -n '103,117p' src/execution/jupiter-client.ts

python3 <<'PY'
MAX_SAFE = 2**53 - 1
for decimals in (6, 9):
    threshold = (10 ** decimals) / MAX_SAFE
    print(f"decimals={decimals} -> prices below about {threshold:.3e} USD overflow a 1 USDC outAmount")
PY
```

Expected result: the script shows the 9-decimal threshold is about `1.11e-07` USD, which is in range for many meme tokens. As per coding guidelines, "Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/jupiter-client.ts` around lines 108 - 117, The code in
getPriceUsd is coercing raw.outAmount directly with Number(raw.outAmount), which
can overflow for high-decimal tokens; instead validate raw.outAmount as a
numeric string/BigInt before casting and reject if it exceeds
Number.MAX_SAFE_INTEGER, or perform the division using bigint/decimal arithmetic
to avoid loss of precision. Concretely: in the getPriceUsd flow, inspect
raw.outAmount (and its type), parse it to BigInt (or a safe decimal library) or
check BigInt(raw.outAmount) <= BigInt(Number.MAX_SAFE_INTEGER) and return null
if too large, or compute price using integer math (price = (10 ** decimals) /
outAmount) with BigInt/decimal and only convert to Number after ensuring it's
within sane bounds; keep existing isSanePrice and logger.warn usage to log and
return null on out-of-range values.
```

</details>

---

`186-190`: _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

**Fail before submitting the live swap if UI conversion will overflow.**

Lines 188-189 call `rawAmountToUi()` only after `sendJitoBundle()` and confirmation. If the new safe-integer guard trips there, `executeSwap()` throws after funds have already moved, which can suppress position recording or trigger retries on an already-executed trade.

   
<details>
<summary>Suggested correction</summary>

```diff
     const quote = await this.freshQuote(params);
+    const inputAmount = await this.rawAmountToUi(params.inputMint, params.amountLamports, quote.inputDecimals);
+    const outputAmount = await this.rawAmountToUi(params.outputMint, BigInt(quote.outAmount), quote.outputDecimals);
     if (BigInt(quote.inAmount) !== params.amountLamports) {
       throw new Error(
         `jupiter: quote.inAmount (${quote.inAmount}) does not match requested amountLamports (${params.amountLamports.toString()})`
@@
     return {
       txSignature: signature,
-      inputAmount: await this.rawAmountToUi(params.inputMint, params.amountLamports, quote.inputDecimals),
-      outputAmount: await this.rawAmountToUi(params.outputMint, BigInt(quote.outAmount), quote.outputDecimals),
+      inputAmount,
+      outputAmount,
       priceImpactPct: Number(quote.priceImpactPct ?? 0),
       executedAt: Math.floor(Date.now() / 1000)
     };
```
</details>

Run this to confirm the guard is currently after confirmation:

```shell
#!/bin/bash
nl -ba src/execution/jupiter-client.ts | sed -n '158,191p'
printf '\n'
nl -ba src/execution/jupiter-client.ts | sed -n '349,357p'
```

Expected result: `waitForConfirmation()` completes before the `rawAmountToUi()` calls that can throw on oversized amounts. As per coding guidelines, "Trade execution path (paper but logic must be production-grade). Flag any code that could corrupt P&L, miscalculate slippage, or double-execute. Watch for token decimals mismatches and lamport-vs-SOL conversion bugs."


Also applies to: 349-357

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/jupiter-client.ts` around lines 186 - 190, The current
executeSwap flow calls rawAmountToUi after sendJitoBundle()/waitForConfirmation
which can throw on integer overflow after funds moved; move the UI conversion
and any safe-integer checks for inputAmount/outputAmount and priceImpactPct to
before sendJitoBundle()/waitForConfirmation so execution fails fast;
specifically, in executeSwap compute/await rawAmountToUi for
params.inputMint/params.amountLamports, params.outputMint/quote.outAmount and
evaluate Number(quote.priceImpactPct ?? 0) and validate they won't overflow
before calling sendJitoBundle or waitForConfirmation, returning or throwing
early if conversion fails.
```

</details>

</blockquote></details>
<details>
<summary>src/blockchain/dexscreener-client.ts (1)</summary><blockquote>

`68-75`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Do not treat a non-array 200 payload as “no pairs.”**

`if (!Array.isArray(data)) return [];` still collapses a schema failure into the same signal as a confirmed empty market. That lets downstream risk logic fall back as if liquidity were absent instead of surfacing a DexScreener contract break.

<details>
<summary>Suggested fix</summary>

```diff
-    if (!Array.isArray(data)) return [];
+    if (!Array.isArray(data)) {
+      logger.warn({ mint, data }, "dexscreener: unexpected success payload shape");
+      throw new DexScreenerTransientError(new Error("unexpected response shape"));
+    }
```
</details>

As per coding guidelines, "`src/blockchain/**`: Solana RPC + DEX clients. Flag missing rate-limit handling, silent error swallowing, and incorrect parsing of token amounts (decimals)."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/blockchain/dexscreener-client.ts` around lines 68 - 75, The code
currently treats a non-array 200 JSON payload as an empty market (`if
(!Array.isArray(data)) return [];`); instead, detect and surface this schema
violation by logging the full payload (use the existing logger.warn with mint
and the parsed data) and throw a specific schema error (e.g.,
DexScreenerSchemaError or a new DexScreenerUnexpectedResponseError) instead of
returning []; update the block around response.json()/data so non-array
responses do not collapse into an empty result and downstream callers can handle
a contract/schema break; keep the existing DexScreenerTransientError for parse
failures only.
```

</details>

</blockquote></details>
<details>
<summary>scripts/backfill-usd.ts (1)</summary><blockquote>

`147-153`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**The SOL/USD cache is still seeded with a trade-specific timestamp.**

You normalized the cache key to 5-minute buckets, but the value stored for a bucket still comes from the *first* trade’s exact `block_time` in that bucket. Later trades reuse that price, so results remain order-dependent within each 5-minute slice. Fetch/store using a canonical bucket timestamp (for example `bucket * 300`) or cache per exact trade time.

  


Also applies to: 175-176

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/backfill-usd.ts` around lines 147 - 153, The cached SOL/USD entry is
stored with the first trade's exact block_time making results order-dependent
within each 5-minute bucket; change the stored timestamp to the canonical bucket
timestamp (bucket * 300) wherever you set unixTime or cache values (e.g., where
unixTime is assigned from trade.block_time and where solUsdCache.set is called
later around the code using bucket and trade.block_time), or alternatively cache
by exact trade time—update both the initial block (around the unixTime
declaration) and the later cache-setting block (lines around 175–176) to use
bucket * 300 instead of trade.block_time.
```

</details>

</blockquote></details>
<details>
<summary>src/index.ts (1)</summary><blockquote>

`37-44`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Close Fastify before closing SQLite.**

`shutdown()` closes `db` and exits while the server can still be serving requests against that handle. A `SIGTERM` during webhook ingestion or execution persistence can fail mid-request and drop the last write. Make shutdown async, await `app?.close()` first, then stop background work and close the DB.  
  

<details>
<summary>Suggested fix</summary>

```diff
 async function main(): Promise<void> {
   const db = openDatabase();
+  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
+  let shuttingDown = false;
   process.removeAllListeners("SIGTERM");
   process.removeAllListeners("SIGINT");
-  const shutdown = (signal: string) => {
+  const shutdown = async (signal: string) => {
+    if (shuttingDown) return;
+    shuttingDown = true;
     logger.info(signal);
-    stopRecentTradesCleanup();
-    db.close();
-    process.exit(0);
+    try {
+      await app?.close();
+    } finally {
+      stopRecentTradesCleanup();
+      db.close();
+      process.exit(0);
+    }
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


Also applies to: 146-148

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 37 - 44, Make shutdown asynchronous and ensure the
Fastify server is closed before stopping background work and closing the SQLite
DB: change the shutdown function (shutdown) to async, await app?.close() first
(handle if app is undefined), then call stopRecentTradesCleanup(), await/ensure
db.close() completes, and only then call process.exit(0); also update the
process.on handlers for "SIGTERM" and "SIGINT" to call the async shutdown (e.g.,
use an async wrapper or call shutdown(...).catch(...)) so the server close and
DB close are awaited and errors are handled.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/position-manager.ts (1)</summary><blockquote>

`340-350`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**`checkDollarStop` only measures single-position loss, not aggregate portfolio drawdown.**

If three positions are each down 2% of NAV, aggregate unrealized loss is 6%, but no single position crosses `MAX_DOLLAR_LOSS_PORTFOLIO_PCT` (3%), so the cap never fires. To enforce total portfolio-level drawdown limits, sum unrealized losses across all `OPEN`/`PARTIAL` positions.


<details>
<summary>🛠️ Proposed fix</summary>

```diff
 private async checkDollarStop(position: PositionRow, priceUsd: number): Promise<boolean> {
-  const unrealizedLoss = position.amount_token * (position.entry_price_usd - priceUsd);
-  if (unrealizedLoss <= 0) return false;
   const portfolioValue = this.portfolioValueUsd();
   if (portfolioValue <= 0) return false;
+  
+  // Aggregate unrealized losses across all open positions
+  const allOpen = this.listOpen();
+  let totalUnrealizedLoss = 0;
+  for (const pos of allOpen) {
+    const posPrice = pos.id === position.id ? priceUsd : (pos.current_price_usd ?? pos.entry_price_usd);
+    const loss = pos.amount_token * (pos.entry_price_usd - posPrice);
+    if (loss > 0) totalUnrealizedLoss += loss;
+  }
+  
-  if ((unrealizedLoss / portfolioValue) * 100 >= MAX_DOLLAR_LOSS_PORTFOLIO_PCT) {
+  if ((totalUnrealizedLoss / portfolioValue) * 100 >= MAX_DOLLAR_LOSS_PORTFOLIO_PCT) {
+    // Exit all positions, or at minimum the current one
     await this.exit(position, "DOLLAR_LOSS_CAP", 100, true);
     return true;
   }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-manager.ts` around lines 340 - 350, checkDollarStop
currently computes unrealized loss only for the single PositionRow passed in;
instead compute aggregate unrealized loss across all positions with status
"OPEN" or "PARTIAL" (iterate your positions collection/filter by status), sum
each position.amount_token * (position.entry_price_usd -
currentPriceForThatPosition) to get totalUnrealizedLoss, then compare
(totalUnrealizedLoss / this.portfolioValueUsd()) * 100 against
MAX_DOLLAR_LOSS_PORTFOLIO_PCT; if exceeded, call this.exit(...) for the relevant
positions (e.g., exit all OPEN/PARTIAL positions or a chosen de-risking subset)
using the same "DOLLAR_LOSS_CAP" reason so the portfolio-level drawdown cap
triggers correctly.
```

</details>

</blockquote></details>
<details>
<summary>src/execution/trade-executor.ts (1)</summary><blockquote>

`197-210`: _⚠️ Potential issue_ | _🟡 Minor_ | _💤 Low value_

**Sub-base-unit partial exits round up to 1 base unit, overselling dust positions.**

When `sellAmountToken` quantizes to `<1` base unit (line 206 `total = 0n`), line 207 forces `sent = 1n`. A 50% partial exit on a 1-base-unit position becomes 100% exit.

Practically rare (positions < 2 base units are near-worthless), but for correctness: cap `sent` to the position's available base units, or no-op when `total === 0n` and `sellPct < 100`.


<details>
<summary>🛡️ Proposed fix</summary>

```diff
         const total = intPart * scale + fracBaseUnits;
-        const sent = total < 1n ? 1n : total;
+        // Only round up to 1 base unit for full closes; partial exits on
+        // sub-base-unit amounts should no-op to avoid overselling.
+        if (total < 1n) return 0n;
+        const sent = total;
         actualSellTokenAmount = Number(sent) / Number(scale);
         return sent;
       })();
+      if (amountLamports === 0n) {
+        logger.debug({ positionId: current.id, sellPct }, "exit skipped: requested amount < 1 base unit");
+        return;
+      }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/trade-executor.ts` around lines 197 - 210, The current
conversion in amountLamports can round tiny fractional sells up to 1 base unit
(sent = 1n), overselling dust positions; change it to (a) compute the desired
base-unit amount as before (total), (b) if total === 0n and the requested sell
percentage is < 100% then treat this as a no-op (set actualSellTokenAmount = 0
and return 0n), and (c) otherwise clamp sent = min(total, availableBaseUnits) so
you never sell more base units than the position has; update
actualSellTokenAmount = Number(sent) / Number(scale). Apply this logic inside
the amountLamports IIFE using the existing symbols sellAmountToken, decimals,
total, sent, actualSellTokenAmount and the position's available base-unit count
(e.g., availableBaseUnits or the variable that holds the position's raw token
units).
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
- Around line 171-179: The current downgrade logic only reduces the assigned
tier by one step and can leave the tier below the required floor (use
getMinWalletsForTier(tier) and uniqueWallets.size); change the logic in the
post-assignment check so it repeatedly demotes tier until uniqueWallets.size >=
getMinWalletsForTier(tier) or tier is "WATCH". Implement a loop around the
existing conditional (using the tier variable and comparisons to "CRITICAL",
"NOTABLE", "WATCH") that performs successive demotions (CRITICAL -> NOTABLE ->
WATCH) until the floor is satisfied.

In `@scripts/backfill-usd.ts`:
- Around line 49-58: nearestCandle() currently picks the closest candle on
either side of the target unixTime (using candidates = [prices[lo], prices[lo -
1]] and Math.abs), which can pick a future candle; change the logic to only
consider candles whose unixTime is <= unixTime (i.e., at or before the trade
time) and choose the latest such candle (max unixTime) within
CANDLE_TOLERANCE_SEC; keep the same guards (return null if none within tolerance
or if value <= 0) and update the selection code that builds and evaluates
candidates instead of using the absolute-distance comparison.

In `@src/blockchain/birdeye-client.ts`:
- Around line 89-103: The getSolUsdAt method currently swallows most request
failures and returns null; instead detect and propagate provider-availability
issues from request() while reserving null for genuine no-data responses. Update
getSolUsdAt (and the similar blocks at the other ranges) to: when request()
throws a typed availability error (e.g., new BirdEyeUnavailableError or a
specific error class returned by request()), rethrow that error so callers can
back off; continue to rethrow BirdEyeRateLimitError as before; only convert
successful responses that lack a numeric value into null. Ensure you reference
and use the existing request() error type (or add/throw a
BirdEyeUnavailableError) rather than treating timeouts, auth failures, or 5xxs
as no-data.

In `@src/blockchain/helius-client.ts`:
- Around line 101-107: Both getWalletTransactions and request currently throw
HeliusRequestError on 429 responses without parsing the Retry-After header;
update both call sites to read response.headers.get('retry-after'), parse it
into seconds (handle numeric seconds and HTTP-date forms by converting to
seconds until that date), and pass that value into the HeliusRequestError
constructor as retryAfterSeconds so callers receive the provider backoff signal
(use HeliusRequestError(response.status, message, retryAfterSeconds)); ensure
this logic is applied in the 429 branches where HeliusRequestError is thrown.

In `@src/engine/scorer.ts`:
- Around line 37-84: computeHoldTimes and detectWashTrading consume whole buy
lots via queue.shift(), ignoring TradeRow.amount_token and breaking FIFO
partial-exit logic; change the buyQueueByMint handling to track remaining
quantity per queued lot (e.g., augment queued items with a remaining field or
decrement TradeRow.amount_token) and when matching a SELL consume only up to
sell.amount_token, reducing the buy lot's remaining and only shift/remove when
it reaches zero, emitting hold times (and counting roundTrip/wash for the
matched quantity) for the matched portion; update computeHoldTimes,
detectWashTrading, and any uses of buyQueueByMint so amounts and partial matches
mirror the FIFO logic in fifo-matcher.ts (referencing computeHoldTimes,
detectWashTrading, buyQueueByMint, TradeRow.amount_token, WASH_TRADE_WINDOW_SEC,
and WASH_TRADE_FRACTION_THRESHOLD).

In `@src/jobs/leaderboard-refresh.ts`:
- Around line 6-12: Replace the child-process spawn flow in
runLeaderboardRefresh with a direct import and call to the extracted function:
move the logic from scripts/leaderboard.ts into an exported function
refreshLeaderboard(db) (or add that wrapper there), then in
runLeaderboardRefresh import refreshLeaderboard and invoke it with the app
DB/context instead of calling spawn(process.execPath, ["--import", "tsx",
"scripts/leaderboard.ts"]), returning its Promise; update any error handling and
stdio expectations to use the function’s returned Promise and logger.

In `@src/storage/migrations/005_co_buyer_index.sql`:
- Around line 5-6: The CREATE INDEX statement for idx_trades_token_type_time in
migration 005_co_buyer_index.sql should be removed (or moved) so startup doesn't
recreate an index that migration 006 immediately drops/replaces; locate the
idx_trades_token_type_time creation in 005_co_buyer_index.sql and delete those
CREATE INDEX IF NOT EXISTS lines (or defer creation to migration 006 where the
covering variant is introduced) to avoid needless rebuilds on boot.

---

Outside diff comments:
In `@src/execution/position-manager.ts`:
- Around line 193-214: The onWhaleSell handler currently skips wallet-quality
checks when this.wallets is null, causing trusted-class filters to be bypassed;
update onWhaleSell to defensively handle missing wallet model (this.wallets) by
logging a warning and skipping whale-sell exits (early return) or by treating
unknown wallets as trusted/untrusted consistently — e.g., at start of the
wallet-quality block in onWhaleSell, check if (!this.wallets) { logger.warn(...,
"wallet quality unavailable: skipping whale-sell handling"); return; } and keep
the existing qualityFor/quality.wallet_class logic unchanged (references:
onWhaleSell, this.wallets, qualityFor, logger).

In `@src/execution/risk-engine.ts`:
- Around line 116-164: The risk checks currently use the pre-cap size (sizeUsd
and adjustedSizePct) causing false rejects and mismatches with the returned
final size; compute hardCapUsd, finalSizeUsd and finalSizePct immediately after
sizeUsd is computed (replacing where finalSizeUsd/finalSizePct are now set) and
then use finalSizeUsd/finalSizePct in all downstream checks (pool TVL check
using finalSizeUsd, exposure check using finalSizePct added to exposurePct from
openExposurePct, and heat check using finalSizePct) and return adjustedSizePct:
finalSizePct and sizeUsd: finalSizeUsd so the validated and returned sizes match
(update references to sizeUsd/adjustedSizePct in the checks to
finalSizeUsd/finalSizePct).

---

Duplicate comments:
In `@docs/superpowers/plans/2026-05-04-safety-gates-fix.md`:
- Around line 368-377: The audit loop is checking the wrong field for
convergence tier: change the tier check to use the joined alias pos.conv_tier
instead of pos.tier so WATCH-tier convergences are quarantined; locate the loop
iterating over positions (variable positions) that builds AuditResult and
replace the conditional if (pos.tier === "WATCH") with a check against
pos.conv_tier in that same block.

In `@docs/superpowers/plans/2026-05-09-coderabbit-review-3.md`:
- Around line 26-38: The sample fetch handling currently uses a silent break for
non-429/5xx 4xx responses which contradicts the plan; update the logic in the
getWalletTransactions/fetch response handling so that any 401, 403, 429, any
5xx, and any unexpected 4xx (i.e., response.status !== 404) throw a
HeliusRequestError with the status and descriptive message instead of falling
through to break, and only treat 404 as the terminal no-more-data case;
reference the response.ok check, response.status and the HeliusRequestError
constructor when making this change.
- Around line 179-180: The restart and verification steps use a hardcoded user
domain "gui/501/com.nassim.whale-watcher" and "grep whale-watcher", which is
workstation-specific; change the restart to use the current user's GUI domain
(e.g., replace "gui/501" with "gui/$(id -u)" or similar) and verify by matching
the service label "com.nassim.whale-watcher" (e.g., use "launchctl list | grep
com.nassim.whale-watcher" or inspect the PID for that label) so the commands are
machine-local and work for any contributor.

In `@scripts/backfill-usd.ts`:
- Around line 147-153: The cached SOL/USD entry is stored with the first trade's
exact block_time making results order-dependent within each 5-minute bucket;
change the stored timestamp to the canonical bucket timestamp (bucket * 300)
wherever you set unixTime or cache values (e.g., where unixTime is assigned from
trade.block_time and where solUsdCache.set is called later around the code using
bucket and trade.block_time), or alternatively cache by exact trade time—update
both the initial block (around the unixTime declaration) and the later
cache-setting block (lines around 175–176) to use bucket * 300 instead of
trade.block_time.

In `@src/blockchain/dexscreener-client.ts`:
- Around line 68-75: The code currently treats a non-array 200 JSON payload as
an empty market (`if (!Array.isArray(data)) return [];`); instead, detect and
surface this schema violation by logging the full payload (use the existing
logger.warn with mint and the parsed data) and throw a specific schema error
(e.g., DexScreenerSchemaError or a new DexScreenerUnexpectedResponseError)
instead of returning []; update the block around response.json()/data so
non-array responses do not collapse into an empty result and downstream callers
can handle a contract/schema break; keep the existing DexScreenerTransientError
for parse failures only.

In `@src/execution/jupiter-client.ts`:
- Around line 108-117: The code in getPriceUsd is coercing raw.outAmount
directly with Number(raw.outAmount), which can overflow for high-decimal tokens;
instead validate raw.outAmount as a numeric string/BigInt before casting and
reject if it exceeds Number.MAX_SAFE_INTEGER, or perform the division using
bigint/decimal arithmetic to avoid loss of precision. Concretely: in the
getPriceUsd flow, inspect raw.outAmount (and its type), parse it to BigInt (or a
safe decimal library) or check BigInt(raw.outAmount) <=
BigInt(Number.MAX_SAFE_INTEGER) and return null if too large, or compute price
using integer math (price = (10 ** decimals) / outAmount) with BigInt/decimal
and only convert to Number after ensuring it's within sane bounds; keep existing
isSanePrice and logger.warn usage to log and return null on out-of-range values.
- Around line 186-190: The current executeSwap flow calls rawAmountToUi after
sendJitoBundle()/waitForConfirmation which can throw on integer overflow after
funds moved; move the UI conversion and any safe-integer checks for
inputAmount/outputAmount and priceImpactPct to before
sendJitoBundle()/waitForConfirmation so execution fails fast; specifically, in
executeSwap compute/await rawAmountToUi for
params.inputMint/params.amountLamports, params.outputMint/quote.outAmount and
evaluate Number(quote.priceImpactPct ?? 0) and validate they won't overflow
before calling sendJitoBundle or waitForConfirmation, returning or throwing
early if conversion fails.

In `@src/execution/position-manager.ts`:
- Around line 340-350: checkDollarStop currently computes unrealized loss only
for the single PositionRow passed in; instead compute aggregate unrealized loss
across all positions with status "OPEN" or "PARTIAL" (iterate your positions
collection/filter by status), sum each position.amount_token *
(position.entry_price_usd - currentPriceForThatPosition) to get
totalUnrealizedLoss, then compare (totalUnrealizedLoss /
this.portfolioValueUsd()) * 100 against MAX_DOLLAR_LOSS_PORTFOLIO_PCT; if
exceeded, call this.exit(...) for the relevant positions (e.g., exit all
OPEN/PARTIAL positions or a chosen de-risking subset) using the same
"DOLLAR_LOSS_CAP" reason so the portfolio-level drawdown cap triggers correctly.

In `@src/execution/trade-executor.ts`:
- Around line 197-210: The current conversion in amountLamports can round tiny
fractional sells up to 1 base unit (sent = 1n), overselling dust positions;
change it to (a) compute the desired base-unit amount as before (total), (b) if
total === 0n and the requested sell percentage is < 100% then treat this as a
no-op (set actualSellTokenAmount = 0 and return 0n), and (c) otherwise clamp
sent = min(total, availableBaseUnits) so you never sell more base units than the
position has; update actualSellTokenAmount = Number(sent) / Number(scale). Apply
this logic inside the amountLamports IIFE using the existing symbols
sellAmountToken, decimals, total, sent, actualSellTokenAmount and the position's
available base-unit count (e.g., availableBaseUnits or the variable that holds
the position's raw token units).

In `@src/index.ts`:
- Around line 37-44: Make shutdown asynchronous and ensure the Fastify server is
closed before stopping background work and closing the SQLite DB: change the
shutdown function (shutdown) to async, await app?.close() first (handle if app
is undefined), then call stopRecentTradesCleanup(), await/ensure db.close()
completes, and only then call process.exit(0); also update the process.on
handlers for "SIGTERM" and "SIGINT" to call the async shutdown (e.g., use an
async wrapper or call shutdown(...).catch(...)) so the server close and DB close
are awaited and errors are handled.
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

**Run ID**: `68972a6e-8cda-4e39-b97c-c059158e03a2`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7ec59cdb545fec9399177105d735e880bf1adbe3 and f3fe741bba66f08a39ababfdaf3d52c77f722ec1.

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

* .env.example
* src/frontend/pages/History.tsx
* src/frontend/pages/Settings.tsx
* src/frontend/components/WalletTable.tsx
* src/jobs/token-metadata.ts
* src/frontend/hooks/useSSE.ts
* src/frontend/pages/Wallets.tsx
* src/utils/retry.ts
* src/frontend/components/ConvergenceCard.tsx
* src/jobs/cleanup.ts
* src/jobs/catchup.ts
* src/frontend/components/StatusBadge.tsx

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
