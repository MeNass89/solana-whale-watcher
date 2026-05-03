# Execution Layer — Solana Whale Watcher

## Overview

Add auto-trading to the existing whale convergence detector. When convergence is detected, auto-buy via Jupiter V6. When whales sell or stops trigger, auto-sell. All parameters from 7-expert stochastic consensus.

## Architecture

```
convergence.ts (existing) emits signal
        ↓
execution/trade-executor.ts (NEW) — decides, sizes, executes
        ↓
execution/jupiter-client.ts (NEW) — Jupiter V6 swap + Jito MEV protection
        ↓
execution/position-manager.ts (NEW) — tracks open positions, monitors stops
        ↓
execution/risk-engine.ts (NEW) — circuit breakers, exposure limits, loss limits
        ↓
storage/migrations/002_executions.sql (NEW) — executions + positions tables
```

## Files to Create

### 1. `src/storage/migrations/002_executions.sql`

```sql
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  convergence_id INTEGER REFERENCES convergences(id),
  token_mint TEXT NOT NULL,
  token_symbol TEXT,
  direction TEXT CHECK(direction IN ('BUY','SELL')) NOT NULL,
  amount_token REAL,
  amount_sol REAL,
  amount_usd REAL,
  entry_price_usd REAL,
  exit_price_usd REAL,
  pnl_usd REAL,
  pnl_pct REAL,
  tx_signature TEXT,
  status TEXT CHECK(status IN ('PENDING','FILLED','FAILED','CANCELLED')) DEFAULT 'PENDING',
  exit_reason TEXT,
  tier TEXT,
  position_size_pct REAL,
  created_at INTEGER DEFAULT (unixepoch()),
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_mint TEXT NOT NULL,
  token_symbol TEXT,
  entry_execution_id INTEGER REFERENCES executions(id),
  convergence_id INTEGER REFERENCES convergences(id),
  amount_token REAL NOT NULL,
  entry_price_usd REAL NOT NULL,
  current_price_usd REAL,
  stop_loss_price REAL,
  take_profit_prices TEXT, -- JSON array of TP levels
  trailing_stop_pct REAL,
  trailing_stop_active INTEGER DEFAULT 0,
  peak_price_usd REAL,
  time_stop_at INTEGER,
  tier TEXT NOT NULL,
  status TEXT CHECK(status IN ('OPEN','PARTIAL','CLOSED')) DEFAULT 'OPEN',
  exit_reason TEXT,
  pnl_usd REAL,
  pnl_pct REAL,
  opened_at INTEGER DEFAULT (unixepoch()),
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS execution_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(token_mint);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
```

### 2. `src/execution/jupiter-client.ts`

Jupiter V6 swap client with Jito MEV protection.

```typescript
// Key interfaces and behavior:

interface SwapParams {
  inputMint: string;     // USDC or SOL mint
  outputMint: string;    // target token mint
  amountLamports: bigint;
  slippageBps: number;
  isExitSwap?: boolean;
}

interface SwapResult {
  txSignature: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
  executedAt: number;
}

// Implementation requirements:
// 1. GET /v6/quote with dynamicSlippage, maxAccounts: 64, restrictIntermediateTokens: true
// 2. POST /v6/swap with asLegacyTransaction: false (versioned transactions)
// 3. Sign with wallet keypair from config (SOLANA_WALLET_PRIVATE env)
// 4. Submit via Jito bundle (bundleOnly: true) — NEVER public mempool
//    - Jito block engine endpoint: https://mainnet.block-engine.jito.wtf
//    - Tip scaling: WATCH=500k, NOTABLE=2M, CRITICAL=5M lamports
//    - Tip hard cap: 15M lamports
// 5. Spam-send every 500ms until confirmed (poll getSignatureStatuses)
// 6. Verify token balance post-swap — don't trust signature alone
// 7. Re-quote if quote is >3 seconds stale
// 8. For exits: add 300bps exit premium to slippage; panic exits use 2500bps

// Slippage by liquidity tier:
// >$500k: 100 bps | $100k-$500k: 300 bps | $50k-$100k: 500 bps | <$50k: SKIP

// Error handling:
// - Blockhash expired: re-sign + resend
// - Insufficient funds: abort, log error
// - Simulation failed: abort, log detailed error
// - Network congestion (TPS <1000): pause, retry after 30s
```

