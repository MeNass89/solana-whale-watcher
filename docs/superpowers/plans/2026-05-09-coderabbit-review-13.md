# CodeRabbit Review #13 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 17:07:21Z against commit `529c8e7`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-review-13-raw.md`.
**Counts:** 7 actionable inline.

## Triage

| # | Path | Decision | Reason |
|---|------|----------|--------|
| 1 | `scripts/leaderboard.ts:108-114` | APPLY | `n_trades`/`n_buys`/`n_sells` count pre-cutoff seed BUYs (fed in for FIFO seeding), distorting 30-day metrics + flipping `accumulation_bot`/`incomplete` classification via sell/buy ratio. Gate increments by `block_time >= cutoff`. |
| 2 | `scripts/leaderboard.ts:170-283` | APPLY | Refresh is in-process (post review-12 task 6). Any throw between `new DatabaseConstructor` and `db.close()` leaks a SQLite handle into later jobs. Wrap body in `try { … } finally { db.close(); }`. |
| 3 | `src/__tests__/risk-engine-safety.test.ts:31-38` | APPLY | Existing test only proves `< $5k` rejects. Add boundary case at exactly `5_000` to lock `<` vs `<=` semantics. Live gate is `liquidityUsd < TVL_HARD_FLOOR_USD` (line 91) — $5_000 should be allowed. |
| 4 | `src/__tests__/trade-executor-dedup.test.ts:17-43` | APPLY | Spec only covers `OPEN`. The contract is "one active position per mint" — `PARTIAL` must also block reopening. Add a second case. |
| 5 | `src/engine/manipulation-detector.ts:43-55` | APPLY | `referenceTime` is replay-stable but `w.total_trades < 15` reads today's lifetime counter, so the same historical convergence scores differently as wallets accumulate later trades. Replace with a historical count via `WalletModel.countTradesAsOf(address, referenceTime)`. |
| 6 | `src/execution/risk-engine.ts:177-191` | APPLY | When `getPriceUsd(SOL_MINT)` returns `null` (vs throwing), code silently falls back to `MIRROR_FALLBACK_PCT`. Add `logger.warn` so the degraded sizing is observable. |
| 7 | `src/execution/trade-executor.ts:197-210` | APPLY | Sub-base-unit `sellAmountToken` quantizes to `total < 1n`, current code forces `sent = 1n` which liquidates the entire dust position when only a fractional exit was requested — corrupts realized P&L. Skip the exit entirely (no execution row, no swap) when `total < 1n`. **CodeRabbit's proposed diff with `return;` inside the IIFE doesn't compile** (the IIFE must return `bigint`); restructure so `total` is computed outside the IIFE and `exitPosition` early-returns before `createExecution`. |

**Result:** 7 apply, 0 skip.

## Tasks

### Task 1 — `scripts/leaderboard.ts:108-114` gate counters by cutoff

`buildWalletMetrics` doesn't know about the cutoff today. Thread it through.

**a) Signature change (line 87):**

```diff
-export function buildWalletMetrics(activeWallets: string[], trades: RawTrade[]): WalletMetricsResult {
+export function buildWalletMetrics(
+  activeWallets: string[],
+  trades: RawTrade[],
+  windowStart?: number
+): WalletMetricsResult {
```

`windowStart` optional preserves any test that constructs it without a cutoff (treats all trades as in-window).

**b) Counter loop (line 108-114):**

```diff
   for (const trade of trades) {
     const wallet = metrics.get(trade.wallet);
     if (!wallet) continue;
+    if (windowStart !== undefined && trade.block_time < windowStart) continue;
     wallet.n_trades += 1;
     if (trade.type === "BUY") wallet.n_buys += 1;
     else wallet.n_sells += 1;
   }
```

The skip lives **before** the FIFO `matchFifo(trades)` call (line 116) — that call still sees all rows, so seeding behaviour for FIFO is unchanged (which is what we want; pre-cutoff BUYs are needed to match in-window SELLs).

**c) Call site (line 191-194):**

```diff
   const { metrics, unmatched_sells } = buildWalletMetrics(
     activeWallets.map((row) => row.address),
-    trades
+    trades,
+    cutoff
   );
```

### Task 2 — `scripts/leaderboard.ts:170-283` try/finally around db handle

