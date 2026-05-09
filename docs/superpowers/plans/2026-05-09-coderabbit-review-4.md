# CodeRabbit Review #4 — Codex Execution Plan

**Source review:** PR #1, submitted 2026-05-09T15:12:05Z (9 actionable + 9 prompt-only).
**Base of review:** commit 5a1df96 (predates 4d8f5ce). Re-verified each finding against HEAD = 4d8f5ce.
**Goal:** Apply 13 valid findings, defer 1 heavy-lift, keep prior decisions intact.

## Triage

| # | Location | Severity | Status | Reason |
|---|----------|----------|--------|--------|
| 1 | `transaction-parser.ts:71-95` | Major / Heavy lift | **DEFER** | Multi-token swap SOL split is a real bug but requires routing-aware parser. Out of cleanup-loop scope. |
| 2 | `jupiter-client.ts:118-120` getPriceUsd | Major | **APPLY** | Bare `catch {}` swallows errors |
| 3 | `helius-client.ts:96-105` getWalletTransactions | Major | **APPLY** | 4xx-other (post-4d8f5ce) still silently breaks |
| 4 | `trade-executor.ts:107-124` BUY phantom | **CRITICAL** | **APPLY** | BUY accepts `outputAmount<=0`, opens NaN position |
| 5 | `trade-executor.ts:177-182` BigInt | Major | **APPLY** | IEEE-754 mul before BigInt cast |
| 6 | `database.ts:38-57` PRAGMA outside tx | Major | **APPLY** | Race on concurrent migrations |
| 7 | `risk-engine-safety.test.ts:118` | Minor | **APPLY** | Missing `trade_type: "BUY"` in fixture |
| 8 | `convergence.ts:61-67` threshold | Major | **APPLY** | Dynamic `getThreshold` not honored in narrow-window revalidation |
| 9 | `hmac.ts:23` rawBody | Minor | **APPLY** | `!rawBody` rejects valid empty payloads; should be `=== undefined` |
| 10 | `thresholds.ts:7-13` exhaustive | Minor | **APPLY** | Default branch masks new tier additions |
| 11 | `manipulation-detector.ts:59-69` co-occurrence | Major | **APPLY** | Look-ahead leakage in backtest path |
| 12 | `risk-engine.ts:79-90` mirror/TVL ordering | Major | **APPLY** | Mirror floor applied after TVL cap can exceed cap |
| 13 | `migrations/005_co_buyer_index.sql` | Minor | **APPLY** | Add `wallet_address` to make index covering |
| 14 | `start-funnel.sh:20-30` tunnel-url stale | Minor | **APPLY** | Stale URL after funnel failure |
| 15 | `index.ts:37-44` async shutdown | Major | **SKIP** | User CLAUDE.md says "match scope" — current sync shutdown was deliberate; deferring requires coordinated app.close() refactor. Note in plan but defer. |
| 16 | `index.ts:84-93` leaderboard mutex | — | **SKIP (already done)** | 5a1df96 added `webhookHealthRunning`, but leaderboard does not have a mutex. **Re-verify:** if leaderboardJob can overlap (90s startup vs 06:00 tick), apply same pattern. |
| 17 | `trade-executor.ts:52-58` unique index | Major | **APPLY** | Add filtered unique index for active positions per mint |

**Re-check on #16:** Yes, leaderboardJob CAN overlap if 06:00 tick fires while a startup-triggered run is still going (unlikely but real). Apply mutex like webhookHealthJob. **APPLY.**

## Tasks

### Task 1 — `src/execution/jupiter-client.ts` getPriceUsd logging

```diff
-    } catch {
+    } catch (error) {
+      logger.warn({ mint, err: error instanceof Error ? error.message : String(error) }, "getPriceUsd: request failed");
       return null;
     }
```

### Task 2 — `src/blockchain/helius-client.ts` log on 4xx-other break

```ts
const response = await fetch(url);
if (!response.ok) {
  if (response.status === 429 || response.status >= 500) {
    throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
  }
  // 4xx-other: stop pagination but don't pretend it succeeded
  logger.warn({ address, status: response.status, beforeSignature }, "getWalletTransactions: non-OK 4xx, stopping pagination");
  break;
}
```

Add `import { logger } from "../utils/logger.js";` if not already imported.

### Task 3 — `src/execution/trade-executor.ts:107-124` BUY phantom-output guard (CRITICAL)

