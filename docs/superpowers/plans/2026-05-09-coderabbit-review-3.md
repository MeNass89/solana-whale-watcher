# CodeRabbit Review #3 — Codex Execution Plan

**Source review:** PR #1, submitted 2026-05-09T15:01:08Z (7 actionable + 3 outside-diff).
**Goal:** Apply the 4 still-valid findings, skip the 3 already-fixed-in-5a1df96 duplicates, ship clean batch.

## Triage Summary

| # | File / Lines | Severity | Status | Action |
|---|--------------|----------|--------|--------|
| 1 | `src/execution/jupiter-client.ts:123-149` | Nitpick / Trivial | **SKIP** | Premature optimization — Jupiter rate limits undocumented, no observed 429s. Defer until measured. |
| 2 | `src/blockchain/helius-client.ts:96-97` | Major | **APPLY** | `getWalletTransactions` silently swallows non-OK responses |
| 3 | `src/engine/scorer.ts:86-91` | Nitpick / Low | **APPLY** | Drop dead `currentState` param |
| 4 | `src/execution/trade-executor.ts:157-158` | Duplicate | **SKIP** | Already fixed in 5a1df96 (panicExit fallback 2000 bps shipped) |
| 5 | `src/index.ts:77-83` (leaderboard) | Duplicate | **SKIP** | Already fixed in 5a1df96 (`setTimeout(leaderboardJob, 90_000)`) |
| 6 | `src/index.ts:85-89` (webhook mutex) | Duplicate | **SKIP** | Already fixed in 5a1df96 (`webhookHealthRunning` guard) |
| 7 | `scripts/backfill-usd.ts:103-109` | Duplicate | **SKIP** | Already fixed in 5a1df96 (`retryAfterSeconds` honored) |
| 8 | `src/jobs/webhook-health.ts:29-43` | Major | **APPLY** | Fall back to `webhook.accountAddresses` when active list transiently empty |
| 9 | `src/engine/convergence.ts:55-95` | Major | **APPLY (partial)** | Window-floor bypass in alpha-boost path is the real bug — close it. **Score-floor bypass is INTENTIONAL** (boost = trust signal, by design overrides score). |

## Tasks

### Task 1 — `src/blockchain/helius-client.ts` (Major)

**Problem:** `getWalletTransactions` lines 96-97 break on `!response.ok`, masking 429/5xx. Other methods (`getWebhook`) correctly throw `HeliusRequestError` on transient failures.

**Fix:** Throw `HeliusRequestError` on 401/403/429/5xx and on any unexpected 4xx. Only `404` is treated as the no-more-data terminal response.

```ts
const response = await fetch(url);
if (!response.ok) {
  // Rate-limit / server errors should surface to callers (so wallet-scorer
  // can log + retry next cycle); 4xx-other means malformed request and
  // pagination must stop, not throw.
  if (response.status === 429 || response.status >= 500) {
    throw new HeliusRequestError(response.status, `Helius getWalletTransactions failed (${response.status})`);
  }
  break;
}
const batch = (await response.json()) as HeliusTransaction[];
```

**Verification:** `npm run typecheck`, `npm test` (no test currently covers this path; existing tests must still pass).

### Task 2 — `src/engine/scorer.ts` + callers (Nitpick)

**Problem:** `computeWalletMetrics` declares `currentState: WalletState` at line 90 but never references it. State is derived from score via `deriveState(score)`.

**Fix:** Drop the param. Update 4 call sites:

- `src/jobs/wallet-scorer.ts:37` — remove `wallet.state` arg
- `src/__tests__/mev-filter.test.ts:23, 33, 43` — remove the trailing `"NEW"` / `"ACTIVE"` arg

```diff
 export function computeWalletMetrics(
   trades: TradeRow[],
   heliusTxs: HeliusTransaction[],
-  walletAddress: string,
-  currentState: WalletState
+  walletAddress: string
 ): WalletMetrics {
```

**Note:** Keep the `WalletState` type import — it's still used elsewhere (`state: WalletState` field, `deriveState` return type).

**Verification:** `npm run typecheck` (catches missed callers), `npm test`.

### Task 3 — `src/jobs/webhook-health.ts` (Major)

**Problem:** Lines 29-43: when `wallets.listActive()` is transiently empty, the heal path bails and fires a CRITICAL Discord alert — even when Helius returned a usable `webhook.accountAddresses`. Turns a recoverable outage into a manual one.

