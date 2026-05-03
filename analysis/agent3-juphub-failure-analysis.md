# Agent 3 — JUPHUB Failure Analysis

## 1. Root Cause Analysis

### Primary cause: Silent price feed death = total stop loss bypass

`getPriceUsd()` in `jupiter-client.ts:82-103` catches ALL exceptions and returns `null`. The position manager loop at line 127 does `if (price === null || price <= 0) continue` — it silently skips the position entirely. No counter, no alert, no escalation. The position becomes **invisible to every single risk control** for as long as the feed is dead.

This is not a price feed problem. It is an **architectural failure**: the system treats "I cannot see the price" identically to "everything is fine, check again later." In risk management, inability to observe = maximum danger, not zero danger.

### Secondary cause: Rug detection has a hard time wall

`isRugEmergency()` at line 215 requires `now - position.opened_at <= RUG_WINDOW_SECONDS` (5 min). A -99% drop at minute 6 is not a rug — it is "normal" per this logic. The rug detector protects against instant rugs only; slow rugs (drain over 10-60 min) pass through.

### Tertiary cause: No on-chain fallback pricing

The entire system depends on a single HTTP endpoint (`api.jup.ag/swap/v1/quote`). When that DNS died, there was zero fallback. The RPC connection to Helius (line 66-69) is already configured and could provide on-chain pricing via token accounts or Raydium/Orca pool reserves — but it is only used for balance checks and confirmations.

### Kill chain summary

```
Jupiter DNS dies → getPriceUsd returns null → position skipped →
price drops $0.40→$0.007 unobserved → DNS restored →
5min rug window long expired → hard stop sees -98% but FLAT_24H_EXIT
fires first at line 207-209 (6h+ elapsed, <5% move from current dead price)
```

---

## 2. Proposed Fixes (ranked by impact)

### FIX 1 — Price feed failure circuit breaker (CRITICAL)
**Impact: Blocks the exact kill chain that caused this loss**
**Complexity: Low**

In `checkOpenPositions()`, track consecutive null-price cycles per position. After N consecutive nulls (e.g., 5 = 2.5 minutes at 30s intervals), trigger a **PRICE_FEED_DEAD** emergency exit at 100% sell with `panicExit: true`.

Rationale: If you cannot price an asset for 2.5 minutes, the safe assumption is that something catastrophic is happening. In microcap Solana tokens, 2.5 minutes of blindness is an eternity. Exiting blind is better than holding blind.

Threshold: `MAX_CONSECUTIVE_NULL_PRICES = 5`. Store a `Map<positionId, number>` in-memory. Reset to 0 on any successful price fetch. On reaching threshold, call `this.exit(position, "PRICE_FEED_DEAD", 100, true)`.

Alternative for less aggressive behavior: after 3 consecutive nulls, use the **last known price** with a forced decay (e.g., assume -10% per missed cycle) and run stop loss checks against that synthetic price. This avoids false exits during brief API hiccups while still catching prolonged outages.

### FIX 2 — Remove time wall from rug detection (HIGH)
**Impact: Catches slow rugs that currently slip through**
**Complexity: Low**

Change `isRugEmergency()` to apply the -60% check at ALL times, not just within 5 minutes:

```
// Current: only fires in first 5 min
if (profitPct <= RUG_DROP_PCT && now - position.opened_at <= RUG_WINDOW_SECONDS) return true;

// Proposed: always fires, rug is rug regardless of timing
if (profitPct <= RUG_DROP_PCT) return true;
```

A -60% drop is catastrophic whether it happens at minute 2 or minute 45. The hard stop (-25% to -45%) should theoretically catch it before -60%, but if it doesn't (as in this incident due to price gaps), the rug detector is the last safety net and should not have a time limit.

The `RUG_WINDOW_SECONDS` constant can be repurposed: within the window, use lower threshold (e.g., -40% instead of -60%) and `panicExit: true` (higher slippage tolerance). After the window, keep the -60% threshold with normal exit.

### FIX 3 — Price feed redundancy via on-chain RPC (HIGH)
**Impact: Eliminates single point of failure**
**Complexity: Medium**

Add a fallback price source in `getPriceUsd()` that queries on-chain data via the existing Helius RPC connection when the Jupiter API fails. Two options:

- **Option A (simpler):** Use Helius DAS API `getAssetsByOwner` or token price endpoints if available with the existing API key.
- **Option B (robust):** Query Raydium/Orca AMM pool accounts on-chain, read reserves from account data, compute price from constant-product formula. This works even if every HTTP API is down — it only needs the Solana RPC.