```diff
       const result = await this.swaps.executeSwap({
         inputMint: USDC_MINT,
         outputMint: convergence.token_mint,
         amountLamports: BigInt(Math.round(risk.sizeUsd * 1_000_000)),
         slippageBps,
         tier: convergence.tier
       });
-      const amountToken = result.outputAmount;
-      const actualEntryPrice = amountToken > 0 ? risk.sizeUsd / amountToken : entryPrice;
+      // Mirror the SELL phantom-exit guard: a non-positive outputAmount means
+      // the swap didn't actually deliver. Recording a fill anyway opens a NaN
+      // position, debits paper balance, and trips dedup on later signals.
+      if (!Number.isFinite(result.outputAmount) || result.outputAmount <= 0) {
+        throw new Error(`entry swap returned non-positive outputAmount: ${result.outputAmount}`);
+      }
+      const amountToken = result.outputAmount;
+      const actualEntryPrice = risk.sizeUsd / amountToken;
       this.fillExecution(executionId, {
```

The existing outer `try { ... } catch (err) { ... }` will mark execution FAILED on throw — verify by reading the surrounding catch block before applying.

### Task 4 — `src/execution/trade-executor.ts:177-182` BigInt precision

```diff
       const result = await this.swaps.executeSwap({
         inputMint: current.token_mint,
         outputMint: USDC_MINT,
-        amountLamports: BigInt(Math.max(1, Math.round(sellAmountToken * 10 ** decimals))),
+        // Multiply in BigInt space — for high-decimal tokens with large balances,
+        // sellAmountToken * 10**decimals can exceed Number.MAX_SAFE_INTEGER (2^53)
+        // and silently truncate, corrupting exit P&L.
+        amountLamports: (() => {
+          const tokenInteger = BigInt(Math.max(1, Math.round(sellAmountToken)));
+          return tokenInteger * (10n ** BigInt(decimals));
+        })(),
         slippageBps: exitSlippageBps,
         tier: current.tier
       });
```

Verify `decimals` is non-negative integer before applying — guard with `Math.max(0, decimals)` if needed.

### Task 5 — `src/storage/database.ts:38-57` move PRAGMA inside transaction

```diff
 function runWalletPnlTrackingMigration(db: AppDatabase): void {
-  const columns = new Set(
-    (db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>).map((column) => column.name)
-  );
-
   const tx = db.transaction(() => {
+    // Probe schema inside the transaction so two concurrent startups can't
+    // both observe the pre-migration state and race on duplicate ALTER TABLE.
+    const columns = new Set(
+      (db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>).map((column) => column.name)
+    );
+
     if (!columns.has("realized_sol_30d")) {
       db.exec("ALTER TABLE wallets ADD COLUMN realized_sol_30d REAL DEFAULT 0");
     }
     // ... rest unchanged
   });
   tx();
 }
```

### Task 6 — `src/__tests__/risk-engine-safety.test.ts:118` add trade_type

```diff
-    trades: [{ amount_usd: 30_000, amount_sol: 150 } as TradeRow]
+    trades: [{ amount_usd: 30_000, amount_sol: 150, trade_type: "BUY" } as TradeRow]
```

### Task 7 — `src/engine/convergence.ts` honor dynamic threshold in tier revalidation

The previous fix (5a1df96) only checked `getMinWalletsForTier(tier)` in the iterative downgrade loop. `getThreshold(coreCount, totalActive)` can be higher (e.g., 4 with large active pool), so the loop can leave a tier above its true required-wallet floor.

**Approach:** pass the dynamic `threshold` into the loop and use `Math.max(threshold, getMinWalletsForTier(tier))`. Same for the alpha-boost path.

```diff
     const threshold = getThreshold(coreCount, totalActive);
     if (uniqueWallets.size < threshold) return null;
     // ... unchanged ...

     let tier = pickTier(score, uniqueWallets.size);

     while (tier !== "WATCH") {
       const tierWindowSeconds = tier === "CRITICAL" ? 30 * 60 : tier === "NOTABLE" ? 60 * 60 : windowSeconds;
       if (tierWindowSeconds >= windowSeconds) break;
       const tierSince = Math.floor(Date.now() / 1000) - tierWindowSeconds;
       const tierWallets = new Set(recentBuys.filter((t) => t.block_time >= tierSince).map((t) => t.wallet_address));
-      if (tierWallets.size >= getMinWalletsForTier(tier)) break;
+      if (tierWallets.size >= Math.max(threshold, getMinWalletsForTier(tier))) break;
       tier = tier === "CRITICAL" ? "NOTABLE" : "WATCH";
     }
```

