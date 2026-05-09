# Plan — Leaderboard → Convergence Engine Integration

**Date**: 2026-05-06
**Goal**: Wire the SOL-realized leaderboard (already produced by `scripts/leaderboard.ts`) into the live convergence decision so that:
- Convergences triggered by **proven alpha wallets** (top SOL P&L 30 d) get an automatic tier upgrade.
- Convergences triggered **only** by losers / incomplete / accumulation bots get rejected before execution.
- The data lives on the `wallets` table so the engine reads it cheaply on every webhook hit.

## Context — already in place

- `scripts/leaderboard.ts` (just-merged) classifies every active wallet into `alpha | loser | incomplete | accumulation_bot` based on 30-day trades and writes `data/leaderboard.json`.
- The convergence engine `src/engine/convergence.ts` calls `computeMvpScore(recentBuys, walletScores)` where `walletScores` is a `Map<address, score 0-100>` from `wallets.scoresFor()`.
- The wallets table has `score`, `state`, `active`, `last_scored_at`. **No raw P&L column.**
- Currently `99mRw3Ez…` (the accumulation bot) has `active = 1` and would still be allowed to trigger a convergence.

## Deliverables

### 1. Migration `004_wallet_pnl_tracking.sql`

**File**: `src/storage/migrations/004_wallet_pnl_tracking.sql` (new)

Add 3 columns to the `wallets` table:

```sql
ALTER TABLE wallets ADD COLUMN realized_sol_30d REAL DEFAULT 0;
ALTER TABLE wallets ADD COLUMN n_closed_30d INTEGER DEFAULT 0;
ALTER TABLE wallets ADD COLUMN wallet_class TEXT DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_wallets_class ON wallets(wallet_class);
CREATE INDEX IF NOT EXISTS idx_wallets_realized_sol ON wallets(realized_sol_30d DESC);
```

`wallet_class` ∈ `{alpha, loser, incomplete, accumulation_bot, unknown}`. `unknown` is the default for wallets the leaderboard has not yet processed.

The migration must be additive only — no data migration, no column drops. Idempotent guard: check `PRAGMA table_info(wallets)` before adding (since some SQLite drivers re-run migrations on startup).

### 2. Leaderboard write-back

**File**: `scripts/leaderboard.ts`

After computing `metrics` for every wallet (already done), add a final UPDATE pass that writes back to the `wallets` table for **every** wallet — not just the pruned ones.

Add a transactional batch:

```ts
const updateMetrics = db.prepare(`
  UPDATE wallets
  SET realized_sol_30d = ?, n_closed_30d = ?, wallet_class = ?
  WHERE address = ?
`);

const writeBack = db.transaction((rows: WalletMetrics[]) => {
  for (const row of rows) {
    updateMetrics.run(row.realized_sol, row.n_closed, row.class, row.wallet);
  }
});
writeBack([...metrics.values()]);
```

Run this BEFORE the optional `--apply-prune` block (so even non-pruning runs refresh the metrics). Print a one-line summary: `wallets metrics updated: <count>`.

### 3. Convergence engine — tier modulation

**File**: `src/engine/convergence.ts`

After the existing tier assignment block (around line 54-68) and before the `wasRecentlyAlerted` check, insert a new wallet-quality gate.

Add a helper on `WalletModel` (next deliverable) called `qualityFor(addresses)` that returns `Map<address, { realized_sol_30d, n_closed_30d, wallet_class }>`.

Logic:

```ts
const quality = this.wallets.qualityFor([...uniqueWallets]);
const triggers = [...uniqueWallets].map((addr) => quality.get(addr)).filter(Boolean);

const allBad = triggers.length > 0 && triggers.every(
  (q) => q!.wallet_class === "loser" 
      || q!.wallet_class === "accumulation_bot"
      || (q!.wallet_class === "incomplete" && q!.n_closed_30d === 0)
);
if (allBad) {
  logger.info({ token: newTrade.tokenMint, walletCount: uniqueWallets.size }, "convergence rejected: no proven-alpha trigger");
  return null;
}

const hasTopAlpha = triggers.some((q) => q!.realized_sol_30d > 100 && q!.n_closed_30d >= 5);
const avgPnl = triggers.reduce((s, q) => s + (q!.realized_sol_30d ?? 0), 0) / Math.max(triggers.length, 1);

if (hasTopAlpha) {
  if (tier === "WATCH") tier = "NOTABLE";
  else if (tier === "NOTABLE") tier = "CRITICAL";
  logger.info({ token: newTrade.tokenMint, avgPnl, hasTopAlpha: true }, "tier boosted by alpha trigger");
}
```

**Threshold values** — make them constants at the top of the file with comments explaining the intent. Pick the values exactly as above for v1.

