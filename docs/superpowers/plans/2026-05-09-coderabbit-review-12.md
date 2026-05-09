# CodeRabbit Review #12 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 16:49:25Z against commit `f3fe741`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-12-raw.md`.
**Counts:** 7 actionable inline.

## Triage

| # | Path | Decision | Reason |
|---|------|----------|--------|
| 1 | `docs/superpowers/plans/2026-05-04-safety-gates-fix.md:171-179` | APPLY | Plan snippet only demotes one tier level; could leave CRITICAL→NOTABLE while still violating NOTABLE floor. Replace with `while` loop. Pure doc fix. |
| 2 | `scripts/backfill-usd.ts:38-58` | APPLY | `nearestCandle()` picks closest candle on either side, can return *future* price for trades late in a 5-min window — leaks post-trade movement into recorded P&L. Use latest candle ≤ unixTime within tolerance. |
| 3 | `src/blockchain/birdeye-client.ts:89-103, 106-126, 129-155, 158-176` | APPLY | Caller paths only rethrow `BirdEyeRateLimitError`; timeouts/auth/5xx still collapse to `null`, so risk + scoring fall back as if BirdEye answered "no data." Mirror the dexscreener fix from review-10: introduce `BirdEyeUnavailableError`, throw it from `request()` on transient failures, only `null` on genuine no-data. |
| 4 | `src/blockchain/helius-client.ts:101-115, 158-160` | APPLY | `HeliusRequestError` carries `retryAfterSeconds` (added in review-9 task 6 for `getAsset`) but `getWalletTransactions` and `request()` still throw without populating it. Parse `retry-after` at all throw sites. |
| 5 | `src/engine/scorer.ts:37-84` | **SKIP** | CodeRabbit itself classifies this as `🧹 Nitpick / 🔵 Trivial / ⚖️ Poor tradeoff` and notes "the impact may be acceptable." Plus standing instruction: lots-based partial-fill scorer is **deferred**. |
| 6 | `src/jobs/leaderboard-refresh.ts:6-12` | APPLY | **Critical.** `tsx` is in `devDependencies` only. The spawn `node --import tsx scripts/leaderboard.ts` will fail in production where `tsx` is absent. Extract `scripts/leaderboard.ts` `main()` body into an exported `refreshLeaderboard({ applyPrune })` function and call it directly. |
| 7 | `src/storage/migrations/005_co_buyer_index.sql:5-6` | APPLY | Migration runner re-runs every `.sql` on every startup. 005 creates `idx_trades_token_type_time`; 006 then drops + recreates it as the covering variant. Every boot does the wasted CREATE→DROP cycle. Remove the CREATE from 005 (006 handles fresh DBs). |

**Result:** 6 apply, 1 skip.

## Tasks

### Task 1 — `docs/superpowers/plans/2026-05-04-safety-gates-fix.md:171-179` loop until floor satisfied

Find the snippet that demotes a tier once. Replace with a `while` loop that demotes until the floor is satisfied or `tier === "WATCH"`:

```diff
-if (uniqueWallets.size < getMinWalletsForTier(tier)) {
-  if (tier === "CRITICAL") tier = "NOTABLE";
-  else if (tier === "NOTABLE") tier = "WATCH";
-  // WATCH stays WATCH — won't be executed anyway
-}
+while (uniqueWallets.size < getMinWalletsForTier(tier) && tier !== "WATCH") {
+  tier = tier === "CRITICAL" ? "NOTABLE" : "WATCH";
+}
```

Pure doc edit; no code in the repo follows this exact snippet (the live `validateTierWindow` already loops). Match the surrounding markdown indentation/fence style.

### Task 2 — `scripts/backfill-usd.ts:38-58` strict-past `nearestCandle`

Rewrite `nearestCandle` to only consider candles with `unixTime <= target`, and pick the *latest* such candle, still bounded by `CANDLE_TOLERANCE_SEC`.

