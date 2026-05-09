# CodeRabbit Review #11 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 16:33:45Z against commit `baf126a`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-11-raw.md` (707 lines).
**Counts:** 8 actionable inline.

## Triage

| # | Path | Decision | Reason |
|---|------|----------|--------|
| 1 | `docs/superpowers/plans/2026-05-09-coderabbit-review-3.md:24-37` | APPLY | Stale plan-doc — actual code already throws on 401/403 (review-10 task 4 made `helius-client.ts:101-118` throw `HeliusRequestError` on any 4xx ≠ 404). Update the plan text so it stops drifting from reality. |
| 2 | `scripts/start-funnel.sh:21-27` | APPLY | `funnel --bg 3000` returns success before bind is observable. Add a status-grep guard before publishing the URL. |
| 3 | `src/api/routes/webhooks.ts:39-40, 68-76` | APPLY | `block_time < ?` is second-resolution. Same-second prior fills are silently dropped, sellPct collapses to 0 / overshoots. Fix: pass the SELL's `tx_signature` and use `(block_time < ? OR (block_time = ? AND tx_signature != ?))` — excludes the SELL itself if a retry already inserted it, includes other same-second activity. |
| 4 | `src/api/routes/webhooks.ts:68-76` | APPLY | Add migration `008_trades_wallet_token_time_index.sql` with `CREATE INDEX IF NOT EXISTS idx_trades_wallet_token_time ON trades(wallet_address, token_mint, block_time)` so SQLite has a prefix-matching index for `computePreSellBalance`. |
| 5 | `src/engine/convergence.ts:155-181` | APPLY | `validateTierWindow` recomputes `Date.now()`; thread one `nowSeconds` through `checkConvergence` so live and replay use the same evaluation reference. |
| 6 | `src/engine/scorer.ts:37-54` | **SKIP** | Lots-based partial-fill scorer is **deferred** per Nassim's standing instruction. CodeRabbit asks to track per-lot `remaining` like `fifo-matcher.ts` — that's the deferred work. Do not implement. |
| 7 | `src/engine/scorer.ts:91-98` | **SKIP** | Two parts: (a) merge `heliusTxs` into MEV/wash detection — **DB-trades-only is intentional** per Nassim. (b) partial-fill matching — same deferred lots-scorer. Skip both. |
| 8 | `src/jobs/leaderboard-refresh.ts:28-34` | APPLY | Timeout path rejects + clears lock immediately after SIGTERM, but the child can survive ~5s until SIGKILL. A second refresh can race the SQLite file. Hold the lock until `close` actually fires. |

**Result:** 6 apply, 2 skip.

## Tasks

### Task 1 — `docs/superpowers/plans/2026-05-09-coderabbit-review-3.md:24-37` doc fix

Locate the "Fix:" line that says "Throw `HeliusRequestError` on 429 or 5xx; break only for other 4xx". Replace with what the shipped code now does:

```diff
-**Fix:** Throw `HeliusRequestError` on 429 or 5xx; break only for other 4xx (malformed request — pagination should stop, not retry).
+**Fix:** Throw `HeliusRequestError` on 401/403/429/5xx and on any unexpected 4xx. Only `404` is treated as the no-more-data terminal response.
```

That's the only edit needed — pure plan-doc cleanup so CodeRabbit stops re-flagging an obsolete sentence.

### Task 2 — `scripts/start-funnel.sh:21-27` verify funnel bind

Add a post-start status check before publishing the URL:

```diff
   if ! "$TS_BIN" funnel --bg 3000 >> "$LOGFILE" 2>&1; then
     : > "$URL_FILE"
     log "ERROR: failed to start funnel"
     exit 1
   fi
+  if ! "$TS_BIN" funnel status 2>/dev/null | grep -q "127.0.0.1:3000"; then
+    : > "$URL_FILE"
+    log "ERROR: funnel start returned success but bind check failed"
+    exit 1
+  fi
   printf "%s\n" "$URL" > "$URL_FILE"
```

### Task 3 — `src/api/routes/webhooks.ts:39-40, 68-79` tuple cutoff

The current SELL-balance computation excludes only `block_time < ?`, dropping same-second prior trades. Two edits:

**a) Call site (line 39-41):** pass the SELL's `tx_signature`:

```diff
       const preSellBalance = trade.tradeType === "SELL"
-        ? computePreSellBalance(deps.db, trade.walletAddress, trade.tokenMint, trade.blockTime)
+        ? computePreSellBalance(deps.db, trade.walletAddress, trade.tokenMint, trade.blockTime, trade.txSignature)
         : 0;
```

(Verify the field name — likely `txSignature` or `signature` on `ITradeEvent`. If the type uses `signature`, use that.)

**b) Helper signature + SQL (line 68-79):**

```diff
-function computePreSellBalance(db: AppDatabase, walletAddress: string, tokenMint: string, beforeBlockTime: number): number {
+function computePreSellBalance(
+  db: AppDatabase,
+  walletAddress: string,
+  tokenMint: string,
+  beforeBlockTime: number,
+  excludeTxSignature: string
+): number {
   const row = db
     .prepare(
       `SELECT
         COALESCE(SUM(CASE WHEN trade_type = 'BUY' THEN amount_token ELSE 0 END), 0) AS bought,
         COALESCE(SUM(CASE WHEN trade_type = 'SELL' THEN amount_token ELSE 0 END), 0) AS sold
        FROM trades
-       WHERE wallet_address = ? AND token_mint = ? AND block_time < ?`
+       WHERE wallet_address = ?
+         AND token_mint = ?
+         AND (block_time < ? OR (block_time = ? AND tx_signature != ?))`
     )
