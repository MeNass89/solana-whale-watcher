# CodeRabbit Review #10 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 16:08:30Z against commit `0a0eac0`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-10-raw.md` (1002 lines).
**Counts:** 8 actionable inline + 12 duplicates (already addressed) + 1 outside-diff.

## Triage

| # | Path | Decision | Reason |
|---|------|----------|--------|
| 1 | `docs/superpowers/plans/2026-05-04-safety-gates-fix.md:476` | APPLY | Hard-coded local path (`/Users/nassimlecornet/...`) and service label leak workstation specifics into the repo. Replace with repo-root commands + `<SERVICE_LABEL>` placeholder. |
| 2 | `src/blockchain/birdeye-client.ts:142-148` | APPLY | `invested = totalBuy > 0 ? totalBuy : 1` synthesizes a fake $1 cost basis so a $100 PnL becomes 10000% — poisons wallet ranking. Return `0` when `totalBuy === 0`. |
| 3 | `src/blockchain/dexscreener-client.ts:44-67` | APPLY | Network/timeout/JSON-parse/unexpected-4xx currently silently return `[]` — caller can't distinguish "no pair" from "outage." Introduce `DexScreenerTransientError` and throw it; coupled with task 7 to fail-closed at risk engine. |
| 4 | `src/blockchain/helius-client.ts:101-111` | APPLY | Pagination loop currently breaks on unhandled 4xx (400/409/422), silently truncating wallet history. Throw `HeliusRequestError` for any 4xx ≠ 404. |
| 5 | `src/execution/jupiter-client.ts:165-167, 195-227` | APPLY | Live path gates impact against `params.slippageBps` (the narrower base), but `getQuote` is built with `exitSlippageBps(params)`. Use the unified cap in both live and paper paths. |
| 6 | `src/execution/jupiter-client.ts:189` (via `rawAmountToUi:343-346`) | APPLY (minimal) | `Number(rawAmount)` silently truncates >2^53. Full Decimal.js conversion = heavy lift (deferred). Minimal fix: throw if `rawAmount > Number.MAX_SAFE_INTEGER` before coercion so the truncation never happens silently. |
| 7 | `src/execution/risk-engine.ts:281-313` | APPLY | `tokenLiquidityLive`/`tokenAgeLive` swallow all provider errors and fall back to stale DB liquidity — defeats the new TVL/age gates exactly when slippage risk is highest. Rethrow rate-limit + transient provider errors so execution fails closed. |
| 8 | `src/execution/trade-executor.ts:82-84` | APPLY | `await risk.checkEntry(...)` is now async (and after task 7 will throw on transient errors) but lives outside the later try/catch — a transient error rejects `onConvergence` outright. Wrap it. |

**Result:** 8 apply, 0 skip.

## Tasks

### Task 1 — `docs/superpowers/plans/2026-05-04-safety-gates-fix.md:466-476` repo-agnostic verification

Replace the local-path/service-label specifics with repo-relative + placeholder commands. Open the file, find the verification fenced block around line 466-476 that contains `cd /Users/nassimlecornet/Projects/solana-whale-watcher` and `launchctl kickstart -k gui/$(id -u)/com.nassim.whale-watcher`. Rewrite to:

```bash
# From repo root:
npm run typecheck
npm test
npm run build

# Restart the long-running service (replace <SERVICE_LABEL> with your local launchctl/systemd label):
launchctl kickstart -k gui/$(id -u)/<SERVICE_LABEL>
```

Also add blank lines around any fenced block flagged by MD031 (around lines 467 and 474).

### Task 2 — `src/blockchain/birdeye-client.ts:142-148` safe PnL%

Locate the `getWalletPnl` (or equivalent) return block where `invested = totalBuy > 0 ? totalBuy : 1` is used to compute `totalPnlPercent`. Replace:

```diff
-      const invested = totalBuy > 0 ? totalBuy : 1;
       return {
         totalPnl,
-        totalPnlPercent: (totalPnl / invested) * 100,
+        totalPnlPercent: totalBuy > 0 ? (totalPnl / totalBuy) * 100 : 0,
         totalBuyAmount: totalBuy,
         totalSellAmount: totalSell
       };
```

If the type allows `null`, prefer `null` over `0` — but only if no downstream consumer breaks on null. Quick grep callers of `birdeyePnlPct`/`totalPnlPercent` before deciding; default to `0` if uncertain.