```diff
 function nearestCandle(prices: HistoricalPrice[], unixTime: number): HistoricalPrice | null {
   if (prices.length === 0) return null;

   let lo = 0;
   let hi = prices.length - 1;
   while (lo < hi) {
-    const mid = Math.floor((lo + hi) / 2);
-    if (prices[mid].unixTime < unixTime) lo = mid + 1;
-    else hi = mid;
+    // Find the smallest index whose unixTime > target so prices[lo - 1] is the
+    // last candle at-or-before the trade.
+    const mid = Math.floor((lo + hi) / 2);
+    if (prices[mid].unixTime <= unixTime) lo = mid + 1;
+    else hi = mid;
   }
-
-  const candidates = [prices[lo], prices[lo - 1]].filter(Boolean) as HistoricalPrice[];
-  let best: HistoricalPrice | null = null;
-  for (const candidate of candidates) {
-    if (!best || Math.abs(candidate.unixTime - unixTime) < Math.abs(best.unixTime - unixTime)) {
-      best = candidate;
-    }
-  }
-
-  if (!best || Math.abs(best.unixTime - unixTime) > CANDLE_TOLERANCE_SEC) return null;
-  return best.value > 0 ? best : null;
+  // After the loop, prices[lo] is the first candle strictly after unixTime
+  // (or the boundary). The candle at prices[lo - 1] (if any) is the latest
+  // candle at-or-before unixTime — the only safe choice for past-only pricing.
+  const candidate = lo > 0 && prices[lo - 1].unixTime <= unixTime
+    ? prices[lo - 1]
+    : (prices[lo]?.unixTime === unixTime ? prices[lo] : null);
+  if (!candidate) return null;
+  if (unixTime - candidate.unixTime > CANDLE_TOLERANCE_SEC) return null;
+  return candidate.value > 0 ? candidate : null;
 }
```

The binary search now finds the first index strictly after `unixTime`. The strictly-past candidate is `prices[lo - 1]` when it exists. The tolerance check becomes one-sided (`unixTime - candidate.unixTime`) since we never look forward.

If a regression test exists (`backfill-usd.test.ts` or similar) that asserts forward-looking nearest-match, update it to expect the past-only behaviour.

### Task 3 — `src/blockchain/birdeye-client.ts` typed transient error

**a)** Add a new error class next to `BirdEyeRateLimitError`:

```ts
export class BirdEyeUnavailableError extends Error {
  constructor(public readonly status: number | null, public readonly cause: unknown) {
    super(`BirdEye unavailable${status != null ? ` (${status})` : ""}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "BirdEyeUnavailableError";
  }
}
```

**b)** Update `request()` (lines 158-176) to throw `BirdEyeUnavailableError` on transports + 5xx + auth + parse failures. Currently:

```diff
   private async request(path: string): Promise<any> {
-    const response = await fetch(`${BIRDEYE_BASE}${path}`, {
-      signal: AbortSignal.timeout(BIRDEYE_FETCH_TIMEOUT_MS),
-      headers: { "x-chain": "solana", "X-API-KEY": this.apiKey }
-    });
+    let response: Response;
+    try {
+      response = await fetch(`${BIRDEYE_BASE}${path}`, {
+        signal: AbortSignal.timeout(BIRDEYE_FETCH_TIMEOUT_MS),
+        headers: { "x-chain": "solana", "X-API-KEY": this.apiKey }
+      });
+    } catch (error) {
+      throw new BirdEyeUnavailableError(null, error);
+    }
     if (response.status === 429) {
       const header = response.headers.get("retry-after");
       const retryAfter = header && Number.isFinite(Number(header)) ? Number(header) : null;
       throw new BirdEyeRateLimitError(retryAfter);
     }
-    if (!response.ok) throw new Error(`BirdEye ${response.status}: ${await response.text()}`);
-    const json = (await response.json()) as { success: boolean; data?: any };
-    if (!json.success) throw new Error("BirdEye request unsuccessful");
+    if (response.status === 401 || response.status === 403 || response.status >= 500) {
+      throw new BirdEyeUnavailableError(response.status, new Error(await response.text()));
+    }
+    if (!response.ok) {
+      throw new BirdEyeUnavailableError(response.status, new Error(await response.text()));
+    }
+    let json: { success: boolean; data?: any };
+    try {
+      json = (await response.json()) as { success: boolean; data?: any };
+    } catch (error) {
+      throw new BirdEyeUnavailableError(response.status, error);
+    }
+    if (!json.success) {
+      throw new BirdEyeUnavailableError(response.status, new Error("BirdEye request unsuccessful"));
+    }
     return json.data ?? null;
   }
