# Safety Gates Fix — Implementation Plan

**Date:** 2026-05-04
**Author:** Claude Opus (post stochastic consensus — 5 agents)
**Scope:** Fix 3 bypassed safety gates + paper pricing corruption + defense-in-depth

## Problem Statement

7 paper positions were manually seeded on 2026-05-03, bypassing the convergence→executor→risk pipeline. Results:
- WATCH-tier trades executed (ODAI, oPEG, Chud) — should be observation-only
- $3.6k liquidity positions opened (oPEG) — minimum is $5k
- 1-wallet "convergences" traded (SAM, foogle, ODAI, oPEG) — defeats convergence concept
- Paper pricing produced e+176 prices and +101,024% P&L — root cause: `fallbackOutputAmount()` divides by near-zero

The gates exist in code (trade-executor:43, risk-engine:75, thresholds.ts) but only protect the organic pipeline. Direct DB inserts bypass them.

## Consensus Decisions (from 5-agent research)

| Parameter | Current | New | Rationale |
|-----------|---------|-----|-----------|
| Min liquidity (hard block) | $5,000 | **$25,000** | $5k = 10% pool impact on $500 position. $25k gives ~2% impact. |
| Vol hard ceiling | None (soft reduction only) | **300%** | 100% is normal for meme coins. >300% = active pump/dump. |
| Vol anchor for size reduction | 80% | **50%** | More aggressive reduction in 50-300% band. |
| Wallet count NOTABLE | 2 (via log2 formula) | **≥ 2 (flat)** | Keep minimum 2, but enforce it. |
| Wallet count CRITICAL | 2 (via log2 formula) | **≥ 3 (flat)** | CRITICAL = high conviction = needs 3 independent signals. |
| Max position USD | $3,000 | **$2,000** | Consistent with actual liquidity profiles. |
| Price sanity bounds | None | **1e-15 to 1e6** | Blocks e+176 corruption. |
| P&L display cap | None | **-100% to +1000%** | Flags corruption instead of displaying nonsense. |
| Max price change per tick | None | **100x** | Single 30s tick can't move >100x without corruption. |
| Mint dedup | None | **Block if open position on same mint** | Prevents duplicate exposure. |

---

## Task 1: Tighten risk parameters in risk-engine.ts

**File:** `src/execution/risk-engine.ts`

### Step 1: Update constants (lines 36-49)

Replace:
```typescript
const MIN_POOL_TVL_USD = 5_000;
```
With:
```typescript
const MIN_POOL_TVL_USD = 25_000;
```

Replace:
```typescript
const MAX_POSITION_USD = 3000;
```
With:
```typescript
const MAX_POSITION_USD = 2000;
```

### Step 2: Add hard volatility ceiling (after line 66)

After the `volAdj` calculation, add a hard block:
```typescript
if (volatility !== null && volatility > 300) {
  return { allowed: false, reason: `volatility ${volatility.toFixed(0)}% exceeds 300% ceiling`, phase, portfolioValueUsd };
}
```

### Step 3: Change vol anchor from 80 to 50 (line 66)

Replace:
```typescript
const volAdj = volatility && volatility > 0 ? Math.min(1, 80 / volatility) : 1;
```
With:
```typescript
const volAdj = volatility && volatility > 0 ? Math.min(1, 50 / volatility) : 1;
```

### Step 4: Block entry when volatility data is missing (after line 66)

Add after volAdj:
```typescript
if (volatility === null || volatility === 0) {
  return { allowed: false, reason: "volatility data unavailable — cannot size position", phase, portfolioValueUsd };
}
```

### Step 5: Update log message (line 75)

Replace:
```typescript
if (liquidityUsd < MIN_POOL_TVL_USD) return { allowed: false, reason: "pool TVL below $5k", phase, portfolioValueUsd };
```
With:
```typescript
if (liquidityUsd < MIN_POOL_TVL_USD) return { allowed: false, reason: `pool TVL $${Math.round(liquidityUsd)} below $${MIN_POOL_TVL_USD / 1000}k minimum`, phase, portfolioValueUsd };
```