-    .get(walletAddress, tokenMint, beforeBlockTime) as { bought: number; sold: number };
+    .get(walletAddress, tokenMint, beforeBlockTime, beforeBlockTime, excludeTxSignature) as { bought: number; sold: number };
   return Math.max(0, row.bought - row.sold);
 }
```

Why this shape: at the moment of computation, the current SELL hasn't been inserted yet (line 42 `deps.trades.insert(trade)` happens after). But on an idempotent retry the SELL row may already exist, so excluding by `tx_signature` defends against double-counting. Same-second BUYs/SELLs from other transactions are now correctly included in the pre-sell balance.

### Task 4 — new migration `008_trades_wallet_token_time_index.sql`

Create `src/storage/migrations/008_trades_wallet_token_time_index.sql`:

```sql
-- Idempotent: re-runs on every startup. The existing migrations also lack a tracking
-- table, so guard with IF NOT EXISTS to avoid no-op work and rebuild cost.
CREATE INDEX IF NOT EXISTS idx_trades_wallet_token_time
  ON trades(wallet_address, token_mint, block_time);
```

Verify the migration runner picks up new `.sql` files in this directory (it does — confirmed by 005/006/007 pattern). No test changes needed; this is purely a query-plan optimization.

### Task 5 — `src/engine/convergence.ts` unified `nowSeconds`

Two edits inside this file:

**a) `checkConvergence` (around line 31-90):** capture `nowSeconds` once and pass it to `validateTierWindow`:

```diff
   async checkConvergence(newTrade: ITradeEvent): Promise<ConvergenceRow | null> {
     ...
-    const since = Math.floor(Date.now() / 1000) - windowSeconds;
+    const nowSeconds = Math.floor(Date.now() / 1000);
+    const since = nowSeconds - windowSeconds;
     ...
-    tier = validateTierWindow(tier, score, recentBuys, windowSeconds, threshold);
+    tier = validateTierWindow(tier, score, recentBuys, windowSeconds, threshold, nowSeconds);
     ...
-      tier = validateTierWindow(boosted, scoreForTier(boosted), recentBuys, windowSeconds, threshold);
+      tier = validateTierWindow(boosted, scoreForTier(boosted), recentBuys, windowSeconds, threshold, nowSeconds);
```

**b) `validateTierWindow` signature + body (line 155-181):**

```diff
 function validateTierWindow(
   candidate: ConvergenceTier,
   score: number,
   recentBuys: TradeRow[],
   windowSeconds: number,
-  threshold: number
+  threshold: number,
+  nowSeconds: number
 ): ConvergenceTier {
   ...
-    const tierSince = Math.floor(Date.now() / 1000) - tierWindowSeconds;
+    const tierSince = nowSeconds - tierWindowSeconds;
```

### Task 6 — SKIP

Do not modify `src/engine/scorer.ts:37-54`. Lots-based partial-fill scorer deferred per standing instruction.

### Task 7 — SKIP

Do not modify `src/engine/scorer.ts:91-98`. DB-trades-only for MEV/wash detection is intentional. The partial-fill half is the same deferred lots work.

### Task 8 — `src/jobs/leaderboard-refresh.ts:28-34` hold lock until close

The current timeout path immediately rejects (clearing the lock) but SIGKILL fires 5s later. Fix: track timeout flag, defer rejection to `close`:

```diff
+    let timedOut = false;
+    let killTimer: NodeJS.Timeout | undefined;
     const timeout = setTimeout(() => {
       if (settled) return;
-      settled = true;
+      timedOut = true;
       child.kill("SIGTERM");
-      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
-      reject(new Error(`leaderboard-refresh timed out after ${LEADERBOARD_TIMEOUT_MS}ms`));
+      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
+      killTimer.unref();
     }, LEADERBOARD_TIMEOUT_MS);
     timeout.unref();
 
     child.on("error", (error) => {
       if (settled) return;
       settled = true;
       clearTimeout(timeout);
+      if (killTimer) clearTimeout(killTimer);
       reject(error);
     });
     child.on("close", (code) => {
       if (settled) return;
       settled = true;
       clearTimeout(timeout);
+      if (killTimer) clearTimeout(killTimer);
+      if (timedOut) {
+        reject(new Error(`leaderboard-refresh timed out after ${LEADERBOARD_TIMEOUT_MS}ms`));
+        return;
+      }
       if (code === 0) {
         logger.info({ output: stdout.trim() }, "leaderboard-refresh: job completed");
         resolve();
         return;
       }
       reject(new Error(`leaderboard-refresh exited ${code}: ${stderr.trim()}`));
     });
```

Result: the promise (and thus the `leaderboardRunning` lock in the scheduler caller) only settles when the child is actually gone, regardless of whether it exited via normal close, SIGTERM, or SIGKILL.

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain ≥ 70/70.
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

If any test asserts the old `computePreSellBalance` 4-arg signature, update it to pass a stub signature.

## Skip / Defer Summary

- Task 6 (`scorer.ts:37-54` partial-fill matching): **SKIPPED**. Lots-based partial-fill scorer deferred per Nassim's standing instruction.
- Task 7 (`scorer.ts:91-98` merge heliusTxs into MEV/wash + partial-fill): **SKIPPED**. DB-trades-only is intentional + same deferred lots work.

## Stop conditions

- Any task uncovers an unexpected behavioral test failure not explained by the new `computePreSellBalance` signature → stop and report.
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional, DB-trades-only for MEV/wash detection is intentional, atomic mint-reservation deferred (DB unique index already protects integrity), lots-based partial-fill scorer deferred.