```

**c)** Update the three caller catch blocks (`getSolUsdAt`, `getTokenOverview`, `getWalletPnl`) to also rethrow `BirdEyeUnavailableError` alongside `BirdEyeRateLimitError`:

```diff
     } catch (error) {
-      if (error instanceof BirdEyeRateLimitError) throw error;
+      if (error instanceof BirdEyeRateLimitError || error instanceof BirdEyeUnavailableError) throw error;
       logger.warn(...);
       return null;
     }
```

**d)** Update `src/execution/risk-engine.ts` `isTransientProviderError` predicate (added in review-10 task 7) to include `BirdEyeUnavailableError`:

```diff
 function isTransientProviderError(error: unknown): boolean {
   return (
     error instanceof BirdEyeRateLimitError ||
+    error instanceof BirdEyeUnavailableError ||
     error instanceof DexScreenerRateLimitError ||
     error instanceof DexScreenerServerError ||
     error instanceof DexScreenerTransientError
   );
 }
```

Add the import for `BirdEyeUnavailableError` at the top of `risk-engine.ts` (alongside `BirdEyeRateLimitError`).

### Task 4 — `src/blockchain/helius-client.ts` populate retryAfter at all 429 throw sites

Three sites still throw without retryAfter:

**Site A — `getWalletTransactions` (line 107):**

```diff
         if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
-          throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
+          throw new HeliusRequestError(
+            response.status,
+            `Helius getWalletTransactions failed (${response.status})`,
+            parseRetryAfter(response.headers.get("retry-after"))
+          );
         }
```

**Site B — same function, "any other 4xx" (line 113):**

```diff
-        throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
+        throw new HeliusRequestError(
+          response.status,
+          `Helius getWalletTransactions failed (${response.status})`,
+          parseRetryAfter(response.headers.get("retry-after"))
+        );
```

**Site C — `request()` (line 160):**

```diff
-      throw new HeliusRequestError(response.status, `Helius request failed (${response.status}): ${body}`);
+      throw new HeliusRequestError(
+        response.status,
+        `Helius request failed (${response.status}): ${body}`,
+        parseRetryAfter(response.headers.get("retry-after"))
+      );
```

`parseRetryAfter` already exists at line 171. Reuse it.

### Task 5 — SKIP

Do not modify `src/engine/scorer.ts:37-84`. Lots-based partial-fill scorer deferred per standing instruction; CodeRabbit's own classification is "Nitpick / Trivial / Poor tradeoff."

### Task 6 — `src/jobs/leaderboard-refresh.ts` extract `refreshLeaderboard()` instead of spawning tsx

This is the largest task. Two files change:

**a) `scripts/leaderboard.ts`** — extract the `main()` body into an exported `refreshLeaderboard()` function. Keep the CLI entrypoint at the end:

```diff
 export interface WalletMetricsResult { ... }

+export interface RefreshLeaderboardOptions {
+  applyPrune?: boolean;
+}
+
+export function refreshLeaderboard(options: RefreshLeaderboardOptions = {}): void {
+  const applyPrune = options.applyPrune ?? false;
+  const generatedAt = Math.floor(Date.now() / 1000);
+  const cutoff = generatedAt - WINDOW_SEC;
+
+  const db = new DatabaseConstructor(DB_PATH);
+  db.pragma("journal_mode = WAL");
+  db.pragma("busy_timeout = 5000");
+
+  // ...everything currently inside main() from the activeWallets query
+  // through db.close()...
+
+  db.close();
+}
+
-function main(): void {
-  const applyPrune = process.argv.includes("--apply-prune");
-  ...full body...
-}
+function main(): void {
+  const applyPrune = process.argv.includes("--apply-prune");
+  refreshLeaderboard({ applyPrune });
+}

 if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
   main();
 }
```

The function body is identical to the current `main()` body — just lifted, with `applyPrune` taken from the options arg instead of argv. The CLI entry now delegates to the function.

**b) `src/jobs/leaderboard-refresh.ts`** — replace spawn with direct call:

```diff
-import { spawn } from "node:child_process";
 import { logger } from "../utils/logger.js";