For the alpha-boost block, the existing call `pickTier(scoreForTier(boosted), uniqueWallets.size, boosted)` doesn't perform window check. The boost intent is preserved (score-override is by design), so just add a follow-up window-revalidation:

```diff
     if (hasTopAlpha) {
       const boosted = tier === "WATCH" ? "NOTABLE" : tier === "NOTABLE" ? "CRITICAL" : tier;
       tier = pickTier(scoreForTier(boosted), uniqueWallets.size, boosted);
+      // After boost, re-validate against narrow-window threshold (boost overrides
+      // score by design, but cannot bypass dynamic + static wallet floors).
+      while (tier !== "WATCH") {
+        const tierWindowSeconds = tier === "CRITICAL" ? 30 * 60 : tier === "NOTABLE" ? 60 * 60 : windowSeconds;
+        if (tierWindowSeconds >= windowSeconds) break;
+        const tierSince = Math.floor(Date.now() / 1000) - tierWindowSeconds;
+        const tierWallets = new Set(recentBuys.filter((t) => t.block_time >= tierSince).map((t) => t.wallet_address));
+        if (tierWallets.size >= Math.max(threshold, getMinWalletsForTier(tier))) break;
+        tier = tier === "CRITICAL" ? "NOTABLE" : "WATCH";
+      }
       logger.info({ token: newTrade.tokenMint, avgPnl, hasTopAlpha: true, tier }, "tier boosted by alpha trigger (re-validated against narrow-window floor)");
     }
```

**Test impact:** `convergence-quality-gate.test.ts` uses 2/3 wallets with `coreCount=0,totalActive=0`. `getThreshold(0,0) = max(2, log2(1)+1) = 2`. So:
- Test "boosts WATCH to NOTABLE" (2 wallets): `Math.max(2, 2) = 2`, fine.
- Test "boosts mixed... to CRITICAL" (3 wallets): `Math.max(2, 3) = 3`, fine.

Tests should pass unchanged.

### Task 8 — `src/api/middleware/hmac.ts:23` rawBody check

```diff
     const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
-    if (!rawBody) {
+    if (rawBody === undefined) {
       request.log.error("verifyHeliusHmac: rawBody not captured — content-type parser misconfigured");
```

### Task 9 — `src/config/thresholds.ts:7-13` exhaustive switch

```diff
 export function getMinWalletsForTier(tier: AlertTier): number {
   switch (tier) {
     case "CRITICAL": return 3;
     case "NOTABLE": return 2;
     case "WATCH": return 1;
-    default: return 2;
+    default: {
+      // Forces a compile error if a new AlertTier variant is added without
+      // updating this switch. Runtime fallthrough throws to surface the bug.
+      const _exhaustive: never = tier;
+      throw new Error(`unhandled AlertTier: ${_exhaustive as string}`);
+    }
   }
 }
```

### Task 10 — `src/engine/manipulation-detector.ts:59-69` look-ahead bound

`computeCoOccurrence` queries all convergences ever, leaking future co-occurrence into past backtests. Bound by `maxBuyTime`:

```diff
 function computeCoOccurrence(buys: TradeRow[], db: AppDatabase): number {
   const wallets = [...new Set(buys.map((b) => b.wallet_address))];
   if (wallets.length < 3) return 0;
+  const maxBuyTime = Math.max(...buys.map((b) => b.block_time));
 
   const placeholders = wallets.map(() => "?").join(",");
   const rows = db.prepare(`
     SELECT ct.convergence_id, t.wallet_address
     FROM convergence_trades ct
     JOIN trades t ON t.id = ct.trade_id
+    JOIN convergences c ON c.id = ct.convergence_id
     WHERE t.wallet_address IN (${placeholders})
-  `).all(...wallets) as Array<{ convergence_id: number; wallet_address: string }>;
+      AND c.last_trade_at <= ?
+  `).all(...wallets, maxBuyTime) as Array<{ convergence_id: number; wallet_address: string }>;
```

**Verify column name first:** check `convergences` schema in `src/storage/migrations/` — if the timestamp column is `created_at` instead of `last_trade_at`, use the actual name. If unsure, run `sqlite3 ./data/whale-watcher.sqlite ".schema convergences"`.

### Task 11 — `src/execution/risk-engine.ts` mirror floor before TVL cap

Locate the `MIRROR_MIN_PCT` and `tvlBracketCapPct` use site near line 79-90.

```ts
// BEFORE (current; mirror floor can push above TVL cap):
const adjustedSizePct = Math.max(MIRROR_MIN_PCT, Math.min(tvlBracketCapPct, mirrorPct * volAdj * drawdownHalve));

