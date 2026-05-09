# CodeRabbit Review #15 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 17:46:28Z against commit `93a6388`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-15-raw.md`.
**Counts:** 2 actionable + 1 outside-diff Major. 16 Duplicates ignored (CodeRabbit re-flagging preserved-decision skips).

## Triage — all 3 APPLY

| # | Path | Severity | Reason |
|---|------|----------|--------|
| 1 | `src/execution/risk-engine.ts:117-165` | 🟠 Major (escalated from #14 Minor) | Hard cap (`MAX_POSITION_PORTFOLIO_PCT` / `MAX_POSITION_USD`) is applied at line 161 *after* pool-TVL guard (118), exposure check (143), and heat cap (152). Large portfolios can reject an entry on the uncapped theoretical size when the executed (capped) order would pass. Compute `finalSizeUsd` / `finalSizePct` first, run guards against final values. |
| 2 | `src/execution/trade-executor.ts:98-103` | 🟠 Major | After `checkEntry()` already fetched live liquidity, `onConvergence()` calls `risk.tokenLiquidityLive()` a second time — outside the `try/catch` and after approval. A transient provider error here aborts the whole convergence path without marking the execution failed or sending the rejection notification. Reuse the liquidity returned by `checkEntry`. |
| 3 | `src/storage/models/wallets.ts:23` + migration | 🟠 Major | `insertIfMissing` / `upsert` create rows without setting `wallet_class`, so the column defaults to `'unknown'` per migration 004. The convergence quality gate (`convergence.ts:66-74`) rejects only when all triggers are `loser` / `accumulation_bot` / (`incomplete` with `n_closed_30d=0`). `'unknown'` matches none → uncomputed wallets bypass the gate as if they were proven alpha. Set `wallet_class='incomplete'` on new rows + backfill existing `'unknown'` rows. |

## Tasks

### Task 1 — `risk-engine.ts:115-165` cap before gates

Move the `hardCapUsd` / `finalSizeUsd` / `finalSizePct` computation up to right after `adjustedSizePct` is finalized (line 115), and use those final values in all downstream gates.

Concrete restructure (replace lines 115-165):

```typescript
    const adjustedSizePct = Math.min(tvlBracketCapPct, floorApplied);

    // Apply portfolio hard cap BEFORE downstream size-based gates so we evaluate
    // the executable size, not an uncapped theoretical one.
    const sizeUsd = (portfolioValueUsd * adjustedSizePct) / 100;
    const hardCapUsd = Math.min(portfolioValueUsd * MAX_POSITION_PORTFOLIO_PCT / 100, MAX_POSITION_USD);
    const finalSizeUsd = Math.min(sizeUsd, hardCapUsd);
    const finalSizePct = (finalSizeUsd / portfolioValueUsd) * 100;

    if ((finalSizeUsd / liquidityUsd) * 100 > MAX_POSITION_POOL_TVL_PCT) {
      return { allowed: false, reason: "position exceeds 0.5% of pool TVL", phase, portfolioValueUsd };
    }

    const honeypotLoss = this.numberConfig(`token:${convergence.token_mint}:honeypot_roundtrip_loss_pct`);
    if (honeypotLoss !== null && honeypotLoss > MAX_HONEYPOT_ROUNDTRIP_LOSS_PCT) {
      return { allowed: false, reason: "honeypot roundtrip loss above 8%", phase, portfolioValueUsd };
    }

    const top10Pct = this.numberConfig(`token:${convergence.token_mint}:top10_holders_pct`);
    if (top10Pct !== null && top10Pct > MAX_TOP_10_HOLDERS_PCT) {
      return { allowed: false, reason: "top 10 holders above 40% supply", phase, portfolioValueUsd };
    }

    const tokenAgeHours = await this.tokenAgeLive(convergence.token_mint);
    if (tokenAgeHours !== null && tokenAgeHours < MIN_TOKEN_AGE_HOURS && liquidityUsd < NEW_TOKEN_MIN_LP_USD) {
      return { allowed: false, reason: "token age below 24h and LP below $50k", phase, portfolioValueUsd };
    }

    const openPositions = (
      db.prepare("SELECT COUNT(*) AS count FROM positions WHERE status IN ('OPEN','PARTIAL')").get() as { count: number }
    ).count;
    if (openPositions >= limits.maxPositions) return { allowed: false, reason: "max open positions reached", phase, portfolioValueUsd };

    const exposurePct = this.openExposurePct(portfolioValueUsd);
    if (exposurePct + finalSizePct > limits.maxExposure) {
      return { allowed: false, reason: "portfolio exposure limit exceeded", phase, portfolioValueUsd };
    }

    const narrative = this.stringConfig(`token:${convergence.token_mint}:narrative`);
    if (narrative && this.positionsInNarrative(narrative) >= MAX_PER_NARRATIVE) {
      return { allowed: false, reason: "max per narrative reached", phase, portfolioValueUsd };
    }

    if (this.portfolioHeatPct(portfolioValueUsd) + finalSizePct * 0.25 > PORTFOLIO_HEAT_CAP_PCT) {
      return { allowed: false, reason: "portfolio heat cap exceeded", phase, portfolioValueUsd };
    }

    const solBalance = this.numberConfig("wallet:sol_balance");
    if (config.execution.mode === "live" && solBalance !== null && solBalance < SOL_RESERVE) {
      return { allowed: false, reason: "SOL reserve below 5 SOL", phase, portfolioValueUsd };
    }

    return { allowed: true, adjustedSizePct: finalSizePct, phase, portfolioValueUsd, sizeUsd: finalSizeUsd, liquidityUsd };
```

Note the `liquidityUsd` field added to the return — Task 2 will consume it.

### Task 2 — `risk-engine.ts` + `trade-executor.ts` thread liquidity through RiskCheck

**a) Add `liquidityUsd` to `RiskCheck` interface** (`risk-engine.ts:16-23`):