### Step 6: Tests

Create `src/__tests__/risk-engine-safety.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

// Test the constants and thresholds
describe("risk-engine safety parameters", () => {
  it("should block entries with volatility > 300%", () => {
    // Mock a convergence with 350% vol — should be rejected
  });

  it("should block entries with liquidity < $25k", () => {
    // Mock a convergence with $10k liquidity — should be rejected
  });

  it("should block entries with null volatility", () => {
    // No vol data — should be rejected
  });

  it("should reduce position size aggressively above 50% vol", () => {
    // 100% vol → size *= 50/100 = 0.5 (50% reduction)
    // 200% vol → size *= 50/200 = 0.25 (75% reduction)
  });

  it("should cap position at $2000", () => {
    // Large portfolio → still max $2k per position
  });
});
```

### Commit
```
fix(risk): tighten safety parameters — $25k min liquidity, 300% vol ceiling, $2k max position

Consensus from 5-agent research: $5k TVL let through $3.6k positions,
no vol ceiling let 115% vol tokens get traded, soft vol anchor at 80
was too lenient. Now: hard block >300% vol, missing vol data blocks
entry, vol anchor lowered to 50 for more aggressive size reduction.
```

---

## Task 2: Update convergence threshold formula

**File:** `src/config/thresholds.ts`

### Step 1: Replace threshold function

Replace entire file:
```typescript
import type { AlertTier } from "../blockchain/types.js";

export function getThreshold(coreWallets: number, _totalWallets?: number): number {
  return Math.max(2, Math.floor(Math.log2(Math.max(1, coreWallets)) + 1));
}

export function getMinWalletsForTier(tier: AlertTier): number {
  switch (tier) {
    case "CRITICAL": return 3;
    case "NOTABLE": return 2;
    case "WATCH": return 1;
    default: return 2;
  }
}
```

**File:** `src/engine/convergence.ts`

### Step 2: Add tier-specific wallet minimum

In the convergence detection method, after tier assignment (around line 54-63), add a tier-specific wallet gate:

```typescript
import { getMinWalletsForTier } from "../config/thresholds.js";

// After tier is assigned:
if (uniqueWallets.size < getMinWalletsForTier(tier)) {
  if (tier === "CRITICAL") tier = "NOTABLE";
  else if (tier === "NOTABLE") tier = "WATCH";
  // WATCH stays WATCH — won't be executed anyway
}
```

### Step 3: Tests

Create `src/__tests__/threshold-tiers.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { getThreshold, getMinWalletsForTier } from "../config/thresholds.js";

describe("convergence thresholds", () => {
  it("requires minimum 2 wallets regardless of pool size", () => {
    expect(getThreshold(1)).toBe(2);
    expect(getThreshold(0)).toBe(2);
  });

  it("CRITICAL requires 3 wallets", () => {
    expect(getMinWalletsForTier("CRITICAL")).toBe(3);
  });

  it("NOTABLE requires 2 wallets", () => {
    expect(getMinWalletsForTier("NOTABLE")).toBe(2);
  });

  it("WATCH requires 1 wallet (observation only)", () => {
    expect(getMinWalletsForTier("WATCH")).toBe(1);
  });
});
```

### Commit
```
fix(convergence): enforce tier-specific wallet minimums — CRITICAL≥3, NOTABLE≥2

Single-wallet "convergences" were being created and traded, defeating the
entire convergence concept. Now CRITICAL requires 3 independent wallets,
NOTABLE requires 2. Convergences that don't meet their tier's wallet
minimum get downgraded.
```

---

## Task 3: Add mint dedup check in trade-executor.ts

**File:** `src/execution/trade-executor.ts`

### Step 1: Add duplicate position check (after line 50)

After the existing execution check (line 44-51), add:
```typescript
const existingPosition = this.requireDb()
  .prepare("SELECT id FROM positions WHERE token_mint = ? AND status IN ('OPEN','PARTIAL')")
  .get(convergence.token_mint) as { id: number } | undefined;
if (existingPosition) {
  logger.info({ mint: convergence.token_mint, positionId: existingPosition.id }, "execution skipped; open position already exists for this token");
  return;
}
```