### 3. `src/execution/risk-engine.ts`

Central risk management. All position sizing and circuit breakers.

```typescript
interface RiskCheck {
  allowed: boolean;
  reason?: string;
  adjustedSizePct?: number;
}

// POSITION SIZING (3-phase ramp):
// Phase detection: count total filled executions
//   cold_start (0-50):   base=0.5%, NOTABLE=0.75%, CRITICAL=1.0%, cap=3%
//   validated (50-200):   base=1.0%, NOTABLE=1.5%, CRITICAL=2.0%, cap=5%
//   mature (200+):        base=1.5%, NOTABLE=2.25%, CRITICAL=3.0%, cap=5%

// SIZING GATES (reject if ANY fails):
// - position > 0.5% of pool TVL → reject
// - pool TVL < $100k → reject
// - honeypot roundtrip simulation > 8% loss → reject
// - token price moved > 15% since first whale fill → reject
// - whale buy was < $25k → reject (decoy filter)
// - mint authority not renounced → reject
// - top 10 holders > 40% supply (excl LP/burn) → reject
// - token age < 24h AND LP < $50k → reject

// VOLATILITY ADJUSTMENT:
// adjustedSize = size * min(1.0, 80 / realized_vol_24h_pct)

// PORTFOLIO LIMITS:
//   cold_start: max_exposure=30%, max_positions=6
//   validated:  max_exposure=40%, max_positions=6
//   mature:     max_exposure=50%, max_positions=6
//   max_per_narrative: 3 (same theme: AI, dog, political, etc.)
//   portfolio_heat_cap: 6% (sum of size * stop_distance)
//   sol_reserve: always keep >= 5 SOL

// CIRCUIT BREAKERS:
//   daily_loss >= 7%: pause 24h
//   weekly_loss >= 15%: pause 7d
//   monthly_loss >= 25%: full halt
//   drawdown ladder: -10% halve sizes, -15% pause entries, -20% close all, -25% kill switch
//   5 consecutive losses: pause 6h
//   SOL drops 8% in 1h: pause entries
//   network TPS < 1000 or skip_rate > 40%: pause
//   Jupiter API errors > 5% in 5min: pause
//   failed_tx_rate > 25% in 1h: pause 30min
//   rolling 7d Sharpe < 0: auto-disable
//   win_rate < 25% over 30 trades: auto-pause
```

### 4. `src/execution/position-manager.ts`

Monitors open positions, triggers exits.

```typescript
// Responsibilities:
// 1. On new convergence signal → call risk engine → if allowed, call jupiter swap → open position
// 2. Poll prices (every 30s for open positions) or use Helius price webhooks
// 3. Check stops on every price update:

// STOP-LOSS:
//   First 30 minutes: if down > 8% → exit (fast signal failure)
//   After 30 min: ATR-based stop, floor = -25%, ceiling = -45%
//   Rug emergency: -60% in <5min OR liquidity drop >40% → instant exit at 2500bps slippage

// BEHAVIORAL STOP (highest priority):
//   Any whale that triggered convergence sells >= 20% of position → IMMEDIATE FULL EXIT
//   2+ whales selling → aggressive exit (50% instant, remaining 50% in 5min)
//   This hooks into the existing Helius webhook handler — when a sell is detected from a
//   wallet that participated in an active convergence, trigger this check.

// TAKE-PROFIT LADDER:
//   +50%: sell 25%
//   +150%: sell 30%
//   +400%: sell 25%
//   Runner (20%) rides with trailing stop

// TRAILING STOP:
//   Activate at +50% from entry, trail at -20% from peak
//   At +200%: tighten to -15% from peak
//   Track peak_price_usd continuously

// TIME STOPS:
//   WATCH: 24h (if ever auto-traded)
//   NOTABLE: 72h
//   CRITICAL: 7d
//   Flat price override: < 20% move after 6h → exit 50%, after 24h → exit fully
//   Uptrend override: making higher highs → suspend time stop

// EXIT PRIORITY ORDER:
//   1. Behavioral stop (whale sells)
//   2. Rug emergency
//   3. Hard stop-loss
//   4. Trailing stop
//   5. Take-profit ladder
//   6. Time stop
//   7. Flat price exit
```

