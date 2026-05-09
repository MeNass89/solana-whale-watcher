# CodeRabbit Review #7 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 15:42:07Z against commit `e3b7783`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-7-raw.md` (838 lines).
**Counts:** 13 actionable inline + 6 duplicates (already addressed).

## Triage

| # | Path | Decision | Reason |
|---|------|----------|--------|
| 1 | `docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md:150-153` | APPLY | Plan-doc fix: don't recommend "ADD COLUMN IF NOT EXISTS" (unsupported in SQLite). Reference `004_wallet_pnl_tracking.sql` and the PRAGMA-based approach instead. |
| 2 | `docs/superpowers/plans/2026-05-06-pnl-leaderboard.md:87-103` | **SKIP** | Historical plan doc; the actual `scripts/leaderboard.ts` already uses `matchFifo` (verified). Doc is stale but cosmetic. |
| 3 | `scripts/leaderboard.ts:128-153` | APPLY | `wallet.n_partial` never incremented. Track `(wallet, mint)` pairs that have both closed cycles AND open inventory; bump `n_partial` for those. |
| 4 | `scripts/start-funnel.sh:14-24` | APPLY | URL_FILE is written before funnel start is confirmed. Move write into the success branch. Truncate on failure (already partially done). |
| 5 | `src/engine/fifo-matcher.ts:49-58` | APPLY | The BUY-before-SELL tie-break I added in review-5 is wrong: it overrides the source's actual same-block ordering and can create artificial inventory. Drop the type tie-breaker, return 0 on equal `block_time` (preserves stable sort). |
| 6 | `src/execution/position-manager.ts:131-138` | APPLY | `isSqliteConstraint` matches any SQLITE_CONSTRAINT_*. Narrow to UNIQUE constraint specifically; rethrow NOT NULL/CHECK/FK violations. |
| 7 | `src/execution/risk-engine.ts:84-90` | APPLY | Volatility null/zero/extreme currently passes through with `volAdj=1`. Hard-fail (size=0) when `volatility == null \|\| <= 0 \|\| > MAX_VOL_PCT` (e.g. 300). |
| 8 | `src/execution/risk-engine.ts:143-156` | APPLY | `computeMirrorSizePct` swallows Jupiter pricing failures with `.catch(() => null)` and silently falls back to `MIRROR_FALLBACK_PCT`. Log at warn with context and rethrow (or let caller handle). |
| 9 | `src/execution/trade-executor.ts:190-193` | APPLY | Float precision still an issue for high-decimal tokens (decimals=18 + balance > ~0.001 → `baseUnitsFloat > 2^53`). Switch to integer/fractional split so the integer part is scaled in BigInt space. |
| 10 | `src/index.ts:99` | APPLY | Startup `setTimeout(leaderboardJob, 90_000)` bypasses the mutex. Use `leaderboardJobGuarded`. |
| 11 | `src/storage/database.ts:39-59` | APPLY | Use `db.transaction(fn).immediate()` (better-sqlite3 syntax) so the migration acquires the write lock before probing schema. Eliminates the residual race on concurrent startups. |
| 12 | `src/storage/migrations/006_co_buyer_index_covering.sql:3-5` | APPLY | Migration runner re-runs every .sql on every startup (no tracking table). Unconditional `DROP INDEX` triggers full index rebuild on every restart. Rename the new index to a distinct name so `CREATE INDEX IF NOT EXISTS` becomes a true no-op after the first run. |
| 13 | `src/storage/migrations/007_positions_active_unique.sql:4-6` | APPLY | Add a defensive cleanup before `CREATE UNIQUE INDEX`: dedupe any pre-existing duplicate `(token_mint, status IN ('OPEN','PARTIAL'))` rows by keeping the highest-id and quarantining the rest, so the migration can't fail. |

**Result:** 12 apply, 1 skip.

## Tasks

### Task 1 — `docs/superpowers/plans/2026-05-06-leaderboard-engine-integration.md:150-153`

Read lines around 145-160. Replace any reference to "ALTER TABLE … ADD COLUMN IF NOT EXISTS" (unsupported SQLite syntax) with a note: "Use the migration runner (`runMigrations`) which applies `004_wallet_pnl_tracking.sql` via the PRAGMA-guarded helper `runWalletPnlTrackingMigration`. If applying manually, check `PRAGMA table_info(wallets)` for column existence first." Keep changes minimal — only fix the incorrect SQL guidance.