// AFTER (TVL cap is the hard ceiling):
const floorApplied = Math.max(MIRROR_MIN_PCT, mirrorPct * volAdj * drawdownHalve);
const adjustedSizePct = Math.min(tvlBracketCapPct, floorApplied);
```

Read the actual current code first to find the exact pattern — apply minimum diff.

### Task 12 — `src/storage/migrations/005_co_buyer_index.sql` covering index

```diff
 CREATE INDEX IF NOT EXISTS idx_trades_token_type_time
-  ON trades(token_mint, trade_type, block_time);
+  ON trades(token_mint, trade_type, block_time, wallet_address);
```

Note: SQLite re-runs `IF NOT EXISTS`. To force re-creation in dev, add a `DROP INDEX IF EXISTS` line before — but per project convention, prefer creating a new migration `006_co_buyer_index_v2.sql`:

```sql
-- Cover wallet_address so SELECT DISTINCT wallet_address can be served
-- entirely from the index.
DROP INDEX IF EXISTS idx_trades_token_type_time;
CREATE INDEX IF NOT EXISTS idx_trades_token_type_time
  ON trades(token_mint, trade_type, block_time, wallet_address);
```

**Decision:** create `006_co_buyer_index_covering.sql` rather than mutating 005, so deployed instances re-run cleanly via the existing migration framework.

### Task 13 — `scripts/start-funnel.sh:20-30` invalidate stale tunnel-url.txt

Add `: > tunnel-url.txt` (truncate) on both failure paths (funnel start failure, monitor detects drop) just before the error log/exit. Verify exact line numbers in current file before editing.

### Task 14 — `src/index.ts` leaderboard mutex

Same pattern as `webhookHealthRunning`:

```diff
+  let leaderboardRunning = false;
   const leaderboardJob = () => runLeaderboardRefresh().catch((err) => {
     logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "leaderboard-refresh: job failed");
   });
+  const leaderboardJobGuarded = async () => {
+    if (leaderboardRunning) return;
+    leaderboardRunning = true;
+    try { await leaderboardJob(); } finally { leaderboardRunning = false; }
+  };
   setTimeout(leaderboardJob, 90_000);
   setInterval(() => {
     const now = new Date();
-    if (now.getHours() === 6 && now.getMinutes() === 0) leaderboardJob();
+    if (now.getHours() === 6 && now.getMinutes() === 0) leaderboardJobGuarded();
   }, 60 * 1000);
```

(The 90s startup call is one-shot so doesn't need the guard, but the 06:00 path does — prevents overlap if a slow run still has the previous tick's work in flight.)

### Task 15 — `src/execution/trade-executor.ts:52-58` filtered unique index for active positions

Create migration `007_positions_active_unique.sql`:

```sql
-- Ensure at most one OPEN/PARTIAL position per (chain, token_mint).
-- Eliminates the SELECT → openPosition race window that lets two concurrent
-- convergences open duplicate positions on the same mint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_active_mint
  ON positions(token_mint)
  WHERE status IN ('OPEN', 'PARTIAL');
```

Catch the resulting `SQLITE_CONSTRAINT` in the `openPosition` flow to fall back gracefully (log + skip duplicate). Verify the existing flow's error handling before applying so the catch is at the right boundary.

### Task 16 (DEFERRED) — `transaction-parser.ts` multi-token swap attribution

Document in plan as deferred. Real bug for routes like SOL→USDC→MEME but requires meaningful refactor of `parseWalletTrade` to track routing. Out of scope for this cleanup loop. Open follow-up issue or note in audit-report.

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain at 67/67 (or higher if new tests added). If `convergence-quality-gate.test.ts` fails due to threshold change, reconcile.
3. `npm run build`
4. `launchctl kickstart -k gui/501/com.nassim.whale-watcher` and verify PID changed
5. E2E sanity: `curl http://127.0.0.1:3000/api/health` → 200; `curl -X POST http://127.0.0.1:3000/api/webhooks/helius` → 401
6. **DO NOT commit/push.** Stop and report. The human handles git.

## Skip / Defer Summary
- `transaction-parser.ts` multi-token: **DEFERRED**, separate effort
- `index.ts` async shutdown: **SKIPPED**, current sync was deliberate; revisit only if a real DB-close-during-request bug is observed

## Stop conditions
- Any task uncovers an unexpected behavioral test failure → stop and report
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional
- If migration 006/007 conflict with existing migration numbering, increment to next free slot