**Fix:** Prefer active addresses; fall back to `webhook?.accountAddresses` before bailing. Only send the CRITICAL skip alert if BOTH sources are empty.

```diff
-  const addresses = wallets ? wallets.listActive().map((w) => w.address) : [];
+  const activeAddresses = wallets ? wallets.listActive().map((w) => w.address) : [];
   const needsHeal = !webhook || isDisabled(webhook) || (webhook.accountAddresses?.length ?? 0) === 0;

   if (needsHeal) {
+    // If our local active list is transiently empty, prefer the webhook's
+    // last-known-good addresses over bailing. Only the BOTH-empty case is
+    // truly unrecoverable and warrants a CRITICAL alert.
+    const addresses = activeAddresses.length > 0
+      ? activeAddresses
+      : (webhook?.accountAddresses ?? []);
     if (addresses.length === 0) {
       logger.error({ webhookId }, "webhook-health: refusing to heal with empty wallet list — would unsubscribe the bot");
```

**Verification:** `npm run typecheck`, `npm test`.

### Task 4 — `src/engine/convergence.ts` (Major, partial)

**Problem (real bug):** The alpha-boost path at line 98 calls `pickTier(scoreForTier(boosted), uniqueWallets.size, boosted)` which uses `uniqueWallets.size` (the wide-window count) and `getMinWalletsForTier` (a static floor) — but never re-applies the **iterative narrow-window downgrade loop** that the initial path runs at lines 61-68. So a CRITICAL boost can produce a tier whose 30-min narrow window has fewer wallets than `getMinWalletsForTier(CRITICAL)=3`.

**Decision (do NOT change):** Use `scoreForTier(boosted)` instead of the actual penalized `score`. The boost is *intentionally* a trust signal that overrides score — that's the whole point of `hasTopAlpha`. The two existing tests in `convergence-quality-gate.test.ts` ("boosts WATCH to NOTABLE", "boosts mixed... to CRITICAL") encode this intent; both pass with `scoreForTier(boosted)` as the input. CodeRabbit flags this but the project's design says raw score doesn't fully capture alpha quality. Keep it.

**Fix:** Extract a `validateTierWindow(candidate, score, recentBuys, windowSeconds)` helper that walks down the tier ladder enforcing both the score floor and the tier-specific narrow-window wallet floor. Use it in both places:

1. Replace the existing iterative downgrade loop (lines 57-68).
2. Replace `pickTier(scoreForTier(boosted), uniqueWallets.size, boosted)` with `validateTierWindow(boosted, scoreForTier(boosted), recentBuys, windowSeconds)` so the boost goes through the same window-floor check.

```ts
// New helper (place near scoreForTier):
function validateTierWindow(
  candidate: ConvergenceTier,
  score: number,
  recentBuys: TradeRow[],
  windowSeconds: number
): ConvergenceTier {
  let tier = candidate;
  while (true) {
    if (score < scoreForTier(tier)) {
      if (tier === "CRITICAL") { tier = "NOTABLE"; continue; }
      if (tier === "NOTABLE") { tier = "WATCH"; continue; }
      return "WATCH";
    }
    const tierWindowSeconds = tier === "CRITICAL" ? 30 * 60 : tier === "NOTABLE" ? 60 * 60 : windowSeconds;
    if (tierWindowSeconds >= windowSeconds) return tier;
    const tierSince = Math.floor(Date.now() / 1000) - tierWindowSeconds;
    const tierWallets = new Set(recentBuys.filter((t) => t.block_time >= tierSince).map((t) => t.wallet_address));
    if (tierWallets.size >= getMinWalletsForTier(tier)) return tier;
    if (tier === "CRITICAL") { tier = "NOTABLE"; continue; }
    if (tier === "NOTABLE") { tier = "WATCH"; continue; }
    return "WATCH";
  }
}
```

Replace lines 55-68:
```ts
let tier = pickTier(score, uniqueWallets.size);
tier = validateTierWindow(tier, score, recentBuys, windowSeconds);
```