+import { refreshLeaderboard } from "../../scripts/leaderboard.js";

 const LEADERBOARD_TIMEOUT_MS = 10 * 60 * 1000;

 export function runLeaderboardRefresh(): Promise<void> {
   return new Promise((resolve, reject) => {
-    // The leaderboard is currently a CLI script; spawning keeps scheduler wiring small and avoids a broad extraction.
-    const child = spawn(process.execPath, ["--import", "tsx", "scripts/leaderboard.ts"], {
-      cwd: process.cwd(),
-      stdio: ["ignore", "pipe", "pipe"]
-    });
-    ...all the spawn plumbing...
+    const timer = setTimeout(() => {
+      reject(new Error(`leaderboard-refresh timed out after ${LEADERBOARD_TIMEOUT_MS}ms`));
+    }, LEADERBOARD_TIMEOUT_MS);
+    timer.unref();
+    try {
+      refreshLeaderboard();
+      clearTimeout(timer);
+      logger.info("leaderboard-refresh: job completed");
+      resolve();
+    } catch (error) {
+      clearTimeout(timer);
+      reject(error instanceof Error ? error : new Error(String(error)));
+    }
   });
 }
```

`refreshLeaderboard()` is synchronous (better-sqlite3 is sync), so the timer-based timeout serves only as a defensive guard against pathologically large datasets blocking the event loop. If the function is too tight to get pre-empted, the timeout becomes a no-op — that's acceptable; tsx-spawn was the only reason for SIGTERM/SIGKILL plumbing, and we no longer need it.

**Import path note:** verify the relative import works. From `src/jobs/leaderboard-refresh.ts` to `scripts/leaderboard.ts`, the path is `../../scripts/leaderboard.js` (with `.js` extension to satisfy ESM resolution after compile). If TypeScript's `tsconfig.json` excludes `scripts/` from compilation, the import won't resolve at runtime — in that case the fallback is to **move** the function body to `src/jobs/leaderboard-runner.ts` and have both `scripts/leaderboard.ts` and `leaderboard-refresh.ts` import from there.

Quick check before applying: `grep -n include tsconfig.json` and `grep -n exclude tsconfig.json`. If `scripts` is excluded from `include`, take the move-to-src path.

### Task 7 — `src/storage/migrations/005_co_buyer_index.sql` remove redundant CREATE

Migration 006 already drops `idx_trades_token_type_time` and creates the covering replacement. On every startup, 005 recreates the index just so 006 can drop it again — wasted I/O on the hot `trades` table.

Replace 005's content with a comment-only file:

```diff
-- Composite index for the co-buyer scanner SELECT DISTINCT wallet_address
-- WHERE token_mint = ? AND trade_type = 'BUY' AND block_time BETWEEN ? AND ?.
-- Without this, the scan falls back to a per-token-mint range scan that
-- re-reads every trade row in the window.
-CREATE INDEX IF NOT EXISTS idx_trades_token_type_time
-  ON trades(token_mint, trade_type, block_time);
+-- Superseded by 006_co_buyer_index_covering.sql: the covering variant
+-- idx_trades_token_type_wallet_time replaces this index and serves the
+-- co-buyer scanner directly from the index. Keeping this file as a no-op
+-- comment preserves the migration ordering for any environment that already
+-- ran the original CREATE; migration 006 issues DROP IF EXISTS to clean up.
```

Verify the migration runner accepts a file with only comments (it should — sqlite `exec` on whitespace/comments is a no-op). If it errors on empty statements, the file can also be deleted entirely; check by running `npm test` after applying.

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain ≥ 70/70.
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

## Skip / Defer Summary

- Task 5 (`scorer.ts:37-84` partial-fill matching): **SKIPPED**. Lots-based partial-fill scorer deferred per Nassim's standing instruction. CodeRabbit's own classification: `🧹 Nitpick / 🔵 Trivial / ⚖️ Poor tradeoff`.

## Stop conditions

- Task 6 import path resolution (`../../scripts/leaderboard.js`) failing → fall back to moving the function body into `src/jobs/leaderboard-runner.ts`.
- Migration 005 empty/comment-only file rejected by SQLite runner → delete the file entirely (006 already handles fresh DBs).
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional, DB-trades-only for MEV/wash detection is intentional, atomic mint-reservation deferred (DB unique index already protects integrity), lots-based partial-fill scorer deferred.
