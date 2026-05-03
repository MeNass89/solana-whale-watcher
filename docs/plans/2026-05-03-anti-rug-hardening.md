# Anti-Rug Hardening — Implementation Plan

> **For agentic workers:** Execute tasks sequentially. Each task modifies specific files. Run `npx tsc --noEmit` after each task.

**Goal:** Prevent JUPHUB-class losses (-98%, $2948 on a $10k portfolio) by adding manipulation detection, tighter position sizing, and faster exits.

**Architecture:** 3-layer defense: (1) pre-entry manipulation filters block coordinated pumps, (2) hard position caps limit exposure, (3) aggressive stops cut losses early.

**Tech Stack:** TypeScript, better-sqlite3, Helius Enhanced API (already integrated).

---

### Task 1: Manipulation Detector Module

Create `src/engine/manipulation-detector.ts` — standalone module computing manipulation signals from existing data.

**Files:**
- Create: `src/engine/manipulation-detector.ts`

**Code:**

```typescript
import type { TradeRow } from "../storage/models/trades.js";
import type { WalletModel } from "../storage/models/wallets.js";
import type { AppDatabase } from "../storage/database.js";

export interface ManipulationSignals {
  timeClusteringScore: number;    // 0 = organic, 1 = perfectly synchronized
  sellPressureRatio: number;      // sells / (buys + sells) in window
  freshWalletFraction: number;    // fraction of wallets with < 15 trades or < 14 days old
  coOccurrenceScore: number;      // 0 = never seen together, 1 = always together
}

export function computeManipulationSignals(
  buys: TradeRow[],
  sells: TradeRow[],
  walletModel: WalletModel,
  db: AppDatabase
): ManipulationSignals {
  return {
    timeClusteringScore: computeTimeClustering(buys),
    sellPressureRatio: computeSellPressure(buys, sells),
    freshWalletFraction: computeFreshWalletFraction(buys, walletModel),
    coOccurrenceScore: computeCoOccurrence(buys, db),
  };
}

function computeTimeClustering(buys: TradeRow[]): number {
  if (buys.length < 3) return 0;
  const times = buys.map((b) => b.block_time);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const variance = times.reduce((s, t) => s + (t - mean) ** 2, 0) / times.length;
  const stddev = Math.sqrt(variance);
  // stddev < 30s = highly suspicious, > 600s = organic
  if (stddev >= 600) return 0;
  if (stddev <= 30) return 1;
  return 1 - (stddev - 30) / (600 - 30);
}

function computeSellPressure(buys: TradeRow[], sells: TradeRow[]): number {
  const total = buys.length + sells.length;
  if (total === 0) return 0;
  return sells.length / total;
}

function computeFreshWalletFraction(buys: TradeRow[], walletModel: WalletModel): number {
  const wallets = [...new Set(buys.map((b) => b.wallet_address))];
  if (wallets.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const fourteenDaysAgo = now - 14 * 86400;
  let freshCount = 0;
  for (const addr of wallets) {
    const w = walletModel.findByAddress(addr);
    if (!w) { freshCount++; continue; }
    if (w.added_at > fourteenDaysAgo || w.total_trades < 15) freshCount++;
  }
  return freshCount / wallets.length;
}

function computeCoOccurrence(buys: TradeRow[], db: AppDatabase): number {
  const wallets = [...new Set(buys.map((b) => b.wallet_address))];
  if (wallets.length < 3) return 0;
  // Count how many past convergences each pair co-appeared in
  const placeholders = wallets.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT ct.convergence_id, t.wallet_address
    FROM convergence_trades ct
    JOIN trades t ON t.id = ct.trade_id
    WHERE t.wallet_address IN (${placeholders})
    AND ct.convergence_id NOT IN (
      SELECT MAX(id) FROM convergences WHERE token_mint = (
        SELECT token_mint FROM trades WHERE id = ct.trade_id LIMIT 1
      )
    )
  `).all(...wallets) as Array<{ convergence_id: number; wallet_address: string }>;

  // Group by convergence, count pairs
  const byConv = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!byConv.has(row.convergence_id)) byConv.set(row.convergence_id, new Set());
    byConv.get(row.convergence_id)!.add(row.wallet_address);
  }

  let pairCoCount = 0;
  let totalPairs = 0;
  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      totalPairs++;
      let coCount = 0;
      for (const [, wSet] of byConv) {
        if (wSet.has(wallets[i]) && wSet.has(wallets[j])) coCount++;
      }
      if (coCount >= 3) pairCoCount++;
    }
  }
  return totalPairs > 0 ? pairCoCount / totalPairs : 0;
}
```

- [ ] Step 1: Create the file with code above
- [ ] Step 2: Add `findByAddress(addr: string)` method to `WalletModel` if not present (return wallet row by address)
- [ ] Step 3: `npx tsc --noEmit`
- [ ] Step 4: Commit: `feat: add manipulation-detector module (time clustering, sell pressure, fresh wallets, co-occurrence)`

---

### Task 2: Integrate Manipulation Signals into Convergence Scoring

Modify `src/engine/scorer.ts` and `src/engine/convergence.ts` to penalize score based on manipulation signals.

**Files:**
- Modify: `src/engine/scorer.ts` — add manipulation penalty to `computeMvpScore`
- Modify: `src/engine/convergence.ts` — pass sells + db to scoring, apply tier cap

**Changes to `scorer.ts`:**

Add a new exported function:

```typescript
export function applyManipulationPenalty(rawScore: number, signals: ManipulationSignals): number {
  let multiplier = 1.0;

  // Time clustering: high sync = heavy penalty
  if (signals.timeClusteringScore > 0.7) multiplier *= 0.4;
  else if (signals.timeClusteringScore > 0.4) multiplier *= 0.7;

  // Sell pressure: tracked wallets selling during buy window
  if (signals.sellPressureRatio > 0.4) multiplier *= 0.3;
  else if (signals.sellPressureRatio > 0.2) multiplier *= 0.6;

  // Fresh wallets: > 50% fresh = cap hard
  if (signals.freshWalletFraction > 0.5) multiplier *= 0.3;
  else if (signals.freshWalletFraction > 0.3) multiplier *= 0.6;

  // Co-occurrence: ring behavior
  if (signals.coOccurrenceScore > 0.5) multiplier *= 0.3;
  else if (signals.coOccurrenceScore > 0.25) multiplier *= 0.6;

  return Math.max(0, Math.round(rawScore * multiplier));
}
```

**Changes to `convergence.ts`:**

In `checkConvergence()`, after computing `score`:
1. Fetch sells in window: `const recentSells = this.trades.findByTokenInWindow(newTrade.tokenMint, since, "SELL");`
2. Compute signals: `const signals = computeManipulationSignals(recentBuys, recentSells, this.wallets, db);`
3. Apply penalty: `score = applyManipulationPenalty(score, signals);`
4. Re-derive tier from penalized score

- [ ] Step 1: Add `applyManipulationPenalty` to `scorer.ts`
- [ ] Step 2: Import and integrate in `convergence.ts`
- [ ] Step 3: Pass `db` reference to convergence engine (add to constructor if needed)
- [ ] Step 4: `npx tsc --noEmit`
- [ ] Step 5: Commit: `feat: penalize convergence score based on manipulation signals`

---

### Task 3: Pre-Entry Price Velocity Gate

Block entry if token has already pumped >300% from its earliest known price.

**Files:**
- Modify: `src/execution/risk-engine.ts`
- Modify: `src/jobs/token-metadata.ts` (store creation/first-seen price)

**Changes to `risk-engine.ts`:**

Add after the existing `firstWhalePrice` check (line 82):

```typescript
const MAX_PRE_ENTRY_PUMP_PCT = 300;