Replace boost (lines 96-100):
```ts
if (hasTopAlpha) {
  const boosted = tier === "WATCH" ? "NOTABLE" : tier === "NOTABLE" ? "CRITICAL" : tier;
  // Boost is intentionally not gated on actual penalized score — alpha
  // presence IS the trust signal we don't get from raw score. We pass through
  // validateTierWindow so the boosted tier's narrow-window wallet floor is
  // still enforced (closes the window-floor bypass without breaking the
  // score-override that defines the boost).
  tier = validateTierWindow(boosted, scoreForTier(boosted), recentBuys, windowSeconds);
  logger.info({ token: newTrade.tokenMint, avgPnl, hasTopAlpha: true, tier }, "tier boosted by alpha trigger (re-validated against narrow-window floor)");
}
```

**Crucial test-data note:** The two existing tier-boost tests rely on `FIRST_TRADE_OFFSET_SEC = CONVERGENCE_WINDOW_SECONDS - 10 = 7190` (alpha trade anchored at the WATCH-window edge). With the new `validateTierWindow`, those tests will fail because the alpha is outside the 30-min/60-min narrow windows. **Update the test fixture:**

```diff
-// Convergence engine's WATCH window is 7200s (2h). Anchor the first trade just
-// inside that window so it's still counted, while subsequent trades are recent.
-const CONVERGENCE_WINDOW_SECONDS = 7200;
-const FIRST_TRADE_OFFSET_SEC = CONVERGENCE_WINDOW_SECONDS - 10;
+// Anchor every trade well inside the CRITICAL 30-min narrow window so the
+// alpha-boost path is exercised cleanly. Post-bugfix, the boost revalidates
+// against the boosted tier's narrow-window wallet floor; trades on the
+// WATCH-window edge would never satisfy CRITICAL/NOTABLE floors regardless
+// of alpha presence.
+const FIRST_TRADE_OFFSET_SEC = 60;
```

This keeps the test SEMANTICS (boost works) and matches reality (real convergences cluster recently, not on the 2h edge).

**Expected results after fix:**
- Test "boosts WATCH to NOTABLE": 2 wallets in 60-min window → NOTABLE floor 2 OK → returns NOTABLE ✓
- Test "boosts mixed... to CRITICAL": 3 wallets in 30-min window → CRITICAL floor 3 OK → returns CRITICAL ✓

**Verification:** `npm run typecheck`, `npm test` (all 67 must pass).

## Verification & Ship Sequence

After all 4 tasks applied:

1. `npm run typecheck` — must be clean
2. `npm test` — must show 67/67 (or higher; mev-filter.test.ts may remain at 3 tests)
3. `npm run build` — must produce dist/ without errors
4. `launchctl kickstart -k gui/501/com.nassim.whale-watcher` — restart service
5. Verify PID changed via `launchctl list | grep whale-watcher`
6. E2E sanity: `curl -s https://whale-watcher.tail-scale.ts.net/healthz` returns 200, no-auth POST to `/webhooks/helius` returns 401
7. `git add -A` — verify staged files match expected list (7 files):
   - `src/blockchain/helius-client.ts`
   - `src/engine/scorer.ts`
   - `src/jobs/wallet-scorer.ts`
   - `src/__tests__/mev-filter.test.ts`
   - `src/jobs/webhook-health.ts`
   - `src/engine/convergence.ts`
   - `src/__tests__/convergence-quality-gate.test.ts`
8. Commit with message:

```
fix(ww): fourth CodeRabbit pass — Helius silent-break, alpha-boost window leak, dead param

Findings addressed (4 valid; 3 skipped as already-fixed in 5a1df96, 1 deferred as premature):
- helius-client.getWalletTransactions: throw on 429/5xx instead of breaking silently;
  4xx-other still breaks pagination cleanly
- scorer.computeWalletMetrics: drop unused currentState param + 4 callers
- webhook-health: fall back to webhook.accountAddresses when active list transiently
  empty, only CRITICAL-alert if both sources empty
- convergence: extract validateTierWindow helper so the alpha-boost path enforces
  the boosted tier's narrow-window wallet floor (closes the leak without disabling
  the intentional score-override that defines the boost)
- test fixture: anchor convergence-quality-gate trades inside the 30-min window so
  tier-boost tests exercise the post-fix window revalidation

All gates green: npm typecheck/test/build, service restarted, E2E verified.
```

Stop conditions:
- All 4 tasks pass typecheck + tests
- If any task uncovers an unexpected failure, **stop and report** — do not invent new fixes outside the plan scope.
- Honor user's prior decisions: do NOT reinstate the score-floor gate on the alpha-boost path (intentional override).
