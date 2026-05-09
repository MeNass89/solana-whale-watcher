# Leaderboard FIFO Refactor — Detailed Plan for Codex

**Owner:** Codex CLI (write mode), executing under Claude/Nassim supervision.
**Repo:** `/Users/nassimlecornet/Projects/solana-whale-watcher`
**Branch:** `main` (all WW work has been on main).
**Status:** Plan finalized 2026-05-09. Ready to execute.

---

## 1. Why this refactor

Current `scripts/leaderboard.ts` (lines 121–168) groups trades by `(wallet_address, token_mint)` only, then collapses every BUY/SELL in the 30-day window into one pseudo-cycle via SQL `CASE`-aggregation.

**CodeRabbit finding (verified manually):**
- A `buy → sell → buy` sequence on the same mint becomes a single `PARTIAL` cycle (`sell_tok < buy_tok * 0.95`), even though there is a real round-trip in there.
- `n_closed` / `wins` are undercounted: 5 round-trips on the same mint count as 1.
- Hold time is `first_buy_time → last_sell_time` regardless of whether they belong to the same trade cycle.
- Sells of **pre-window inventory** (bought 45 days ago, sold 10 days ago) currently book the entire `sell_sol` as pure profit with zero cost basis — inflating `realized_sol` for swing traders.
- Buys with no matching sell in the window stay in `locked_sol`, but there is no per-cycle accounting, so partial exits are mis-categorized.

Downstream impact: `wallet_class` (`alpha`/`loser`/`accumulation_bot`/`incomplete`), `realized_sol_30d`, `n_closed_30d` are all written back to `wallets` table and consumed by:
- `src/engine/convergence.ts` — `allBad` filter for convergence quality gate
- `src/execution/position-manager.ts` — whale-sell follow filter (only follows `alpha` class)
- `src/storage/models/wallets.ts` — leaderboard reads

→ Bad classifications propagate into live trading decisions. This MUST be correct.

---

## 2. Algorithm — FIFO inventory matching

For each `(wallet, mint)` pair, walk all trades in the 30-day window **chronologically**.

Maintain a FIFO queue per pair: `lots: Array<{ tok: number; sol: number; usd: number; time: number }>`.

```
for each trade in chronological order:
  if BUY:
    lots.push({ tok: amount_token, sol: amount_sol, usd: amount_usd, time: block_time })
  if SELL:
    remaining = abs(amount_token)
    sellSol = abs(amount_sol)
    sellUsd = abs(amount_usd)
    matchedTok = 0
    cycleCostSol = 0
    cycleCostUsd = 0
    oldestBuyTime = null

    while remaining > 0 and lots.length > 0:
      lot = lots[0]
      take = min(remaining, lot.tok)
      ratio = take / lot.tok
      cycleCostSol += lot.sol * ratio
      cycleCostUsd += lot.usd * ratio
      if oldestBuyTime == null: oldestBuyTime = lot.time
      lot.tok -= take
      lot.sol -= lot.sol * ratio
      lot.usd -= lot.usd * ratio
      matchedTok += take
      remaining -= take
      if lot.tok ≈ 0 (within 1e-9 tolerance): lots.shift()

    if matchedTok > 0:
      // emit a closed cycle
      proceedsRatio = matchedTok / abs(amount_token)
      proceedsSol = sellSol * proceedsRatio
      proceedsUsd = sellUsd * proceedsRatio
      cycles.push({
        wallet, mint,
        cost_sol: cycleCostSol, cost_usd: cycleCostUsd,
        proceeds_sol: proceedsSol, proceeds_usd: proceedsUsd,
        hold_time_s: max(0, block_time - oldestBuyTime),
        pnl_sol: proceedsSol - cycleCostSol,
        pnl_usd: proceedsUsd - cycleCostUsd,
        closed_at: block_time
      })

    // if remaining > 0, sell exceeded available inventory:
    // - This is sell of pre-window inventory. SKIP it (no cost basis).
    // - Do NOT book the unmatched portion as profit.
    // - Log a debug counter for visibility.

at end of window for each (wallet, mint):
  if lots.length > 0:
    // open position — sum remaining lots into locked_sol
    locked_sol += sum(lot.sol for lot in lots)
```

**Per-wallet aggregation:**
- `n_closed` = number of cycles emitted for that wallet
- `wins` = cycles where `pnl_sol > 0`
- `realized_sol` = sum of `pnl_sol` across cycles
- `realized_usd` = sum of `pnl_usd` across cycles
- `avg_hold_time_s` = mean of `hold_time_s` across cycles
- `locked_sol` = sum of remaining FIFO lots' `sol` across all mints
- `n_open` = count of `(wallet, mint)` pairs with non-empty FIFO at end
- `n_partial` is REMOVED from the new model (FIFO either matches a cycle or leaves a lot open — there is no in-between).
  - But `wallets.n_closed_30d` consumers don't read `n_partial`, so this is safe.
  - Keep the field in the JSON output for backwards-compat, set to 0.

