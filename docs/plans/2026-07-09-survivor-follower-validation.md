# Survivor follower validation — consensus fix plan (2026-07-09)

**Status:** consensus locked between Claude (Fable 5) and gpt-5.6-sol peer (openrig, whale-fix2),
after independent analyses + collision round. Implementation dispatched to gpt-5.5.
**Peer artifacts:** `~/.openrig/workspace/whale-fix2/docs/review/whale-fix/independent-analysis.md`.

## 1. Why: the paper validation is a fiction

The 07-05 discovery session enrolled 2 "survivor" wallets for 2–4 weeks of m=1 paper
validation. Zero data has been produced. Four independent blockers, each fatal, all verified live:

1. **Nightly eviction.** `scripts/refresh-pool.ts` (~line 139) runs `UPDATE wallets SET active = 0`
   then upserts only the 50 SolanaTracker wallets, then syncs the Helius webhook to actives.
   Survivors sit at `active=0, total_trades=0`: they never received one webhook event.
   Side bugs: refresh-pool stamps its wallets `source: "discovered"` (collides with the discovery
   pipeline's value), and `src/index.ts` seed logic coerces `'discovered'` → `'manual'`.
2. **m=1 is structurally impossible.** `src/engine/convergence.ts` `CONVERGENCE_THRESHOLD = 2`;
   executions fire only from convergences. No follow-one-wallet path exists. Additionally
   `trade-executor.ts` `isPumpFunMint()` skips `…pump` mints — but the survivors' edge lives in
   early pump.fun tokens.
3. **Execution layer dead.** All 10 historical executions FAILED on Jupiter 429 (2026-07-01).
   `jupiter-client.ts` does raw fetch, no key, no limiter, no backoff. Also the existing
   position-manager exit policy (−8%/30min stop, +50% partial TP, 72h time stop) contradicts the
   backtested recipe (TP+100 / SL−30, ≤1h hold) — running validation under the wrong exits would
   answer a question nobody asked.
4. **Both survivors are dead on-chain** (dominant, P0). Verified twice independently via
   `getSignaturesForAddress`: survivor A (`CAKW…j2Qg`) last tx 2026-06-11 05:08 UTC; survivor B
   (`Dzio…dE2U`) last tx 2026-06-16 14:37 UTC — 19–24 days **before** their 07-05 enrollment.
   Sniper wallets are burners; wallet half-life is a structural parameter of the strategy.
   Fixing 1–3 alone would validate nothing.

## 2. Consensus design

### 2.1 Pinning & tracking (blocker 1)

- Add `monitor_policy TEXT NOT NULL DEFAULT 'pool'` to `wallets` (values: `'pool' | 'pinned'`).
  Migration in the existing migration path.
- `refresh-pool.ts`: `UPDATE wallets SET active = 0 WHERE monitor_policy = 'pool'`; its upsert
  must never clobber a pinned row (guard by address); stamp its wallets
  `source: 'solanatracker'` (fix the collision). Discovery-enrolled wallets keep
  `source: 'discovered'`, `monitor_policy: 'pinned'`.
- Fix `src/index.ts` seed coercion so `'discovered'` survives restarts.
- Helius webhook sync = **union**: active pool wallets ∪ pinned wallets. One webhook, no second
  infra. After every refresh, assert the invariant (every pinned wallet present in the webhook
  address list) and log loudly on violation.

### 2.2 FollowerEngine — m=1 path (blocker 2)

- New module `src/engine/follower.ts`, hooked **after trade persistence** (same ingest point that
  feeds ConvergenceEngine), not inside it. `CONVERGENCE_THRESHOLD` untouched; no synthetic
  convergence rows; the m≥2 strategy and its ledger stay exactly as-is.
- Trigger: a persisted BUY from a wallet with `monitor_policy='pinned'`. Dedup per
  (wallet, mint) within an open-position window: one follower position per survivor per token at
  a time.
- The pump.fun mint skip does **not** apply to the follower path (it stays for convergence).
- Recipes are **pre-registered and frozen** per survivor in a `follower_recipes` table (or config
  seeded at migration): recipe id, wallet, TP pct, SL pct, max hold seconds, notional. Seed:
  survivor recipe A = TP+100 / SL−30 / 3600s / $1000; recipe B variant = TP+100 / SL−15 / 3600s
  / $1000. No live parameter tuning during the validation window.

### 2.3 Execution & pricing (blocker 3)

- `jupiter-client.ts`: base URL → `https://api.jup.ag` keyless (lite-api is being deprecated;
  keyless traffic migrates to api.jup.ag at 0.5 RPS — verified against Jupiter docs 2026-07-09).
  Add a **global client-side rate limiter ≤0.5 rps** shared by getQuote/getPriceUsd, exponential
  backoff honoring `Retry-After` (3 attempts), and an optional `JUPITER_API_KEY` env → `x-api-key`
  header hook so a key can be added later without code change.
- **Never synthesize fills** (the +$572k phantom-cash scar). Quote failure after retries =
  **SKIP, recorded** in the ledger with reason (429 / no-route / timeout). Skips are validation
  data — silent skips bias results.
- Exits for follower positions use the **frozen recipe** (TP/SL/time-stop), not the
  position-manager's −8%/30min / partial-TP / 72h policy. Exit marks priced through the same
  quoted path; a position whose exit cannot be quoted is closed at the next successful quote and
  flagged `exit_degraded`.

### 2.4 Ledger & accounting

- Separate tables: `follower_signals`, `follower_executions`, `follower_positions`. **No shared
  `paper_balance_usd`** — flat $1000 notional per accepted signal, append-only PnL attributed by
  (strategy, survivor, recipe). No fictional bankroll, no daily loss brake, no PAUSED_RISK.
- Record per signal: source tx signature, wallet, mint, on-chain block time, webhook receipt ts,
  signal-detect ts, quote request/response ts, quoted route + price, fill price, mark price at
  fill, entry latency (block time → fill), exit ts + reason (TP/SL/time/degraded), realized PnL,
  and for skips: skip reason + timestamps. MAE/MFE tracked while open.
- Max 3 concurrent positions per survivor — recorded as a constraint and reported as a secondary
  scenario, not baked into the primary alpha result.

### 2.5 Liveness contract & rotation (blocker 4)

- **Enrollment gate** (function usable by CLI + engine): candidate must show (i) a qualifying BUY
  within the last 72h, (ii) minimum BUY cadence over 7d and 14d windows, (iii) projected signal
  volume compatible with the ≥30-closed-trades decision gate, (iv) no brutal recent cadence
  break. Refuse dormant wallets loudly.
- **Wallet-death detector**: scheduled check (piggyback existing scheduler) — no BUY in N days
  (default 4) → flag `DORMANT`, alert in logs/notifications, stop counting toward the sample.
  A dead wallet stays in the ledger; replacement is a **new enrollment** under a new cohort id,
  never a silent swap.
- **Discovery rerun (operational, after code lands):** rerun `src/discovery/cli.ts` +
  `src/discovery/shortlist-cli.ts` on fresh data; enroll only candidates passing the liveness
  gate. The two historical survivors remain research artifacts, not live subjects.

### 2.6 Validation contract (decidability)

- Two separate primary outputs: **execution coverage** (signals → quoted → filled, skip taxonomy)
  and **conditional alpha** (PnL of filled trades under frozen recipes).
- Pre-registered decision gate: 4 weeks **and** ≥30 closed trades per survivor; fragility check
  (result must not hinge on 1–2 outlier trades).
- The validation clock starts only at: living wallets enrolled **and** first end-to-end proof
  observed (BUY captured → quote → paper fill → attributed position).

## 3. Explicitly NOT doing

Paid API keys as a v1 requirement; live trading; any ConvergenceEngine/threshold change; shared
paper balance for followers; multi-oracle price aggregation; new infra services; dashboards;
live recipe tuning; alpha-based intraday brakes.

## 4. Acceptance criteria

1. All existing tests pass (esp. `paper-swap-phantom`, `trade-executor-dedup`,
   `position-manager-exits`, `convergence`); new unit tests for: pinned-survives-refresh (incl.
   webhook union invariant), follower trigger + dedup, recipe exits, limiter/backoff behavior,
   skip recording, liveness gate, death detector.
2. Simulated refresh-pool run leaves pinned wallets active and in the webhook set.
3. A synthetic pinned BUY injected at the ingest point produces a follower execution attempt with
   a real quote (or a recorded skip), a position with recipe exits, and correct ledger rows —
   with zero rows written to convergence/paper-balance tables.
4. Deployed: build → restart launchd service → verify new bytes loaded and follower engine
   logs its startup with the pinned set.