Implementation: in the `catch` block of `getPriceUsd()`, before returning null, attempt the fallback. Log a warning when falling back so the operator knows the primary feed is degraded.

### FIX 4 — Global price feed health monitor with alerts (MEDIUM)
**Impact: Enables human intervention before losses compound**
**Complexity: Low**

Track the last successful price fetch timestamp globally. If no successful fetch for ANY position in 2 minutes, emit a CRITICAL alert (push notification, log, webhook). This is independent of Fix 1 — Fix 1 auto-exits, Fix 4 alerts the operator.

Store `lastSuccessfulPriceFetchAt` as a class field in PositionManager. Update it on every successful `getPriceUsd` call. Check it at the start of each `checkOpenPositions` tick.

### FIX 5 — Staleness-based forced re-entry check (MEDIUM)
**Impact: Prevents holding positions you cannot monitor**
**Complexity: Medium**

Track `last_priced_at` per position in the database. In `onPriceUpdate`, set it to `now`. Add a new exit check: if `now - last_priced_at > STALE_POSITION_MAX_SECONDS` (e.g., 10 minutes), exit with reason `STALE_PRICE_EXIT`.

This is a belt-and-suspenders complement to Fix 1. Fix 1 catches consecutive nulls in real-time. Fix 5 catches the case where the position manager itself was down/restarted and the position has been unmonitored.

### FIX 6 — Position sizing based on token risk tier (LOW priority, HIGH long-term value)
**Impact: Caps maximum dollar loss per position**
**Complexity: Medium**

Currently, position sizing is not visible in the position manager (it's upstream in trade-executor). Add a max position size rule:
- WATCH tier: max $50 (these are speculative, high-risk)
- NOTABLE tier: max $150
- CRITICAL tier: max $300 (highest conviction whale convergence)

Even with perfect risk controls, a -98% loss on a $50 position is $49. On a $500 position it's $490. Position sizing is the risk control that works even when all other controls fail.

---

## 3. What NOT to Do

### DO NOT add more price API endpoints without a circuit breaker
Adding Birdeye, DexScreener, CoinGecko as fallbacks creates complexity without solving the core issue. If all APIs fail simultaneously (network issue, machine DNS issue), you're back to the same problem. Fix 1 (circuit breaker on null prices) must come first. Fallback APIs are a nice-to-have complement, not a replacement.

### DO NOT tighten stop losses aggressively
Knee-jerk reaction: "set hard stop to -10%." Microcap Solana tokens routinely swing -15% to -25% intraday before recovering. Tightening stops to -10% or -15% would cause constant stop-outs on positions that would have been profitable. The current -25% to -45% ATR-based range is reasonable. The problem was not the stop level — it was that the stop never fired because no price was available.

### DO NOT increase polling frequency
Changing from 30s to 5s polling seems intuitive but: (a) it doesn't help when the API is dead — you'd just get null faster, (b) it increases Jupiter API load 6x, risking rate limits, (c) 30s is already adequate for the asset class. The polling frequency was not the failure mode.

### DO NOT add complex "price prediction" or "extrapolation" logic
"If the last 3 prices were declining, extrapolate the trajectory" — this adds fragile heuristics that will false-positive constantly. The fix is binary: either you have a price and act on it, or you don't have a price and you exit (Fix 1). No interpolation needed.

### DO NOT remove the FLAT_24H_EXIT
It's tempting to view it as the villain since it was the exit reason. It's actually the last safety net that DID work — it eventually closed a doomed position. The problem was everything that should have fired before it. FLAT_24H_EXIT is correct behavior for positions that genuinely go sideways.

### DO NOT over-engineer the rug detector with ML/heuristics
"Detect rug patterns from transaction volume, holder count changes, social sentiment." Each of these is a months-long project with its own failure modes. The 80/20 fix is: remove the time wall (Fix 2) and add the circuit breaker (Fix 1). These two changes would have prevented 100% of the JUPHUB loss with zero new dependencies.

---

## Priority Implementation Order

1. **Fix 1** — Circuit breaker (null price counter → emergency exit). Ship today.
2. **Fix 2** — Remove rug detector time wall. Ship today.
3. **Fix 4** — Alert on global price feed death. Ship today.
4. **Fix 3** — On-chain price fallback. Ship this week.
5. **Fix 5** — Staleness tracking per position. Ship this week.
6. **Fix 6** — Position sizing caps. Ship when moving toward live trading.