**Classification (unchanged logic, new inputs):**
- `n_closed === 0 && n_trades >= 50 && sell/buy ratio < 0.05` → `accumulation_bot`
- `n_closed === 0` → `incomplete`
- `realized_sol < 0` → `loser`
- else → `alpha`

The 0.05 sell/buy ratio is computed from raw trade counts (unchanged).

---

## 3. SQL change

Replace the current aggregating query with a raw-trade query:

```sql
SELECT wallet_address AS wallet,
       token_mint,
       trade_type,
       block_time,
       COALESCE(amount_token, 0) AS amount_token,
       COALESCE(amount_sol, 0)   AS amount_sol,
       COALESCE(amount_usd, 0)   AS amount_usd
FROM trades
WHERE block_time > ?
  AND wallet_address IN (SELECT address FROM wallets WHERE active = 1)
ORDER BY wallet_address, token_mint, block_time, id
```

The `ORDER BY ... id` tie-breaker is critical for deterministic ordering when two trades share `block_time` (block-bundled txs).

Keep the `cutoff = generated_at - WINDOW_SEC` semantics. Do NOT widen the window to include pre-cutoff lots — that is the point of `n_closed_30d` (closures within the last 30 days).

`abs()` on `amount_*` for sells: trades are stored with negative `amount_token` / `amount_sol` for sells (per `scripts/backfill-usd.ts` precedent). Codex must verify this by reading `src/storage/models/trades.ts` and one or two sample sell rows; if storage is unsigned, drop the abs() calls. **This is a load-bearing assumption — verify before writing.**

---

## 4. Code structure

Extract the FIFO matcher into a pure, testable function:

**New file:** `src/engine/fifo-matcher.ts`

```ts
export interface RawTrade {
  wallet: string;
  mint: string;
  type: "BUY" | "SELL";
  block_time: number;
  amount_token: number;
  amount_sol: number;
  amount_usd: number;
}

export interface ClosedCycle {
  wallet: string;
  mint: string;
  cost_sol: number;
  cost_usd: number;
  proceeds_sol: number;
  proceeds_usd: number;
  pnl_sol: number;
  pnl_usd: number;
  hold_time_s: number;
  closed_at: number;
}

export interface OpenPosition {
  wallet: string;
  mint: string;
  locked_sol: number;
  locked_usd: number;
  locked_tok: number;
  oldest_buy_time: number;
}

export interface FifoMatchResult {
  cycles: ClosedCycle[];
  open: OpenPosition[];
  unmatched_sells: number;  // count of sells where remaining > 0 after FIFO drained
}

// Pure function — no DB, no logger, no I/O.
// Trades MUST be pre-sorted by (wallet, mint, block_time, id).
export function matchFifo(trades: RawTrade[]): FifoMatchResult { ... }
```

`scripts/leaderboard.ts` becomes the I/O orchestrator:
1. Load raw trades
2. Call `matchFifo(trades)`
3. Aggregate per-wallet metrics from `cycles` + `open`
4. Write JSON, write back to `wallets` table, run prune logic

The classification, JSON shape, prune logic, and `--apply-prune` flag stay unchanged.

---

## 5. Tests

**New file:** `src/__tests__/fifo-matcher.test.ts` (vitest, mirrors existing test conventions).

Required test cases:

1. **Empty input** → `{ cycles: [], open: [], unmatched_sells: 0 }`.

2. **Single buy, no sell** → 0 cycles, 1 open position with full lot, oldest_buy_time = trade time.

3. **Single round-trip** (buy 100 tok @ 1 SOL, sell 100 tok @ 1.5 SOL) → 1 cycle with `pnl_sol = 0.5`, `cost_sol = 1.0`, `proceeds_sol = 1.5`.

4. **Round-trip with hold time** (buy at t=1000, sell at t=4600) → cycle with `hold_time_s = 3600`.

5. **Two round-trips on same mint** (buy→sell→buy→sell) → 2 cycles with correct per-cycle PnL. CRITICAL: this is the test that exposes the current bug.

6. **Partial sell** (buy 100, sell 40) → 1 cycle covering 40 tokens, 1 open position with remaining 60 tokens.

7. **Pre-window sell** (sell with no preceding buy in trade list) → 0 cycles, 0 open, `unmatched_sells: 1`. The sell is dropped entirely from realized PnL.

8. **Multiple buys, single sell** (buy 50 @ 1 SOL, buy 50 @ 2 SOL, sell 100 @ 4 SOL) → 1 cycle with `cost_sol = 3`, `proceeds_sol = 4`, `pnl_sol = 1`. `oldest_buy_time` = first buy.