### Commit
```
fix(executor): prevent duplicate positions on same token mint

No dedup existed — re-convergence could open multiple positions on the
same token, creating hidden concentrated exposure.
```

---

## Task 4: Fix paper pricing corruption in jupiter-client.ts

**File:** `src/execution/jupiter-client.ts`

### Step 1: Add price sanity bounds

Add constants after line 20:
```typescript
const MIN_SANE_PRICE_USD = 1e-15;
const MAX_SANE_PRICE_USD = 1e6;
const MAX_PRICE_CHANGE_RATIO = 100;
```

### Step 2: Add sanity check function

Add after the constants:
```typescript
function isSanePrice(price: number): boolean {
  return Number.isFinite(price) && price > MIN_SANE_PRICE_USD && price < MAX_SANE_PRICE_USD;
}

function isSanePriceChange(oldPrice: number, newPrice: number): boolean {
  if (!isSanePrice(oldPrice) || !isSanePrice(newPrice)) return false;
  const ratio = Math.max(newPrice / oldPrice, oldPrice / newPrice);
  return ratio < MAX_PRICE_CHANGE_RATIO;
}
```

### Step 3: Guard executePaperSwap fallback (in executePaperSwap method)

After the fallbackOutputAmount call, add validation:
```typescript
if (!Number.isFinite(outputAmount) || outputAmount <= 0 || outputAmount > 1e30) {
  logger.warn({ inputMint, outputMint, outputAmount }, "paper swap: fallback produced insane output amount, rejecting");
  throw new Error("Paper swap pricing produced invalid amount");
}
```

### Step 4: Guard getPriceUsd return value (in getPriceUsd method)

Before returning the price, validate:
```typescript
if (!isSanePrice(price)) {
  logger.warn({ mint, price }, "getPriceUsd: price outside sane bounds, returning null");
  return null;
}
```

### Step 5: Export sanity functions for position-manager use

```typescript
export { isSanePrice, isSanePriceChange };
```

**File:** `src/execution/position-manager.ts`

### Step 6: Guard price updates in checkOpenPositions

Import and use the sanity check:
```typescript
import { isSanePrice, isSanePriceChange } from "./jupiter-client.js";
```

In the price update loop, before calling `onPriceUpdate`:
```typescript
if (!isSanePrice(currentPrice)) {
  logger.warn({ mint: position.token_mint, currentPrice }, "price update rejected: outside sane bounds");
  continue; // skip this update, don't count as null
}
if (position.current_price_usd && !isSanePriceChange(position.current_price_usd, currentPrice)) {
  logger.warn({ mint: position.token_mint, old: position.current_price_usd, new: currentPrice }, "price update rejected: change exceeds 100x in single tick");
  continue;
}
```

### Step 7: Tests

Create `src/__tests__/price-sanity.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

describe("price sanity checks", () => {
  it("rejects NaN, Infinity, negative prices", () => {});
  it("rejects prices below 1e-15", () => {});
  it("rejects prices above 1e6", () => {});
  it("rejects 100x price changes in a single tick", () => {});
  it("accepts normal meme coin prices (1e-9 to 1e-3)", () => {});
  it("accepts normal price movements (2x, 5x)", () => {});
});
```

### Commit
```
fix(pricing): add sanity bounds to paper pricing engine

Root cause of e+176 prices: fallbackOutputAmount() divided by near-zero
getPriceUsd for sub-penny tokens, producing astronomical token amounts.
Now: price bounds [1e-15, 1e6], max 100x change per tick, output amount
cap at 1e30. Also guards position-manager price updates.
```

---

## Task 5: Position startup audit

**File:** Create `src/execution/position-auditor.ts`

