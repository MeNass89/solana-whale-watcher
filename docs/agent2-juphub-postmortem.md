# Agent 2 -- JUPHUB Postmortem Analysis

## 1. Root Cause Analysis

Three independent failures compounded into a single catastrophic loss. Any one of them, if addressed, would have prevented the -98%.

### Failure A: Price Feed Single Point of Failure (PRIMARY)

- `getPriceUsd()` in `jupiter-client.ts:82` has exactly one data source: the Jupiter quote API (`api.jup.ag/swap/v1/quote`).
- When the API goes down (DNS failure, 5xx, timeout), the method returns `null` (line 100-101: bare `catch { return null }`).
- The position manager loop at line 126-127 treats `null` as "no data, skip this position": `if (price === null || price <= 0) continue`.
- **There is zero tracking of consecutive null returns.** The system silently skips a position indefinitely. No alert, no counter, no fallback action.
- **This is the lethal flaw.** The price feed died, every 30-second tick returned null, every tick skipped the position, and the token dropped from $0.40 to $0.007 completely unobserved.

### Failure B: Rug Detection Window Too Narrow

- `isRugEmergency()` at line 215: `if (profitPct <= RUG_DROP_PCT && now - position.opened_at <= RUG_WINDOW_SECONDS)` -- the `RUG_WINDOW_SECONDS = 5 * 60` constraint means the rug check is dead after 5 minutes.
- A slow rug (30-60 min) or a rug that begins after 5 minutes is invisible to this check.
- The hard stop at -25% to -45% is the *intended* backstop, but it depends entirely on price feed availability (Failure A).

### Failure C: No "Stale Price" Circuit Breaker

- Position rows store `current_price_usd` and `peak_price_usd`, updated on every successful tick (line 254-261).
- When price is null, these values are never updated -- but crucially, **there is no timestamp on the last successful price update**.
- The system cannot distinguish between "price checked 30 seconds ago" and "price hasn't been checked in 6 hours."
- The FLAT_24H_EXIT at line 207-210 eventually caught it, but only because `Math.abs(profitPct) < FLAT_MOVE_PCT` happened to be false-positive on a -98% position (it checks against entry price, and by then the token was flat... at the bottom).

**Correction on FLAT_24H_EXIT trigger:** Re-reading line 207, the check is `Math.abs(profitPct) < FLAT_MOVE_PCT` (i.e., < 5%). At -98%, this condition is FALSE. So FLAT_24H_EXIT should NOT have triggered via this path. Either: (a) the exit was triggered by the TIME_STOP at line 203, or (b) the exit label was set incorrectly. This discrepancy deserves investigation.

---

## 2. Proposed Fixes (Ranked by Impact)

### Fix 1: Consecutive Null Price Circuit Breaker
**Impact: CRITICAL | Complexity: LOW**

In `checkOpenPositions()`, track consecutive null returns per position. After N consecutive nulls (e.g., 5 = 2.5 minutes at 30s intervals), trigger an emergency exit at the last known price.

Logic change in position-manager.ts:
- Add a `Map<number, number>` field: `private nullPriceCount = new Map<number, number>()`
- On successful price: `this.nullPriceCount.set(position.id, 0)`
- On null price: increment counter. If counter >= `MAX_NULL_PRICE_TICKS` (suggest 5):
  - Use `position.current_price_usd` (last known price) to evaluate stop loss
  - If last known price is also null, exit at entry price with reason `PRICE_FEED_DEAD_EXIT`
  - Send an alert regardless

**Rationale:** This is the single change that would have prevented the JUPHUB loss entirely. Even if the exit price is stale, exiting at -25% (last known) beats exiting at -98%.

### Fix 2: Price Feed Redundancy
**Impact: HIGH | Complexity: MEDIUM**

Add at least one fallback price source to `getPriceUsd()`. Candidates:
1. **Birdeye API** (`public-api.birdeye.so/defi/price`) -- free tier, no auth needed for basic price
2. **DexScreener API** (`api.dexscreener.com/latest/dex/tokens/{mint}`) -- free, no auth
3. **On-chain Raydium/Orca pool reserves** via RPC (zero external dependency, but more complex)

Implementation: try-catch cascade in `getPriceUsd()`. Jupiter first, then Birdeye, then DexScreener. Log which source was used.

**Rationale:** Single-source price feeds are unacceptable for a trading system. The Jupiter API has already proven it can go fully offline.

