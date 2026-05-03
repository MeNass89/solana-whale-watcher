# JUPHUB Failure Analysis — Agent 1

## 1. Root Cause Analysis

### Primary cause: Silent price feed death with no fallback behavior

The entire risk management stack depends on a single function call chain: `setInterval(30s)` -> `checkOpenPositions()` -> `getPriceUsd()` -> Jupiter Quote API. When `getPriceUsd` returns `null`, line 127 of `position-manager.ts` executes `continue`, silently skipping the position. No counter, no alert, no escalation. The position becomes invisible to every protection layer simultaneously.

**Specific failure sequence:**
1. Jupiter Price API (`api.jup.ag/swap/v1/quote`) went dead (DNS failure).
2. `getPriceUsd()` catches the fetch error and returns `null` (jupiter-client.ts, catch block at end of `getPriceUsd`).
3. `checkOpenPositions()` hits `if (price === null || price <= 0) continue` — skips the position entirely.
4. No stop loss, no rug detection, no trailing stop, no take profit — nothing evaluates.
5. JUPHUB drops from $0.40 to $0.007 during the blind window.
6. When the API is restored, the position is at -98%. The 5-minute rug window (`RUG_WINDOW_SECONDS = 300`) expired hours ago. The hard stop fires, but only after the damage.
7. `FLAT_24H_EXIT` eventually catches it at the 24h mark as the final safety net.

### Secondary cause: Rug detection has a hard time window that creates a cliff

`isRugEmergency` (line 213-217) requires `now - position.opened_at <= RUG_WINDOW_SECONDS` (5 minutes). A -99% drop at minute 6 is invisible to rug detection. This is a design flaw independent of the price feed failure — a slow rug that develops over 10-30 minutes evades it too.

### Tertiary cause: No price feed health monitoring

There is zero observability on price feed health. No counter for consecutive null returns, no Discord alert when the feed is down, no health endpoint. The system was blind and nobody knew.

---

## 2. Proposed Fixes (Ranked by Impact)

### Fix 1: Consecutive null price escalation with forced exit
**Impact: CRITICAL** | **Complexity: Low**

Track consecutive null price returns per position. After N consecutive nulls (e.g., 5 = 2.5 minutes at 30s intervals), trigger a `PRICE_FEED_DEAD` emergency exit using the last known price from the DB (`current_price_usd`).

**Logic change in `checkOpenPositions()`:**
- Replace the bare `continue` with a counter increment per position ID.
- On successful price fetch, reset the counter to 0.
- At threshold (5 consecutive nulls), call `this.exit(position, "PRICE_FEED_DEAD", 100, true)` using `position.current_price_usd` as the exit price.
- At lower threshold (3 consecutive nulls), send a Discord alert.

**Rationale:** If you can't price a position for 2.5 minutes straight, the position is un-manageable. Exiting at last known price is strictly better than holding blind. Even if the exit price is stale, it's better than a -98% realized loss.

### Fix 2: Remove the time window from rug detection (make it perpetual)
**Impact: HIGH** | **Complexity: Low**

Change `isRugEmergency` to fire at any age, not just within 5 minutes. A -60% drop is a rug whether it happens at minute 3 or minute 30.

**Specific change:** Remove the `now - position.opened_at <= RUG_WINDOW_SECONDS` condition from line 215. Keep the `-60%` threshold. The hard stop at -25% to -45% already covers gradual declines — rug detection is for catastrophic drops at any point in the position's life.

**Rationale:** The time window was presumably meant to avoid false positives from volatile but legitimate tokens. But `RUG_DROP_PCT = -60` is already extreme — no legitimate token drops 60% without being a rug or black swan. In either case, you want to exit.

### Fix 3: Price feed redundancy — fallback to DexScreener or Birdeye
**Impact: HIGH** | **Complexity: Medium**

Add a secondary price source in `getPriceUsd`. When Jupiter returns null, try DexScreener API (`api.dexscreener.com/latest/dex/tokens/{mint}`) or Birdeye (`public-api.birdeye.so/defi/price?address={mint}`). Both are free-tier and return prices for Solana tokens.

**Implementation:** Waterfall pattern inside `getPriceUsd`:
1. Try Jupiter quote API (current)
2. On failure, try DexScreener
3. On failure, try Birdeye
4. On failure, return null (existing behavior, but now 3 sources must all fail)