```diff
 export interface RiskCheck {
   allowed: boolean;
   reason?: string;
   adjustedSizePct?: number;
   phase?: RiskPhase;
   portfolioValueUsd?: number;
   sizeUsd?: number;
+  liquidityUsd?: number;
 }
```

The successful return in Task 1 already adds `liquidityUsd` — it's emitted only on the `allowed: true` path.

**b) `trade-executor.ts:98-103` — reuse the value:**

```diff
-    const liquidityUsd = await this.risk.tokenLiquidityLive(convergence.token_mint);
-    const slippageBps = this.swaps.slippageBpsForLiquidity(liquidityUsd);
+    const liquidityUsd = risk.liquidityUsd ?? null;
+    const slippageBps = this.swaps.slippageBpsForLiquidity(liquidityUsd);
     if (slippageBps === null) {
       logger.info({ mint: convergence.token_mint, liquidityUsd }, "execution skipped; liquidity below minimum");
       return;
     }
```

This eliminates the second provider call entirely. `risk.liquidityUsd` is guaranteed defined when `risk.allowed === true` (lines 92-96 check covers the rejection path), and we already know `liquidityUsd >= TVL_HARD_FLOOR_USD` (5_000) from `checkEntry`.

If a test stubs `risk.checkEntry` returning `{ allowed: true, ... }` without `liquidityUsd`, update the stub to include it.

### Task 3 — `wallets.ts` quality gate default

**a) `insertIfMissing` (line 79-94):** explicitly set `wallet_class = 'incomplete'`:

```diff
   insertIfMissing(input: { address: string; label?: string; source?: WalletSource; state?: WalletState; active?: boolean }): boolean {
     const result = this.db
       .prepare(
-        `INSERT INTO wallets (address, label, source, state, active)
-         VALUES (@address, @label, @source, @state, @active)
+        `INSERT INTO wallets (address, label, source, state, active, wallet_class)
+         VALUES (@address, @label, @source, @state, @active, 'incomplete')
          ON CONFLICT(address) DO NOTHING`
       )
```

**b) `upsert` (line 59-77):** same — set `wallet_class='incomplete'` on insert, but **leave it untouched on update** (a manually-managed wallet that's already been scored shouldn't get reset):

```diff
   upsert(input: { address: string; label?: string; source?: WalletSource; state?: WalletState; active?: boolean }): void {
     this.db
       .prepare(
-        `INSERT INTO wallets (address, label, source, state, active)
-         VALUES (@address, @label, @source, @state, @active)
+        `INSERT INTO wallets (address, label, source, state, active, wallet_class)
+         VALUES (@address, @label, @source, @state, @active, 'incomplete')
          ON CONFLICT(address) DO UPDATE SET
            label = excluded.label,
            source = excluded.source,
            state = excluded.state,
            active = excluded.active`
       )
```

The `DO UPDATE SET` clause does **not** touch `wallet_class`, preserving any computed value.

**c) New migration `src/storage/migrations/009_wallet_class_default_incomplete.sql`:**

```sql
-- Backfill any wallets still marked 'unknown' (the migration-004 default) to
-- 'incomplete' so the convergence quality gate (convergences.ts) treats them
-- as uncomputed instead of bypassing the gate. Idempotent — re-running on
-- already-classified wallets is a no-op.
UPDATE wallets SET wallet_class = 'incomplete' WHERE wallet_class = 'unknown' OR wallet_class IS NULL;
```

The migration runner picks up new `.sql` files in this directory automatically (confirmed by 005-008 pattern). No tracking table — guarded by the `WHERE` clause idempotency.

## Verification & Ship Sequence

1. `npm run typecheck`
2. `npm test` — must remain ≥ 72/72.
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

If any test stubs `RiskCheck` returning `{ allowed: true, sizeUsd, adjustedSizePct }` without `liquidityUsd`, add `liquidityUsd: 1_000_000` (or whatever value the test expects for the slippage tier) to the stub.

If any test on `wallets.ts` asserts that `insertIfMissing`/`upsert` doesn't set `wallet_class`, update the assertion to expect `'incomplete'`.

## Stop conditions

- Any unexpected behavioural test failure not explained by tasks above → stop and report.
- Honor prior decisions: alpha-boost score-override, MEME-tier 25% slippage, DB-trades-only for MEV/wash detection, atomic mint-reservation deferred, lots-based partial-fill scorer deferred.