**Important guarantees:**
- The tier downgrade path (existing `getMinWalletsForTier` block) still runs — alpha boost happens AFTER, so size requirements still apply.
- If `quality` lookup fails (e.g. all wallets have `wallet_class = 'unknown'`), the engine must fall through to existing behavior (don't reject). Treat `unknown` as neutral — neither boost nor reject.

### 4. WalletModel.qualityFor

**File**: `src/storage/models/wallets.ts`

Add a new method:

```ts
qualityFor(addresses: string[]): Map<string, { realized_sol_30d: number; n_closed_30d: number; wallet_class: string }>
```

SQL: `SELECT address, realized_sol_30d, n_closed_30d, wallet_class FROM wallets WHERE address IN (?, ?, ...)`. Use parameterized expansion via the existing `scoresFor` style (look at how it builds the IN clause).

### 5. Cron / scheduler hookup

**File**: `src/jobs/scheduler.ts` (or wherever the wallet-scorer cron is wired — find via grep `runWalletScorer`)

Add a job that runs `scripts/leaderboard.ts` (without `--apply-prune`) **once per day at 06:00 local**. Use the same scheduling primitive already in use (likely node-cron or a setInterval). The job invokes the script as a child process via `node --import tsx scripts/leaderboard.ts` OR — preferred — extracts the leaderboard logic into a callable function `refreshLeaderboard(db)` and imports it.

If extracting is too invasive, just spawn the child process. Document the choice in the job code.

### 6. Tests

**File**: `src/__tests__/convergence-quality-gate.test.ts` (new)

Three minimum cases:

1. **All triggers are losers** → `checkConvergence` returns `null`.
2. **One trigger is alpha (`realized_sol_30d = 200, n_closed_30d = 10`)**, tier was `WATCH` → final tier is `NOTABLE`.
3. **Mixed (alpha + incomplete + unknown)** → tier behavior follows alpha-boost path; not rejected.

Use the existing test scaffolding pattern from `mev-filter.test.ts`. Mock the DB with in-memory better-sqlite3 if the project already does that for tests.

## Acceptance criteria

- [ ] Migration `004` applied cleanly on the live DB without breaking the running server. Run `node -e "import('./src/storage/database.js')"` smoke test.
- [ ] After `node --import tsx scripts/leaderboard.ts`, the `wallets` table has non-default `realized_sol_30d` for at least 14 alpha wallets and `wallet_class = 'accumulation_bot'` for `99mRw3Ez…`.
- [ ] `npx tsc --noEmit` passes.
- [ ] New tests pass (`npm test` or whatever the project uses).
- [ ] Webhook server still serves trades — verify with `curl https://macbook-air-nassim.taila10165.ts.net/api/webhooks/helius -H "Authorization: wrong" -X POST -H "Content-Type: application/json" -d '[]'` returning `401` (route alive).
- [ ] One synthetic test: insert two BUY rows from `99mRw3Ez…` + one alpha wallet on a fresh token mint, manually call `engine.checkConvergence(...)` — verify the convergence is created and tier reflects the alpha boost (or rejected if both bad). Document the manual test in the plan output, no need to automate.

## Out of scope

- Birdeye USD pricing (already explicitly skipped — too expensive).
- Frontend / dashboard.
- Re-scoring all 38 disabled wallets — only active ones get the new columns refreshed.
- Auto-disable based on streak of bad days — separate task once we have stability.

## Risks

- **Live DB migration on a running server**: the wallets table is hot. Use the migration runner (`runMigrations`) which applies `004_wallet_pnl_tracking.sql` via the PRAGMA-guarded helper `runWalletPnlTrackingMigration`. If applying manually, check `PRAGMA table_info(wallets)` for column existence first.
- **`unknown` wallets at deploy time**: until the first leaderboard run, every wallet has `wallet_class = 'unknown'`. The convergence gate treats `unknown` as neutral (no boost, no reject) — verify this is what the code does, not a regression that blocks all convergences for 24 h.
- **Cron failure leaves stale data**: if the daily refresh dies, `realized_sol_30d` becomes stale. Acceptable for v1 — fix in v2 with a "last_refreshed_at" check that ignores entries older than 48 h.

## Verification commands

```bash
# Apply migration (manual, safe)
sqlite3 data/whale-watcher.sqlite < src/storage/migrations/004_wallet_pnl_tracking.sql

# Refresh leaderboard + write-back
node --import tsx scripts/leaderboard.ts

# Inspect new columns
sqlite3 -header -column data/whale-watcher.sqlite "SELECT substr(address,1,12)||'…' wallet, ROUND(realized_sol_30d,2) sol, n_closed_30d closed, wallet_class FROM wallets WHERE active = 1 ORDER BY realized_sol_30d DESC LIMIT 20;"

# Confirm bot flagged
sqlite3 data/whale-watcher.sqlite "SELECT address, wallet_class FROM wallets WHERE address = '99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c';"

# Type check
npx tsc --noEmit

# Tests
npm test 2>&1 | tail -20

# Webhook still alive
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST https://macbook-air-nassim.taila10165.ts.net/api/webhooks/helius -H "Authorization: wrong" -H "Content-Type: application/json" -d '[]'
```