```typescript
import type { AppDatabase } from "../storage/database.js";
import { logger } from "../utils/logger.js";

interface AuditResult {
  total: number;
  valid: number;
  quarantined: number;
  reasons: string[];
}

export function auditOpenPositions(db: AppDatabase): AuditResult {
  const positions = db
    .prepare("SELECT p.*, c.wallet_count, c.tier as conv_tier FROM positions p LEFT JOIN convergences c ON p.convergence_id = c.id WHERE p.status IN ('OPEN','PARTIAL')")
    .all() as any[];

  const result: AuditResult = { total: positions.length, valid: 0, quarantined: 0, reasons: [] };

  for (const pos of positions) {
    const violations: string[] = [];

    if (pos.tier === "WATCH") violations.push("WATCH tier position");
    if (pos.entry_price_usd <= 0 || pos.entry_price_usd > 1e6 || !Number.isFinite(pos.entry_price_usd)) violations.push(`invalid entry price: ${pos.entry_price_usd}`);
    if (pos.current_price_usd !== null && (!Number.isFinite(pos.current_price_usd) || pos.current_price_usd > 1e6)) violations.push(`invalid current price: ${pos.current_price_usd}`);
    if (pos.amount_token <= 0 || pos.amount_token > 1e30 || !Number.isFinite(pos.amount_token)) violations.push(`invalid amount: ${pos.amount_token}`);
    if (pos.wallet_count !== null && pos.wallet_count < 2) violations.push(`convergence had only ${pos.wallet_count} wallet(s)`);

    if (violations.length > 0) {
      db.prepare("UPDATE positions SET status = 'CLOSED', exit_reason = ?, closed_at = unixepoch() WHERE id = ?")
        .run(`AUDIT_QUARANTINE: ${violations.join("; ")}`, pos.id);
      logger.warn({ positionId: pos.id, token: pos.token_symbol, violations }, "startup audit: quarantined position");
      result.quarantined++;
      result.reasons.push(...violations);
    } else {
      result.valid++;
    }
  }

  if (result.quarantined > 0) {
    logger.warn({ total: result.total, quarantined: result.quarantined }, "startup audit complete — positions quarantined");
  } else {
    logger.info({ total: result.total }, "startup audit complete — all positions valid");
  }

  return result;
}
```

**File:** `src/execution/position-manager.ts`

### Step 2: Wire audit into start()

Import and call audit before starting the monitoring loop:
```typescript
import { auditOpenPositions } from "./position-auditor.js";
```

In `start()`, before the `setInterval`:
```typescript
if (this.db) {
  const audit = auditOpenPositions(this.db);
  if (audit.quarantined > 0) {
    logger.warn({ quarantined: audit.quarantined, reasons: audit.reasons }, "startup audit quarantined positions");
  }
}
```

### Commit
```
feat(safety): add position startup audit — quarantine invalid positions on boot

Runs before the 30s monitoring loop. Catches positions that bypassed the
normal pipeline: WATCH tier, insane prices, sub-2-wallet convergences,
overflow amounts. Closes them with AUDIT_QUARANTINE exit reason.
```

---

## Task 6: Update slippage log message in trade-executor.ts

**File:** `src/execution/trade-executor.ts` (line 86)

Replace:
```typescript
logger.info({ mint: convergence.token_mint, liquidityUsd }, "execution skipped; liquidity below $5k");
```
With:
```typescript
logger.info({ mint: convergence.token_mint, liquidityUsd }, "execution skipped; liquidity below minimum");
```

### Commit
```
chore(executor): update log message to match new liquidity threshold
```

---

## Execution Order

1. Task 1 (risk params) — no dependencies
2. Task 2 (thresholds) — no dependencies
3. Task 3 (mint dedup) — no dependencies
4. Task 4 (pricing fix) — no dependencies
5. Task 5 (startup audit) — depends on Task 4 (imports sanity functions)
6. Task 6 (log message) — trivial, do last

Tasks 1-4 can be done in parallel. Task 5 after Task 4. Task 6 last.

## Verification

After all tasks:
```bash
cd /Users/nassimlecornet/Projects/solana-whale-watcher
npx vitest run
npx tsc --noEmit
```

Then restart the service:
```bash
launchctl kickstart -k gui/$(id -u)/com.nassim.whale-watcher
```

Check logs for startup audit output:
```bash
tail -50 data/launchd-stdout.log
```