const creationPrice = this.numberConfig(`token:${convergence.token_mint}:creation_price_usd`);
if (creationPrice && creationPrice > 0) {
  const pumpPct = ((entryPriceUsd - creationPrice) / creationPrice) * 100;
  if (pumpPct > MAX_PRE_ENTRY_PUMP_PCT) {
    return { allowed: false, reason: `token already pumped ${Math.round(pumpPct)}% from creation (max ${MAX_PRE_ENTRY_PUMP_PCT}%)`, phase, portfolioValueUsd };
  }
}
```

**Changes to `token-metadata.ts`:**

When resolving a new token for the first time, store its price:

```typescript
// After resolving metadata, if no creation price stored yet:
const existing = db.prepare("SELECT value FROM execution_config WHERE key = ?").get(`token:${mint}:creation_price_usd`);
if (!existing) {
  const price = await jupiterClient.getPriceUsd(mint);
  if (price) {
    db.prepare("INSERT OR IGNORE INTO execution_config (key, value, updated_at) VALUES (?, ?, unixepoch())")
      .run(`token:${mint}:creation_price_usd`, String(price));
  }
}
```

- [ ] Step 1: Add velocity gate to `risk-engine.ts`
- [ ] Step 2: Store creation price in `token-metadata.ts`
- [ ] Step 3: `npx tsc --noEmit`
- [ ] Step 4: Commit: `feat: block entry on tokens already pumped >300% from creation price`

---

### Task 4: Hard Position Size Cap

**Files:**
- Modify: `src/execution/risk-engine.ts`

**Change:** Add absolute cap enforcement after line 63 (where `sizeUsd` is computed):

```typescript
const MAX_POSITION_PORTFOLIO_PCT = 5;
const MAX_POSITION_USD = 500;