### Task 2 — SKIP

Do not modify `2026-05-06-pnl-leaderboard.md`.

### Task 3 — `scripts/leaderboard.ts:128-153` increment `n_partial`

Locate the loop that processes `matched.cycles` and `matched.open`. Build a Set of `(wallet, mint)` keys from `matched.cycles`. Then in the `matched.open` loop, when the pair appears in that Set, increment `wallet.n_partial` in addition to `n_open`/`locked_sol`.

```ts
const partialKeys = new Set<string>();
for (const cycle of matched.cycles) {
  partialKeys.add(`${cycle.wallet}\0${cycle.mint}`);
}
for (const open of matched.open) {
  const wallet = metrics.get(open.wallet) ?? makeEmptyMetrics(open.wallet);
  metrics.set(open.wallet, wallet);
  wallet.n_open += 1;
  wallet.locked_sol += open.locked_sol;
  if (partialKeys.has(`${open.wallet}\0${open.mint}`)) {
    wallet.n_partial += 1;
  }
}
```

Adapt to the existing variable names and helper structures in the file. Read lines 100-160 first.

### Task 4 — `scripts/start-funnel.sh:14-24` write URL only after funnel confirmed

Read the existing flow. Move the `printf "%s\n" "$URL" > "$URL_FILE"` (or equivalent) write so it executes only inside the success branch of `if "$TS_BIN" funnel status …` AND inside the success branch after `"$TS_BIN" funnel --bg 3000` returns 0. On failure paths, truncate the URL_FILE: `: > "$URL_FILE"`. Verify the existing truncate-on-failure logic added in review-4 is preserved.

### Task 5 — `src/engine/fifo-matcher.ts:49-58` drop type tie-breaker

```diff
   const sortedTrades = [...trades].sort((a, b) => {
     if (a.block_time !== b.block_time) return a.block_time - b.block_time;
-    if (a.type === b.type) return 0;
-    return a.type === "BUY" ? -1 : 1;
+    // Same block_time: preserve insertion order (V8 sort is stable). Forcing
+    // BUY before SELL on ties was a false invariant that fabricated inventory
+    // when a SELL legitimately preceded a BUY in the source ordering.
+    return 0;
   });
```

Update the comment block above the sort to reflect the new rationale. Run tests; if any FIFO test depended on the old tie-break it likely had a wrong expectation (verify and fix the test if so).

### Task 6 — `src/execution/position-manager.ts:131-138` narrow constraint check

Locate the catch block around `insert`. Currently it calls a generic `isSqliteConstraint(error)` to handle the active-position UNIQUE collision. Narrow to UNIQUE only:

```diff
     } catch (error) {
-      if (isSqliteConstraint(error)) {
+      // Only the UNIQUE partial index collision (concurrent open of same
+      // mint) is benign. Other constraint failures (NOT NULL, CHECK, FK)
+      // indicate real bugs and must surface.
+      const code = (error as NodeJS.ErrnoException & { code?: string })?.code;
+      const msg = error instanceof Error ? error.message : "";
+      const isUniqueViolation = code === "SQLITE_CONSTRAINT_UNIQUE"
+        || /UNIQUE constraint failed/i.test(msg);
+      if (isUniqueViolation) {
         const existing = this.findOpenByMint(input.tokenMint);
         if (existing) {
           logger.info({ mint: input.tokenMint, positionId: existing.id }, "...");
           return existing;
         }
       }
       throw error;
     }
```

Verify the actual error shape better-sqlite3 produces (the `code` field is set on errors per better-sqlite3 docs). Adapt to whatever signature the existing `isSqliteConstraint` helper uses if any.

### Task 7 — `src/execution/risk-engine.ts:84-90` volatility hard-fail

Locate the volatility lookup and the `volAdj` calculation. Add the gate:

```diff
+const MAX_REASONABLE_VOL_PCT = 300;
+
 // ... inside computeMirrorSizePct ...
   const volatility = numberConfig(`token:${convergence.token_mint}:realized_vol_24h_pct`);
+  // Hard-fail when volatility is unknown or outsized: skip the trade rather
+  // than apply MIRROR_MIN_PCT to an opaque-risk position.
+  if (volatility === null || volatility <= 0 || volatility > MAX_REASONABLE_VOL_PCT) {
+    logger.warn({ mint: convergence.token_mint, volatility }, "risk-engine: volatility unknown or outsized — refusing entry");
+    return 0;
+  }
   const volAdj = Math.min(1, 50 / volatility);
   ...
```

Adapt to the actual function structure (return 0 vs. set adjustedSizePct=0). The intent is "no entry" when volatility signal is missing/extreme.

### Task 8 — `src/execution/risk-engine.ts:143-156` surface Jupiter pricing failure

Locate `computeMirrorSizePct` (or the relevant helper) and find the `.catch(() => null)` on `jupiterClient.getPriceUsd(SOL_MINT)`. Replace:

```diff
-  const solUsd = await jupiterClient.getPriceUsd(SOL_MINT).catch(() => null);
+  let solUsd: number | null;
+  try {
+    solUsd = await jupiterClient.getPriceUsd(SOL_MINT);
+  } catch (error) {
+    logger.warn(
+      { err: error instanceof Error ? error : new Error(String(error)), trades: trades.length, portfolioValueUsd },
+      "risk-engine: SOL/USD pricing failed for mirror sizing"
+    );
+    throw error;
+  }
```

If the caller currently relies on the `null` fallback, adapt: have the caller wrap the call instead. Pick whichever is the smaller diff.

### Task 9 — `src/execution/trade-executor.ts:190-198` integer/fractional BigInt split

Replace the current `(() => { ... })()` IIFE with the safer split:

```diff
         amountLamports: (() => {
-          // Scale to base units before rounding so fractional token exits keep
-          // their value through the conversion.
-          const scale = 10 ** decimals;
-          const baseUnitsFloat = sellAmountToken * scale;
-          if (!Number.isFinite(baseUnitsFloat) || baseUnitsFloat < 1) return 1n;
-          return BigInt(Math.floor(baseUnitsFloat).toString());
+          // Split integer/fractional parts so high-decimal tokens (e.g.
+          // 18-decimal) with large balances don't lose precision via float.
+          // Integer part is scaled entirely in BigInt space; fractional part
+          // (always < 1) safely fits in float for any reasonable scale.
+          if (!Number.isFinite(sellAmountToken) || sellAmountToken <= 0) return 1n;
+          const scale = 10n ** BigInt(decimals);
+          const intPart = BigInt(Math.floor(sellAmountToken));
+          const fracPart = sellAmountToken - Math.floor(sellAmountToken);
+          const fracBaseUnits = BigInt(Math.floor(fracPart * Number(scale)));
+          const total = intPart * scale + fracBaseUnits;
+          return total < 1n ? 1n : total;
         })(),
```

Note: `fracPart * Number(scale)` for decimals=18 → `< 1 * 1e18` ≤ 1e18 which fits in float (< 2^53 ≈ 9e15)... actually 1e18 > 2^53. So precision loss in fractional part for decimals ≥ 16. Acceptable: dust-level imprecision in the fractional part (last ~3 decimal places) is fine for a swap size.

If a test demands exact precision: use a string-based conversion. Default to the split as written.

### Task 10 — `src/index.ts:99` startup uses guarded path

```diff
-  setTimeout(leaderboardJob, 90_000);
+  // Use the guarded path here too so a startup-triggered run can't overlap
+  // with the 06:00 periodic if the timer happens to fire near that window.
+  setTimeout(leaderboardJobGuarded, 90_000);
```

### Task 11 — `src/storage/database.ts:39-59` use immediate transaction

better-sqlite3 syntax: `db.transaction(fn).immediate()` returns a function variant. Apply:

```diff
-  const tx = db.transaction(() => {
+  const tx = db.transaction(() => {
     // ... existing body ...
-  });
+  }).immediate;
+  // .immediate acquires RESERVED lock at BEGIN, preventing two concurrent
+  // startups from both observing the pre-migration schema.
   tx();
```

Wait: `db.transaction(fn)` returns a transaction function that has `.deferred`, `.immediate`, `.exclusive` properties (each a separate function). To call the immediate variant: `tx.immediate()`. Adapt:

```diff
-  const tx = db.transaction(() => { ... });
-  tx();
+  const tx = db.transaction(() => { ... });
+  // Acquire RESERVED lock up-front so two concurrent startups can't both
+  // observe the pre-migration schema.
+  tx.immediate();
```

Verify the better-sqlite3 docs/types in `node_modules/better-sqlite3` if uncertain, but `.immediate()` is the canonical form.

### Task 12 — `src/storage/migrations/006_co_buyer_index_covering.sql` rename to avoid rebuild

Replace the entire content:

```diff
--- Cover wallet_address so SELECT DISTINCT wallet_address can be served
--- entirely from the index.
-DROP INDEX IF EXISTS idx_trades_token_type_time;
-CREATE INDEX IF NOT EXISTS idx_trades_token_type_time
-  ON trades(token_mint, trade_type, block_time, wallet_address);
+-- Cover wallet_address so SELECT DISTINCT wallet_address can be served
+-- entirely from the index.
+--
+-- Rename: the migration runner re-runs every .sql on every startup, so
+-- DROP+CREATE the same name would rebuild the index every restart.
+-- Using a distinct name lets `CREATE INDEX IF NOT EXISTS` short-circuit
+-- after the first run. We also drop the original narrow index (one-time
+-- DROP IF EXISTS is cheap once it's gone).
+DROP INDEX IF EXISTS idx_trades_token_type_time;
+CREATE INDEX IF NOT EXISTS idx_trades_token_type_wallet_time
+  ON trades(token_mint, trade_type, block_time, wallet_address);
```

After this, on the second+ startup: `DROP INDEX IF EXISTS idx_trades_token_type_time` is a no-op (already dropped), `CREATE INDEX IF NOT EXISTS idx_trades_token_type_wallet_time` is a no-op (already exists). No rebuild.

Verify no code references `idx_trades_token_type_time` by name (`grep -rn "idx_trades_token_type_time" src/`). SQLite picks indexes automatically by column patterns, so the rename should be transparent.

### Task 13 — `src/storage/migrations/007_positions_active_unique.sql` defensive cleanup

```diff
--- Ensure at most one OPEN/PARTIAL position per token_mint.
--- Eliminates the SELECT -> openPosition race window that lets two concurrent
--- convergences open duplicate positions on the same mint.
+-- Ensure at most one OPEN/PARTIAL position per token_mint.
+-- Eliminates the SELECT -> openPosition race window that lets two concurrent
+-- convergences open duplicate positions on the same mint.
+--
+-- Defensive cleanup: if any pre-existing duplicates exist (from before this
+-- migration), keep the highest-id row OPEN/PARTIAL and mark the rest CLOSED
+-- with an audit reason. Without this, the unique-index creation fails on
+-- legacy data.
+UPDATE positions
+   SET status = 'CLOSED',
+       exit_reason = COALESCE(exit_reason, '') || ' | AUDIT_DEDUPE: superseded by newer open position',
+       closed_at = COALESCE(closed_at, unixepoch())
+ WHERE id IN (
+   SELECT p.id FROM positions p
+   WHERE p.status IN ('OPEN', 'PARTIAL')
+     AND p.id < (
+       SELECT MAX(p2.id) FROM positions p2
+       WHERE p2.token_mint = p.token_mint AND p2.status IN ('OPEN', 'PARTIAL')
+     )
+ );
+
 CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_active_mint
   ON positions(token_mint)
   WHERE status IN ('OPEN', 'PARTIAL');
```

Verify the `positions` schema actually has `exit_reason` and `closed_at` columns. Adjust column names as needed. If the table uses different audit fields, adapt; the goal is "keep highest-id, close the rest".

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain ≥ 68/68. Watch for: fifo-matcher tests (task 5), risk-engine tests (tasks 7, 8), trade-executor exit tests (task 9).
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

## Skip / Defer Summary

- Task 2: SKIP. Plan-doc `2026-05-06-pnl-leaderboard.md` is historical; actual code already FIFO-matched.

## Stop conditions

- Any task uncovers an unexpected behavioral test failure → stop and report.
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional, DB-trades-only for MEV/wash detection is intentional, atomic mint-reservation deferred (DB unique index already protects integrity).