### Fix 3: Remove Time Window from Rug Detection
**Impact: HIGH | Complexity: LOW**

Change `isRugEmergency()` to check the drop percentage WITHOUT the time constraint, or extend the window significantly:

Current: `profitPct <= -60 && age <= 300s`
Proposed: `profitPct <= -60` (no time constraint) OR `profitPct <= -80` (no time constraint, separate threshold for older positions)

A -60% drop is an emergency regardless of when it happens. The time window was likely added to avoid false positives on volatile tokens that recover, but a -60% drop from entry should always trigger at minimum a partial exit.

**Rationale:** The existing hard stop (-25% to -45%) should catch drops before they reach -60%. The rug check is a *backstop* for when the hard stop fails (as it did here). Backstops should not have the same failure modes as the primary control.

### Fix 4: Last-Price-Update Timestamp + Stale Alert
**Impact: MEDIUM | Complexity: LOW**

Add a `last_price_updated_at` column to the positions table. On each successful price update, set it. In the check loop, if `now - last_price_updated_at > STALE_THRESHOLD` (e.g., 3 minutes), emit a WARNING-level alert to Telegram/Discord.

This is defense-in-depth: even if Fix 1's circuit breaker has a bug, the operator gets alerted.

### Fix 5: Mandatory Exit on Extended Price Blindness
**Impact: MEDIUM | Complexity: LOW**

Separate from Fix 1's per-position counter: a global watchdog. If ALL open positions return null prices for > 5 minutes, the system should:
1. Send a CRITICAL alert ("Price feed completely dead")
2. After 10 minutes of total blindness, force-exit all positions at last known prices
3. Halt new entries until price feed is confirmed restored

**Rationale:** A full price feed outage is qualitatively different from one token being unquotable. It requires a system-level response.

### Fix 6: Pre-Entry Token Quality Filter
**Impact: MEDIUM | Complexity: MEDIUM**

Before opening a position, verify:
- Token has been quoted successfully at least 3 times in the last 10 minutes (proves price feed works for this token)
- Liquidity is above a minimum threshold (e.g., $50K)
- Token age > 1 hour (avoid tokens so new they have no price history)

This wouldn't have prevented JUPHUB specifically (the price feed died after entry), but it reduces exposure to tokens that are hard to price.

### Fix 7: Position-Level Max Loss Cap
**Impact: LOW-MEDIUM | Complexity: LOW**

Add a hard floor that operates on the stored `current_price_usd` independently of live price:

On each tick where price IS available, if `profitPct <= -50%`, exit immediately regardless of ATR or time window. This is a "never lose more than 50%" rule that overrides all other logic.

Current hard stop ceiling is -45% but it depends on ATR config and price availability. This would be a non-negotiable, non-configurable absolute floor.

---

## 3. What NOT to Do

### Do NOT reduce the 30-second poll interval to "catch drops faster"
The problem was not poll frequency. It was that null prices silently skipped positions. Polling every 5 seconds with the same null-skip logic changes nothing. It just increases API load and makes the null problem harder to notice in logs.

### Do NOT add more stop-loss tiers without fixing the null-price blind spot
Adding a -15% stop, a -10% stop, a -5% stop -- none of these matter if the price feed is dead. Every stop-loss in the system shares the same failure mode: they all require a non-null price to evaluate. Fix the null-price handling FIRST.

### Do NOT switch to WebSocket price feeds as the sole fix
WebSockets feel more "real-time" but introduce their own failure modes: silent disconnections, stale last-message, reconnection storms. They're fine as an ADDITIONAL source, but they don't solve the fundamental problem of "what happens when the feed goes dark." The circuit breaker (Fix 1) is still needed.

### Do NOT over-tighten stop losses to compensate
Knee-jerk tightening (e.g., hard stop from -25% to -10%) will dramatically increase false-positive exits on volatile Solana tokens. The JUPHUB loss was not caused by loose stops -- it was caused by stops that never evaluated. Tightening stops while the null-price bug exists is security theater.

### Do NOT add position sizing based on this single incident
Position sizing (e.g., "never risk more than 2% of portfolio per trade") is sound risk management in general, but it's a separate concern from this failure. Implementing it now risks conflating two problems and delaying the critical fix (null-price circuit breaker). Do it later as a separate improvement.

### Do NOT remove the FLAT_24H_EXIT
It's the only thing that eventually closed this position. It's a blunt instrument but it works as a last resort. Improve the earlier exits, don't remove the backstop.