Wrap the entire body of `refreshLeaderboard` after `new DatabaseConstructor(DB_PATH)` so `db.close()` runs even on throw. Concretely:

```diff
   const db = new DatabaseConstructor(DB_PATH);
-  db.pragma("journal_mode = WAL");
-  db.pragma("busy_timeout = 5000");
-
-  const activeWallets = db.prepare(...).all() as ...;
-  // … rest of body, ending with …
-  db.close();
+  try {
+    db.pragma("journal_mode = WAL");
+    db.pragma("busy_timeout = 5000");
+
+    const activeWallets = db.prepare(...).all() as ...;
+    // … rest of body unchanged …
+  } finally {
+    db.close();
+  }
 }
```

Keep all variable declarations + statements inside the try; remove the trailing `db.close();` line (line 283) since `finally` covers it. No behavioural change beyond cleanup on failure.

### Task 3 — `src/__tests__/risk-engine-safety.test.ts:31-38` boundary case

Add a new `it()` block immediately after the existing "blocks entries below the $5k TVL hard floor" test:

```typescript
it("allows entries at exactly the $5k TVL hard floor", async () => {
  const { engine, convergence, trades } = setupRisk({ volatility: 50, liquidityUsd: 5_000 });

  const result = await engine.checkEntry(convergence, trades, 1);

  expect(result.allowed).toBe(true);
});
```

The live gate is `liquidityUsd < TVL_HARD_FLOOR_USD` (`risk-engine.ts:91`), so $5_000 is allowed. This locks down `<` vs `<=`.

### Task 4 — `src/__tests__/trade-executor-dedup.test.ts:17-43` PARTIAL case

Add a sibling `it()` inside the same `describe`:

```typescript
it("skips execution when a partial position already exists for the token mint", async () => {
  executionEnabled = config.execution.enabled;
  (config.execution as { enabled: boolean }).enabled = true;
  const db = new Database(":memory:") as AppDatabase;
  databases.push(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO positions
      (token_mint, token_symbol, amount_token, entry_price_usd, tier, status)
     VALUES ('mint-a', 'MINTA', 10, 1, 'NOTABLE', 'PARTIAL')`
  ).run();
  const getPriceUsd = vi.fn();
  const executor = new TradeExecutor();
  executor.configure({
    db,
    swaps: { getPriceUsd } as any,
    risk: { checkEntry: vi.fn() } as any,
    positions: { openPosition: vi.fn() } as any,
    discord: { send: vi.fn() } as any
  });

  await executor.onConvergence(convergence(), []);

  expect(getPriceUsd).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
});
```

Mirrors the OPEN test verbatim; only the `status` literal changes.

### Task 5 — `src/engine/manipulation-detector.ts:43-55` historical trade count

**a) Add `countTradesAsOf` to `WalletModel`** (`src/storage/models/wallets.ts`, alongside `find` near line 112-114):

```typescript
countTradesAsOf(address: string, asOfTime: number): number {
  const row = this.db
    .prepare("SELECT COUNT(*) AS c FROM trades WHERE wallet_address = ? AND block_time <= ?")
    .get(address, asOfTime) as { c: number };
  return row.c;
}
```

The `trades` table is already indexed on `(wallet_address, block_time)` after migration `008_trades_wallet_token_time_index.sql` (review-11 task 4 — shipped), so this query is index-served.

**b) Update `computeFreshWalletFraction` (line 43-57):**

```diff
 function computeFreshWalletFraction(buys: TradeRow[], walletModel: WalletModel): number {
   const wallets = [...new Set(buys.map((b) => b.wallet_address))];
   if (wallets.length === 0) return 0;
   // Anchor freshness to the convergence's most-recent trade time (not Date.now())
   // so backtests/replays are stable across runs.
   const referenceTime = Math.max(...buys.map((b) => b.block_time));
   const fourteenDaysAgo = referenceTime - 14 * 86400;
   let freshCount = 0;
   for (const addr of wallets) {
     const w = walletModel.find(addr);
     if (!w) { freshCount++; continue; }
-    if (w.added_at > fourteenDaysAgo || w.total_trades < 15) freshCount++;
+    // Use historical trade count as-of referenceTime instead of the live
+    // lifetime counter, so live + replay paths produce the same score.
+    const tradesAsOf = walletModel.countTradesAsOf(addr, referenceTime);
+    if (w.added_at > fourteenDaysAgo || tradesAsOf < 15) freshCount++;
   }
   return freshCount / wallets.length;
 }