**Rationale:** Single point of failure on a critical data feed is unacceptable. Jupiter's DNS died once — it will happen again. Two independent backup sources make a total outage near-impossible.

### Fix 4: Price feed health monitor with Discord alerting
**Impact: MEDIUM** | **Complexity: Low**

Add a global counter for consecutive price feed failures (across all tokens, not per-position). When >50% of open positions return null in a single tick, fire a `PRICE_FEED_DEGRADED` Discord alert. When 100% return null for 2+ consecutive ticks, fire a `PRICE_FEED_DEAD` critical alert.

**Rationale:** Even with Fix 1's auto-exit, the operator needs visibility. A dead price feed might indicate a broader infrastructure issue (DNS, network, API deprecation) that requires human intervention.

### Fix 5: Stale price age check — time-bomb on last successful price
**Impact: MEDIUM** | **Complexity: Low**

Store `last_price_updated_at` in the positions table. On each successful price fetch, update this timestamp. In the position check loop, if `now - last_price_updated_at > MAX_STALE_PRICE_SECONDS` (e.g., 300s = 5 min), treat it as a stale price emergency and either:
- Exit at last known price, OR
- Apply a synthetic worst-case price (last price * 0.5) and evaluate stop losses against that

**Rationale:** This is a belt-and-suspenders complement to Fix 1. Even if the counter logic has a bug, the timestamp check independently catches stale data. Defense in depth.

### Fix 6: ATR-adaptive rug window instead of fixed 5 minutes
**Impact: LOW** | **Complexity: Medium**

If you keep the rug window concept (rather than Fix 2's removal), make it proportional to the token's volatility profile. High-ATR tokens get a shorter window (rugs happen fast). Low-ATR tokens get a longer window (legitimate but slow-moving tokens).

**Rationale:** A fixed 5-minute window is arbitrary. But this is moot if Fix 2 is implemented — perpetual rug detection at -60% is simpler and more robust.

---

## 3. What NOT To Do

### Do NOT tighten stop losses aggressively as a knee-jerk reaction
The hard stop at -25% to -45% (ATR-adjusted) is well-designed. Tightening it to -10% or -15% will dramatically increase false-positive exits on volatile Solana tokens. The JUPHUB loss was not caused by loose stops — it was caused by stops not evaluating at all. Fix the price feed, not the thresholds.

### Do NOT add more price poll frequency (e.g., every 5 seconds)
Polling every 5 seconds instead of 30 doesn't help if the API is dead — you'll just get null 6x faster. The problem is the reaction to null, not the polling rate. Faster polling also risks rate limiting on Jupiter's API.

### Do NOT add on-chain price verification for every tick
Fetching on-chain pool reserves via RPC for every position every 30 seconds is expensive, slow, and fragile. The Helius RPC is already used for webhooks — adding heavy price polling will hit rate limits. Reserve on-chain checks for entry validation (one-time) or as a last-resort fallback, not as primary price feed.

### Do NOT disable paper trading or rush to live to "test properly"
Paper trading correctly exposed this failure. The fix is to make paper trading's price feed resilient, not to skip paper mode. Every flaw found in paper mode is a flaw that didn't cost real money.

### Do NOT add complex ML-based rug prediction
The failure was a simple engineering oversight (no fallback on null price). Adding a prediction model adds complexity, maintenance burden, and false confidence. Fix the plumbing first. Consider ML only after the basic risk controls are bulletproof.

### Do NOT remove the FLAT_24H_EXIT
It was the only thing that eventually closed this position. It's a valid last-resort safety net. Keep it.

---

## 4. Implementation Priority

| Order | Fix | Lines of code | Risk of regression |
|-------|-----|--------------|-------------------|
| 1 | Consecutive null escalation (Fix 1) | ~25 | Very low |
| 2 | Perpetual rug detection (Fix 2) | ~1 | Very low |
| 3 | Price feed health alerting (Fix 4) | ~20 | None |
| 4 | Stale price age check (Fix 5) | ~15 | Low |
| 5 | Price feed redundancy (Fix 3) | ~40 | Low |
| 6 | ATR-adaptive rug window (Fix 6) | ~15 | Low |

Fixes 1+2+4 together close the JUPHUB failure mode completely and can be implemented in a single session. Fix 3 (redundancy) is a medium-term improvement that prevents the root cause entirely.