9. **FIFO ordering preserved** (buy 100 @ t=1, buy 100 @ t=2, sell 100 @ t=3) → cycle uses first lot only (older inventory).

10. **Two distinct mints for same wallet** → cycles are isolated per mint, no cross-contamination.

11. **Two distinct wallets** → totally separate, no cross-contamination.

12. **Sell exceeds inventory partially** (buy 50, sell 100) → 1 cycle for 50 tokens, `unmatched_sells: 1` (50-tok overflow). Open position empty.

13. **Token amount precision** (rounding tolerance) — buy 1.0, sell 0.9999999999 (within 1e-9) → treats lot as fully consumed (lots.shift()), not as partial leaving 1e-10. Use `Math.abs(lot.tok) < 1e-9` for the "lot empty" check.

14. **Negative amount_sol/amount_token on sells** — verify `abs()` is applied (only if Codex confirms storage is signed; otherwise replace with non-negative assertion).

Each test asserts both the cycle list AND the open positions array. No test should assert on the shape of unmatched sells beyond the count.

**Add an integration smoke test** in `src/__tests__/leaderboard-script.test.ts`:
- Spin up `:memory:` SQLite, run migrations
- Insert 1 wallet with 4 trades simulating buy→sell→buy→sell
- Import the per-wallet aggregator (extracted from leaderboard.ts) and assert `n_closed = 2`, `realized_sol = sum of cycle pnls`.
- This catches integration bugs the pure tests miss.

---

## 6. Files to change

| File | Change |
|---|---|
| `src/engine/fifo-matcher.ts` | **NEW** — pure `matchFifo()` function. |
| `src/__tests__/fifo-matcher.test.ts` | **NEW** — 14 unit tests. |
| `src/__tests__/leaderboard-script.test.ts` | **NEW** — integration smoke test. |
| `scripts/leaderboard.ts` | **REWRITE** — replace SQL aggregation + cycle classification block (lines 121–168) with FIFO call + per-wallet aggregation. JSON output shape and prune logic stay identical. |

No changes to `src/engine/scorer.ts`, `convergence.ts`, `position-manager.ts`, or models — the contract with `wallets.realized_sol_30d` / `n_closed_30d` / `wallet_class` is preserved (same column writes, just more accurate values).

---

## 7. Verification checklist for Codex

1. ✅ `npm run typecheck` — no new errors.
2. ✅ `npm test` — all existing 47 tests still pass + new tests pass.
3. ✅ `npm run build` — clean compile.
4. ✅ Run `npx tsx scripts/leaderboard.ts` against live DB; capture before/after `data/leaderboard.json` diff.
5. ✅ Spot-check: pick the top-3 alpha wallets in the BEFORE leaderboard, verify their AFTER `n_closed` is `>=` BEFORE (FIFO splits cycles, never merges).
6. ✅ Spot-check: pick a wallet that was `loser` BEFORE, verify its FIFO cycles match the pattern visually (hand-walk 5-10 trades).
7. ✅ Confirm `data/leaderboard.json` is gitignored (it should be — verify via `git check-ignore data/leaderboard.json`).

If any check fails, **stop and report** — do NOT push partial work.

---

## 8. What is OUT OF SCOPE

- Do not change the 30-day window length.
- Do not change the alpha/loser/bot classification thresholds.
- Do not change the prune logic (`CONFIRMED_LOSER_ADDRESSES`, `--apply-prune`).
- Do not change the `wallets` schema.
- Do not change downstream consumers (`convergence.ts`, `position-manager.ts`).
- Do not introduce new dependencies.
- Do not "improve" formatting, linting, unrelated comments, or unrelated files.

This is a **surgical algorithmic correctness fix**, not a rewrite of the leaderboard system.

---

## 9. Commit message template

```
fix(leaderboard): FIFO inventory matching for accurate per-cycle PnL

Replaces SQL CASE-aggregation that collapsed every (wallet, mint) round-trip
in the 30-day window into one pseudo-cycle. Now walks trades chronologically
and matches sells against buy lots FIFO-style, emitting one cycle per closed
round-trip.

Fixes:
- buy→sell→buy→sell on same mint now counts as 2 cycles (was 1 PARTIAL)
- per-cycle hold time, pnl_sol, pnl_usd
- sells of pre-window inventory are dropped (no fake profit)
- partial exits leave correct remaining lots in locked_sol

Pure matcher extracted to src/engine/fifo-matcher.ts with 14 unit tests
+ 1 integration smoke test. wallets.realized_sol_30d / n_closed_30d
contract preserved — downstream consumers unaffected.

Co-Authored-By: Codex <noreply@openai.com>
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## 10. Execution mode

Codex runs with full write access on this branch. After verification checklist passes, Codex commits and pushes. Claude then waits for CodeRabbit re-review and triages findings.