```

`w.added_at` is a stored timestamp + `fourteenDaysAgo` derives from `referenceTime`, so that branch is already replay-stable — no change there.

If any test stubs `WalletModel` and now needs `countTradesAsOf`, add it to the stub. The only existing test that exercises this path is `manipulation-detector.test.ts` (if present); update accordingly.

### Task 6 — `src/execution/risk-engine.ts:177-191` warn on null SOL price

```diff
     if (!solPriceUsd || solPriceUsd <= 0) {
+      logger.warn(
+        { trades: trades.length, portfolioValueUsd, solPriceUsd },
+        "risk-engine: SOL/USD price unavailable; using fallback mirror size"
+      );
       return MIRROR_FALLBACK_PCT;
     }
```

Throw path (line 180-186) already logs — leave it alone.

### Task 7 — `src/execution/trade-executor.ts:180-229` skip exit on sub-base-unit quantization

Restructure so the lamport computation happens **before** `createExecution`, and `exitPosition` early-returns when the requested amount rounds to zero base units. Replace the block from line 180 (`const executionId = this.createExecution(...)`) through line 210 (end of IIFE) with:

```typescript
    const decimals = Math.max(0, Math.trunc(this.tokenDecimals(current.token_mint)));
    const scale = 10n ** BigInt(decimals);
    let total: bigint;
    if (!Number.isFinite(sellAmountToken) || sellAmountToken <= 0) {
      total = 1n;
    } else {
      const flooredTokenAmount = Math.floor(sellAmountToken);
      const intPart = BigInt(flooredTokenAmount);
      const fracPart = sellAmountToken - flooredTokenAmount;
      const fracBaseUnits = BigInt(Math.floor(fracPart * Number(scale)));
      total = intPart * scale + fracBaseUnits;
    }
    if (total < 1n) {
      logger.info(
        { positionId: current.id, sellAmountToken, decimals },
        "exit skipped: requested amount rounds to zero base units"
      );
      return;
    }
    const amountLamports = total;
    const actualSellTokenAmount = Number(amountLamports) / Number(scale);

    const executionId = this.createExecution({
      convergence: {
        id: current.convergence_id ?? 0,
        token_mint: current.token_mint,
        token_symbol: current.token_symbol,
        tier: current.tier
      },
      direction: "SELL",
      amountUsd,
      priceUsd,
      status: "PENDING",
      exitReason: reason
    });

    try {
      const result = await this.swaps.executeSwap({
```

Then **delete** the existing IIFE (lines 195-210) since `amountLamports` and `actualSellTokenAmount` are now declared above. The rest of the `try { ... }` block (line 211 onward — `executeSwap`, `outputAmount` check, `fillExecution`, `catch`) is unchanged. `actualSellTokenAmount` becomes `const` (was `let`) since the no-rounding-up path makes it stable.

**Why this shape:** the IIFE's job was scoping. Lifting it out gives us a clean early-return point. Skipping before `createExecution` means no orphan PENDING execution row gets written for an exit that never happens. The `total = 1n` branch for non-finite/non-positive `sellAmountToken` is preserved as a defence-in-depth (we already early-return at line 172 when `sellAmountToken <= 0`, so this is effectively unreachable, but it costs nothing).

Verify `logger` is already imported at the top of `trade-executor.ts` (it is — used elsewhere in the file).

## Verification & Ship Sequence

After all tasks applied:

1. `npm run typecheck`
2. `npm test` — must remain ≥ 70/70 (likely 72/72 after tasks 3 and 4 add tests).
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

If `manipulation-detector.test.ts` (or any other test that stubs `WalletModel`) breaks because of the new `countTradesAsOf` method, add the method to the stub returning `0` (or a sensible default).

## Stop conditions

- Any unexpected behavioural test failure not explained by tasks 1, 5, or 7 → stop and report.
- Honor prior decisions: alpha-boost score-override is intentional, MEME-tier 25% slippage is intentional, DB-trades-only for MEV/wash detection is intentional, atomic mint-reservation deferred (DB unique index already protects integrity), lots-based partial-fill scorer deferred.