### 5. `src/execution/trade-executor.ts`

Top-level orchestrator. Glues convergence signals to execution.

```typescript
// Entry flow:
// 1. Receive convergence event from convergence.ts
// 2. Check tier: WATCH → Discord only (no auto-execute during cold start)
//    NOTABLE/CRITICAL → proceed
// 3. Entry timing:
//    CRITICAL → immediate (<3s), pre-warm Jupiter quote
//    NOTABLE → 10-15s delay, re-quote, abort if moved >3% adverse
// 4. Staleness filter:
//    CRITICAL → reject if first whale buy > 45 min ago
//    NOTABLE → reject if first whale buy > 90 min ago
// 5. Risk engine check → position size or reject
// 6. Jupiter swap → execution record
// 7. Open position with all stop/TP levels
// 8. Discord notification with: token, tier, size, entry price, stop levels, reasoning

// Exit flow (called by position-manager when stop/TP triggers):
// 1. Determine exit amount (full or partial per TP ladder)
// 2. Jupiter swap (token → USDC)
// 3. Update execution and position records
// 4. Calculate realized P&L
// 5. Discord notification with: token, exit reason, P&L, hold time
```

### 6. Modify existing files

**`src/config/index.ts`** — Add to env schema:
```
SOLANA_WALLET_PUBLIC, SOLANA_WALLET_PRIVATE (already in .env)
JITO_BLOCK_ENGINE_URL (default: https://mainnet.block-engine.jito.wtf)
EXECUTION_ENABLED (boolean, default false — kill switch)
EXECUTION_MODE (enum: paper | live, default paper)
PAPER_INITIAL_BALANCE (number, default 10000 — for paper trading simulation)
```

**`src/engine/convergence.ts`** — After convergence is detected and alert is sent:
```typescript
// Add: import { tradeExecutor } from "../execution/trade-executor.js";
// After alerting, call: await tradeExecutor.onConvergence(convergenceEvent);
```

**`src/api/webhooks.ts`** (or wherever sell detection happens) — When a tracked wallet sells a token:
```typescript
// Add: import { positionManager } from "../execution/position-manager.js";
// On sell detection: await positionManager.onWhaleSell(walletAddress, tokenMint, sellPct);
```

**`src/storage/database.ts`** — Run 002_executions.sql migration on startup.

**`package.json`** — Add dependency: `@jito-foundation/jito-ts` (or use raw HTTP to Jito block engine).

### 7. Paper trading mode

When `EXECUTION_MODE=paper`:
- Don't actually call Jupiter API
- Simulate fills at current market price (fetch from Jupiter quote but don't execute)
- Track virtual balance in `execution_config` table
- All position management still runs (stops, TPs, time stops)
- All Discord notifications still fire (marked as [PAPER])
- All metrics computed from simulated trades
- This is the default mode and what we use for 2-3 weeks of validation

## Key Technical Notes

- Use `@solana/web3.js` v2 for Keypair from secret key array
- Jupiter V6 quote API: `https://quote-api.jup.ag/v6/quote`
- Jupiter V6 swap API: `https://quote-api.jup.ag/v6/swap`
- USDC mint on Solana: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- SOL mint (wrapped): `So11111111111111111111111111111111111111112`
- Helius RPC (staked): `https://mainnet.helius-rpc.com/?api-key={HELIUS_API_KEY}`
- For price polling: use Jupiter price API `https://price.jup.ag/v6/price?ids={mint}`
- All amounts in lamports/raw units internally, USD for display
- Position manager runs on a 30-second interval timer
- All state in SQLite — no in-memory-only state (survives restart)