### Task 3 — `src/blockchain/dexscreener-client.ts` introduce transient error + throw

Add a new error class alongside `DexScreenerRateLimitError`/`DexScreenerServerError`:

```ts
export class DexScreenerTransientError extends Error {
  constructor(public readonly cause: unknown) {
    super(`dexscreener transient failure: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DexScreenerTransientError";
  }
}
```

Update `getTokenPairs` so the three "silent `[]`" branches throw `DexScreenerTransientError` instead:

1. The fetch-itself catch (network/timeout) — currently `logger.warn(...); return [];` — change to `throw new DexScreenerTransientError(error);`
2. The non-ok 4xx branch (`if (!response.ok)`) — currently `logger.warn(...); return [];` — change to `throw new DexScreenerTransientError(new Error(\`unexpected status \${response.status}\`));`
3. The JSON parse catch — currently `logger.warn(...); return [];` — change to `throw new DexScreenerTransientError(error);`

**Keep** the `404 → return []` branch and the `Array.isArray(data) ? data : []` filter — those are legitimate "empty result" cases.

Also export `DexScreenerTransientError`.

### Task 4 — `src/blockchain/helius-client.ts:101-111` throw on unexpected 4xx

Locate the `getWalletTransactions` pagination loop. The current shape:

```ts
if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
  throw new HeliusRequestError(...);
}
logger.warn({ ... }, "getWalletTransactions: non-OK 4xx, stopping pagination");
break;
```

Change to: throw on any 4xx that is not 404, keep `404 → break` as the only "end-of-history" path:

```diff
       if (!response.ok) {
         if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
           throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
         }
-        logger.warn({ address, status: response.status, beforeSignature }, "getWalletTransactions: non-OK 4xx, stopping pagination");
-        break;
+        if (response.status === 404) {
+          logger.warn({ address, status: response.status, beforeSignature }, "getWalletTransactions: wallet not found, stopping pagination");
+          break;
+        }
+        throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
       }
```

### Task 5 — `src/execution/jupiter-client.ts` unify slippage cap

Two sites:

**Site A (live path, line ~165):**

```diff
-    const allowedImpactPct = params.slippageBps != null ? params.slippageBps / 100 : 3;
+    const allowedImpactPct = this.exitSlippageBps(params) / 100;
     if (quote.priceImpactPct && Number(quote.priceImpactPct) > allowedImpactPct) {
       throw new Error(`Price impact ${quote.priceImpactPct}% exceeds ${allowedImpactPct}% limit`);
     }
```

**Site B (paper path, after the `BigInt(quote.inAmount) !== params.amountLamports` reject at ~line 209):**

Add the same priceImpact gate before the existing "insane output amount" sanity check:

```diff
     if (quote && BigInt(quote.inAmount) !== params.amountLamports) {
       throw new Error(
         `jupiter: quote.inAmount (${quote.inAmount}) does not match requested amountLamports (${params.amountLamports.toString()})`
       );
     }
+    if (quote?.priceImpactPct) {
+      const allowedImpactPct = this.exitSlippageBps(params) / 100;
+      if (Number(quote.priceImpactPct) > allowedImpactPct) {
+        throw new Error(`Price impact ${quote.priceImpactPct}% exceeds ${allowedImpactPct}% limit`);
+      }
+    }
     let outputAmount: number;
```

Verify `exitSlippageBps` exists as a `private` method on `JupiterClient` before applying. (It does — used by `freshQuote`/`getQuote`.)

### Task 6 — `src/execution/jupiter-client.ts:343-346` precision precheck in `rawAmountToUi`

Add a hard precheck before `Number(rawAmount)`:

```diff
   private async rawAmountToUi(mint: string, rawAmount: bigint, quoteDecimals?: number): Promise<number> {
+    if (rawAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
+      // Number(bigint) silently truncates above 2^53-1; refuse rather than corrupt P&L.
+      throw new Error(
+        `rawAmountToUi: rawAmount ${rawAmount.toString()} exceeds Number.MAX_SAFE_INTEGER for mint ${mint}`
+      );
+    }
     const decimals = quoteDecimals ?? (await this.tokenDecimals(mint));
     return Number(rawAmount) / 10 ** decimals;
   }
```

This is the minimal fix CodeRabbit explicitly proposes ("validate that `quote.outAmount` never exceeds safe integer bounds before any Number() coercion"). Full Decimal.js migration is deferred.

### Task 7 — `src/execution/risk-engine.ts:281-313` fail-closed on transient provider errors

Modify `tokenLiquidityLive` and `tokenAgeLive` so the catch handlers rethrow rate-limit/transient errors but still fall through on benign nulls.

Top of file: import `BirdEyeRateLimitError` (already imported) and the dexscreener error classes:

```ts
import { BirdEyeRateLimitError, birdEyeClient } from "../blockchain/birdeye-client.js";
import { DexScreenerRateLimitError, DexScreenerServerError, DexScreenerTransientError, dexScreenerClient } from "../blockchain/dexscreener-client.js";
```

(Adjust import paths/names to match the actual existing imports — likely already there for the rate-limit ones.)

Define a small predicate:

```ts
function isTransientProviderError(error: unknown): boolean {
  return (
    error instanceof BirdEyeRateLimitError ||
    error instanceof DexScreenerRateLimitError ||
    error instanceof DexScreenerServerError ||
    error instanceof DexScreenerTransientError
  );
}
```

Update both helpers' `.catch(...)` handlers — rethrow on transient errors, log+null on others:

```diff
   async tokenLiquidityLive(mint: string): Promise<number | null> {
     const overview = await birdEyeClient.getTokenOverview(mint).catch((error) => {
+      if (isTransientProviderError(error)) throw error;
       logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "risk-engine: birdeye unavailable, falling through to dexscreener");
       return null;
     });
     if (overview?.liquidityUsd != null) return overview.liquidityUsd;
     const pair = await dexScreenerClient.getBestPair(mint).catch((error) => {
+      if (isTransientProviderError(error)) throw error;
       logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "risk-engine: dexscreener unavailable, falling back to cached liquidity");
       return null;
     });
     if (pair?.liquidityUsd != null) return pair.liquidityUsd;
     return this.tokenLiquidity(mint);
   }
```

Apply the same pattern to `tokenAgeLive`.

**Verify** that `getBestPair` propagates `DexScreenerTransientError`/rate-limit errors (it should — it just delegates to `getTokenPairs` which task 3 makes throw). If `getBestPair` swallows them, also un-swallow there.

### Task 8 — `src/execution/trade-executor.ts:82-88` wrap `checkEntry`

Wrap `risk.checkEntry` (and ideally the preceding `swaps.getPriceUsd`) in a try/catch. On failure, log + notify ENTRY_FAILED + return cleanly:

```diff
-    const entryPrice = (await this.swaps.getPriceUsd(convergence.token_mint)) ?? initialPrice;
-    const risk = await this.risk.checkEntry(convergence, trades, entryPrice);
+    let entryPrice: number;
+    let risk: Awaited<ReturnType<typeof this.risk.checkEntry>>;
+    try {
+      entryPrice = (await this.swaps.getPriceUsd(convergence.token_mint)) ?? initialPrice;
+      risk = await this.risk.checkEntry(convergence, trades, entryPrice);
+    } catch (error) {
+      logger.error({ err: error instanceof Error ? error : new Error(String(error)), convergenceId: convergence.id }, "execution skipped; risk pre-check failed");
+      await this.notify("ENTRY_REJECTED", convergence, [{ name: "Reason", value: `pre-check error: ${error instanceof Error ? error.message : String(error)}`, inline: false }]);
+      return;
+    }
     if (!risk.allowed || !risk.adjustedSizePct || !risk.sizeUsd) {
```

If the existing notification pipeline uses `ENTRY_FAILED` instead of `ENTRY_REJECTED` for errors, use that. If only `ENTRY_REJECTED` exists, reuse it (the reason field carries the distinction).

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain ≥ 70/70.
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

If a test breaks because it expected silent fallback (e.g. dexscreener-client tests asserting `[]` on network error), update the test to expect a thrown `DexScreenerTransientError` — that's the intended contract change, not a regression.

## Skip / Defer Summary

- Task 6 full Decimal.js conversion: **DEFERRED**. Only the bounds precheck applied to prevent silent truncation. A follow-up plan can migrate `rawAmountToUi` + downstream callers to Decimal.js if/when amounts approach 2^53.

## Stop conditions

- Any task uncovers an unexpected behavioral test failure not explained by the dexscreener contract change → stop and report.
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional, DB-trades-only for MEV/wash detection is intentional, atomic mint-reservation deferred (DB unique index already protects integrity), lots-based partial-fill scorer deferred.