// Hard caps — no single position should risk more than 5% of portfolio
const hardCapUsd = Math.min(
  portfolioValueUsd * MAX_POSITION_PORTFOLIO_PCT / 100,
  MAX_POSITION_USD
);
const cappedSizeUsd = Math.min(sizeUsd, hardCapUsd);
const cappedSizePct = (cappedSizeUsd / portfolioValueUsd) * 100;
```

Replace `sizeUsd` with `cappedSizeUsd` and `adjustedSizePct` with `cappedSizePct` in the return value and subsequent checks.

- [ ] Step 1: Add hard cap logic
- [ ] Step 2: Update return to use capped values
- [ ] Step 3: `npx tsc --noEmit`
- [ ] Step 4: Commit: `feat: hard cap position size at 5% portfolio / $500 max`

---

### Task 5: Tighter Stop Loss + Dollar-Loss Circuit Breaker

**Files:**
- Modify: `src/execution/position-manager.ts`

**Changes:**

1. Reduce HARD_STOP_FLOOR from -25% to -15%:
```typescript
const HARD_STOP_FLOOR_PCT = -15;  // was -25
```

2. Add dollar-loss check in `onPriceUpdate()`:
```typescript
const MAX_DOLLAR_LOSS_PCT = 3; // max 3% of portfolio per position

private async checkDollarStop(position: PositionRow, priceUsd: number): Promise<boolean> {
  const unrealizedLoss = position.amount_token * (position.entry_price_usd - priceUsd);
  if (unrealizedLoss <= 0) return false;
  const portfolioValue = this.portfolioValueUsd();
  if (portfolioValue <= 0) return false;
  const lossPct = (unrealizedLoss / portfolioValue) * 100;
  if (lossPct >= MAX_DOLLAR_LOSS_PCT) {
    await this.exit(position, "DOLLAR_LOSS_CAP", 100, true);
    return true;
  }
  return false;
}
```

3. Add `portfolioValueUsd()` helper to PositionManager (query same as risk engine).

4. Call `checkDollarStop` at the top of `onPriceUpdate()`, before all other checks.

5. Tighten initial stop-loss in `openPosition()`:
```typescript
const stopLossPrice = input.entryPriceUsd * 0.85;  // was 0.75
```

- [ ] Step 1: Change HARD_STOP_FLOOR_PCT from -25 to -15
- [ ] Step 2: Change initial stopLossPrice from 0.75 to 0.85
- [ ] Step 3: Add `checkDollarStop` method and `portfolioValueUsd` helper
- [ ] Step 4: Call `checkDollarStop` at start of `onPriceUpdate`
- [ ] Step 5: `npx tsc --noEmit`
- [ ] Step 6: Commit: `feat: tighter stops (-15% floor) + dollar-loss circuit breaker (3% portfolio max)`

---

### Task 6: Buy/Sell Ratio Filter

**Files:**
- Modify: `src/engine/filters.ts`
- Modify: `src/engine/convergence.ts` (pass sells to filter)

**Change to `filters.ts`:**

Add new filter function:

```typescript
export function passesSellPressureFilter(buys: TradeRow[], sells: TradeRow[]): boolean {
  const total = buys.length + sells.length;
  if (total === 0) return true;
  // If tracked wallets are net-selling this token in the same window, it's a wash trade
  return sells.length / total <= 0.3;
}
```

**Change to `convergence.ts`:**

Call `passesSellPressureFilter` before scoring:
```typescript
const recentSells = this.trades.findByTokenInWindow(newTrade.tokenMint, since, "SELL");
if (!passesSellPressureFilter(recentBuys, recentSells)) return null;
```

- [ ] Step 1: Add `passesSellPressureFilter` to `filters.ts`
- [ ] Step 2: Integrate in `convergence.ts`
- [ ] Step 3: `npx tsc --noEmit`
- [ ] Step 4: Commit: `feat: block convergence if >30% tracked wallets are selling in window`

---

## Execution Order

1 → 2 → 3 → 4 → 5 → 6

Tasks 1-2 are the manipulation detection layer (new module + integration).
Tasks 3-4 are the risk engine hardening.
Task 5 is the exit defense layer.
Task 6 is the additional filter.

## Expected Impact on JUPHUB Scenario

| Defense Layer | Would it have blocked/limited? |
|---|---|
| Time clustering penalty | Score 85 → ~34 (WATCH tier, no execution) |
| Position size cap $500 | Loss capped at $490 instead of $2948 |
| -15% stop loss | Exit at $0.34 = $75 loss (instead of riding to $0.007) |
| Dollar-loss 3% cap | Exit at ~$300 loss regardless |
| Price velocity >300% | Likely blocked entirely |
| Buy/sell ratio | Depends on data — likely blocked |

Combined: JUPHUB entry would have been BLOCKED by at least 3 independent layers. Even if it somehow got through, max loss = $75-$300 instead of $2948.

## Verification

After all tasks: `npx tsc --noEmit && npm run build` must pass.
