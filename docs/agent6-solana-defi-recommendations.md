# Agent 6 — Solana DeFi Developer: Technical Recommendations

**Scope:** Auto-execution layer for whale convergence copy-trading bot. Jupiter V6, transaction lifecycle, MEV, RPC, parameter tuning.

**Verdict on draft parameters:** Position sizing is reasonable. Stop loss is **wrong for memecoins** (will get wicked out). MEV/slippage section is missing entirely — this is where 90% of bots bleed. Read carefully.

---

## 1. POSITION SIZING — CHALLENGED

### Draft critique

`2% × tier multiplier (1x/2x/3x), max 10%` is a defensible starting point but **missing 3 critical adjustments**:

#### 1.1 Liquidity-adjusted sizing (MANDATORY)

Hard rule: **your position must be ≤ 0.5% of the AMM pool's quote-side liquidity** (SOL side for SOL-quoted pairs). Above this, slippage compounds non-linearly. Above 1%, you ARE the price action.

```typescript
const MAX_POSITION_USD = Math.min(
  walletEquity * tierMultiplier * 0.02,
  poolSolLiquidity * solPriceUsd * 0.005,  // 0.5% of pool
  HARD_CAP_USD  // absolute ceiling, e.g. $500 for early-stage memecoins
);
```

Query Jupiter `/quote` with `onlyDirectRoutes=false` and inspect `routePlan[].swapInfo.ammKey` — fetch pool reserves via DAS or direct account read.

#### 1.2 Token age / FDV gate

| Token age | FDV | Max position |
|-----------|-----|--------------|
| < 6h | any | **SKIP** (rug risk dominates) |
| 6–24h | < $500k | 0.5% equity max |
| 6–24h | $500k–$5M | 1% equity max |
| 1–7d | any | tier-based normal |
| > 7d | > $10M FDV | tier-based normal, +1.5x multiplier allowed |

#### 1.3 Convergence quality multiplier

Don't size purely on tier count. Weight by:
- **Wallet PnL score** (last 30d realized): top-decile whales × 1.5
- **Time compression**: convergences inside 30min vs 2h are 3x more predictive — multiply 1.3x
- **Wallet diversity**: ignore convergences where wallets share funding source (same source CEX deposit within 24h = likely same entity)

**Final formula:**
```
position = base × tier × wallet_quality × time_compression × liquidity_cap
```

### Recommended numbers

- Base: **1.5%** (not 2% — convergence signal has ~55-60% hit rate, expectancy demands smaller bets)
- Tier: WATCH=1x, NOTABLE=2x, CRITICAL=3.5x
- Hard max: **8%** equity per single position (your 10% is too much given memecoin variance)
- Max simultaneous exposure: **60%** (your 80% is dangerous on Solana — RPC outages can prevent exits)

---

## 2. STOPS — DRAFT IS WRONG

### Why -15% stop fails on memecoins

Solana memecoin candles routinely wick -25% to -40% within 60s on MEV sandwich attacks or single-whale exits, then recover. Your -15% stop will:
1. Get triggered on noise
2. Execute at -20-30% effective due to slippage on the panic exit
3. Re-enter cost > stop avoided loss

### Recommended stop architecture

**Tiered, time-aware, liquidity-aware:**

```typescript
interface StopConfig {
  // Hard stop (always active — circuit breaker only)
  hardStopPct: -50,  // Unrecoverable territory

  // Trailing stop (activates after +30% unrealized)
  trailingActivatePct: 30,
  trailingDistancePct: 25,  // 25% off peak

  // Time-decay stop
  timeStops: {
    "24h":  { thresholdPct: -10, action: "exit_market" },
    "72h":  { thresholdPct:   0, action: "exit_if_below_breakeven" },
    "7d":   { thresholdPct:  20, action: "exit_if_below_20pct" },
    "30d":  { thresholdPct:  any, action: "force_exit" }
  },

  // Take profit ladder (CRITICAL — single TP is suboptimal)
  takeProfitLadder: [
    { pct: 50,  sellFraction: 0.25 },  // de-risk, recover capital
    { pct: 150, sellFraction: 0.35 },
    { pct: 400, sellFraction: 0.25 },
    { pct: any, sellFraction: 0.15 }   // moonbag, never sells
  ]
}
```

**Why the ladder works:** Memecoin distribution is power-law. ~70% of trades are flat-to-loss; the wins must be allowed to run 5-50x. A flat +50% TP caps your right tail and destroys expectancy.

### Convergence-exit signal (UNDERRATED)

**Exit when 2+ of the original convergence wallets sell ≥30% of their position.** This is your single best exit signal — it's the inverse of your entry. Implement as a dedicated watcher independent of price.

---

## 3. JUPITER V6 + SLIPPAGE + MEV — THE CRITICAL SECTION

### 3.1 Quote API (`/quote`)

```typescript
const quote = await fetch(`https://quote-api.jup.ag/v6/quote?` + new URLSearchParams({
  inputMint: NATIVE_SOL,
  outputMint: targetToken,
  amount: lamports.toString(),
  slippageBps: "auto",          // Jupiter's auto-slippage; OR use dynamic (below)
  swapMode: "ExactIn",
  onlyDirectRoutes: "false",
  asLegacyTransaction: "false",  // VersionedTx mandatory in 2026
  maxAccounts: "64",             // CRITICAL — see CU section
  restrictIntermediateTokens: "true",  // avoid scammy routing through unknown LP
  platformFeeBps: "0"
}));
```

**Pitfalls:**
- **Stale quotes:** Jupiter quotes expire ~10s effectively. If you batch-quote 50 tokens for a screener and execute 30s later, expect 5-15% adverse slippage. **Re-quote within 2s of `sendTransaction`.**
- **`maxAccounts=64`:** higher values produce routes that exceed the 1232-byte transaction limit, especially with priority fee + ATA creation. Cap aggressively.
- **`onlyDirectRoutes=true`** is NOT safer — it locks you out of better-liquidity multi-hop paths. Leave false.

### 3.2 Slippage strategy — DYNAMIC, not static

Static `slippageBps=300` (3%) is what beginners do. You'll either get sandwiched (too high) or fail constantly (too low).

**Use Jupiter's `dynamicSlippage`:**

```typescript
const swap = await fetch("https://quote-api.jup.ag/v6/swap", {
  method: "POST",
  body: JSON.stringify({
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    useSharedAccounts: false,        // false for tokens with Token-2022 transfer hooks
    dynamicComputeUnitLimit: true,
    dynamicSlippage: { maxBps: 1000 },  // ceiling 10%, Jupiter sizes within
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: 10_000_000,       // 0.01 SOL ceiling
        priorityLevel: "veryHigh"      // for entries on CRITICAL tier
      }
    }
  })
});
```

**Slippage tiering by tier + token age:**

| Tier | Token age < 24h | Token age 1-7d | Token age > 7d |
|------|-----------------|----------------|----------------|
| WATCH | maxBps 500 | 300 | 200 |
| NOTABLE | 800 | 500 | 300 |
| CRITICAL | 1500 | 800 | 500 |

For exits on stop-loss, **add +500bps** — exits in panic conditions need cushion or they fail-loop.

### 3.3 MEV protection — REQUIRED, not optional

Solana mempool is no longer a "safe haven." Searchers run sandwich bots on Jupiter swap signatures. If you skip MEV protection on a $5k+ swap into a low-liquidity memecoin, expect to leak 1-3% per trade to sandwiches.

**Two-layer defense:**

#### Layer 1: Jito bundles (mandatory for swaps > $1k)

```typescript
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";

const jitoClient = searcherClient(
  "frankfurt.mainnet.block-engine.jito.wtf",  // pick closest region
  jitoAuthKeypair
);

// Bundle = your swap tx + tip tx
const tipIx = SystemProgram.transfer({
  fromPubkey: wallet.publicKey,
  toPubkey: JITO_TIP_ACCOUNTS[Math.floor(Math.random() * 8)],
  lamports: 100_000  // 0.0001 SOL minimum; scale to 0.001+ for CRITICAL
});

// Critical: tip must be in same tx OR a separate tx in the bundle
const bundle = new Bundle([swapTx, tipTx], 5);
await jitoClient.sendBundle(bundle);
```

**Jito tip sizing:**
- WATCH: 50,000 lamports (0.00005 SOL)
- NOTABLE: 200,000 lamports
- CRITICAL: 1,000,000 lamports (0.001 SOL) — you're competing with other bots

Use Jito's `getTipAccounts` and rotate across all 8. Hardcoded single account = lower inclusion rate.

#### Layer 2: Use Jupiter's `swapTransaction` with Jito-aware endpoint

Jupiter offers a direct Jito integration via `useTokenLedger` flag, but for fine control go bundle-direct.

### 3.4 Compute units & priority fees

**Default Jupiter swap consumes 200k–600k CU.** Setting `computeUnitLimit` too low = `ProgramFailedToComplete`. Too high = wasted priority fee.

```typescript
// Order of instructions in tx:
const ixs = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),  // simulate first
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
  ...createAtaIxs,    // if needed
  ...swapIxs,         // from Jupiter
];
```

**Always simulate first** to get exact CU usage, then set limit at `simulated × 1.15`:

```typescript
const sim = await connection.simulateTransaction(tx, { sigVerify: false });
const cuUsed = sim.value.unitsConsumed;
// Rebuild tx with units = cuUsed * 1.15
```

**Priority fee — use Helius's `getPriorityFeeEstimate`:**

```typescript
const { result } = await fetch(HELIUS_RPC, {
  method: "POST",
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1,
    method: "getPriorityFeeEstimate",
    params: [{
      transaction: bs58.encode(tx.serialize()),
      options: { priorityLevel: "VeryHigh", recommended: true }
    }]
  })
}).then(r => r.json());

const priorityFee = result.priorityFeeEstimate;  // microLamports per CU
```

For CRITICAL-tier entries during high-congestion: cap at 5M microLamports (0.005 SOL on 1M CU). Above that, you're being scammed by network conditions — abort and retry.

---

## 4. RPC SELECTION — DETERMINANT OF SUCCESS

### Verdict

**Don't use public RPC.** Don't use a single provider. Don't use Triton if cost-conscious.

**Recommended stack:**

| Function | Provider | Why |
|----------|----------|-----|
| Read (quotes, balances, price) | **Helius** standard tier | Best DAS API, getPriorityFeeEstimate, decent rate limits |
| Write (sendTransaction) | **Helius Sender** OR **Jito** | Sender = direct landing optimization |
| WebSocket subscriptions (whale tx detection) | **Helius LaserStream** OR **Yellowstone gRPC** | Public WS drops connections every 30-90s |
| Backup write | **QuickNode** dedicated | Fallback when Helius has incidents (happens monthly) |
| Bundle submission | **Jito Block Engine** | Mandatory, no alternative |

**Cost reality:** budget **$100-300/month** minimum for a serious bot. Trying to run on free tiers = expect 20-40% silent transaction loss.

### Connection config

```typescript
const connection = new Connection(HELIUS_RPC, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60_000,
  wsEndpoint: HELIUS_WSS,
  disableRetryOnRateLimit: false,
  httpHeaders: { "x-api-key": HELIUS_KEY }
});
```

**Never use `commitment: "finalized"` for trading paths** — you'll be 13s late. Use `confirmed` for everything except final accounting.

---

## 5. TRANSACTION LIFECYCLE — RETRY LOGIC

### The naive approach that fails

```typescript
// DON'T DO THIS
const sig = await connection.sendTransaction(tx);
await connection.confirmTransaction(sig);
```

This will:
- Drop on `BlockhashNotFound` ~15% of the time during congestion
- Hang for 60s on dropped transactions
- Have no idea whether the swap actually executed

### Robust approach

```typescript
async function executeSwap(tx: VersionedTransaction): Promise<SwapResult> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;

  // Sign
  tx.sign([wallet]);
  const rawTx = tx.serialize();
  const signature = bs58.encode(tx.signatures[0]);

  // Spam-send (proven pattern for Solana under congestion)
  const sendOptions = {
    skipPreflight: true,           // we already simulated
    maxRetries: 0,                 // we handle retries
    preflightCommitment: "confirmed" as const
  };

  let landed = false;
  const sendInterval = setInterval(() => {
    if (!landed) connection.sendRawTransaction(rawTx, sendOptions).catch(() => {});
  }, 500);

  try {
    // Poll-based confirmation (more reliable than WebSocket)
    const result = await pollForConfirmation(signature, lastValidBlockHeight, 90_000);
    landed = true;
    clearInterval(sendInterval);

    if (result.err) {
      return { success: false, error: parseSwapError(result.err), signature };
    }

    // Verify actual token balance change — DON'T trust signature success alone
    const tokenReceived = await verifyTokenBalance(targetMint, expectedMin);
    return { success: true, signature, amountReceived: tokenReceived };

  } catch (e) {
    clearInterval(sendInterval);
    if (e.message.includes("blockhash expired")) {
      return { success: false, error: "expired", signature };
    }
    throw e;
  }
}

async function pollForConfirmation(
  sig: string,
  lastValidBlockHeight: number,
  timeoutMs: number
): Promise<SignatureResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: false });
    if (status?.value?.confirmationStatus === "confirmed" ||
        status?.value?.confirmationStatus === "finalized") {
      return status.value;
    }
    const currentHeight = await connection.getBlockHeight("confirmed");
    if (currentHeight > lastValidBlockHeight) {
      throw new Error("blockhash expired");
    }
    await sleep(400);
  }
  throw new Error("timeout");
}
```

### Retry policy (state machine)

```typescript
type SwapState =
  | "QUOTING"
  | "BUILDING"
  | "SENDING"
  | "CONFIRMING"
  | "VERIFYING"
  | "SUCCESS"
  | "FAILED_RETRYABLE"
  | "FAILED_FATAL";

const RETRY_POLICY = {
  blockhashExpired:    { retry: true,  maxAttempts: 3, refetchQuote: true },
  insufficientFunds:   { retry: false }, // FATAL
  slippageExceeded:    { retry: true,  maxAttempts: 2, increaseSlippageBps: 200 },
  computeUnitsExceeded:{ retry: true,  maxAttempts: 1, increaseCuLimit: 1.3 },
  programError0x1771:  { retry: true,  maxAttempts: 2, refetchQuote: true }, // Jupiter slippage
  rpcRateLimit:        { retry: true,  maxAttempts: 5, backoffMs: 1000 },
  unknownProgramError: { retry: false } // probably token-specific issue, abort
};
```

---

## 6. EDGE CASES — EVERY WAY A SWAP CAN FAIL

### 6.1 Token account creation (ATA)

Jupiter handles ATA creation automatically via `wrapAndUnwrapSol: true` and route building, BUT:

- **Token-2022 tokens with transfer hooks** require explicit ATA + extension accounts. Set `useSharedAccounts: false`.
- **Tokens with freeze authority that gets revoked mid-trade**: detect via `getAccountInfo` on mint before quoting. Skip if `freezeAuthority !== null` and not a known stablecoin.
- **SOL wrap dust**: leftover wSOL in your account. Periodically run a sweep that closes WSOL ATA and reclaims rent.

### 6.2 Honeypot detection (DO BEFORE EXECUTING)

```typescript
async function isHoneypot(mint: PublicKey): Promise<boolean> {
  // Check 1: Mint authority should be null (or you should know what it is)
  const mintInfo = await getMint(connection, mint);
  if (mintInfo.mintAuthority && !KNOWN_GOOD_AUTHORITIES.has(mintInfo.mintAuthority.toBase58())) {
    return true;
  }

  // Check 2: Simulate a SELL of dust amount
  const sellQuote = await jupiterQuote(mint, NATIVE_SOL, MIN_DUST);
  if (!sellQuote) return true;  // unsellable
  const sellSim = await simulateSwap(sellQuote);
  if (sellSim.err) return true;

  // Check 3: Top holder concentration
  const largestAccounts = await connection.getTokenLargestAccounts(mint);
  const top1Pct = Number(largestAccounts.value[0].amount) / Number(mintInfo.supply);
  if (top1Pct > 0.30) return true;  // single wallet >30%

  // Check 4: Liquidity locked / burnt LP
  // (requires Raydium/Meteora pool inspection — implement per-DEX)

  return false;
}
```

**Run honeypot check on EVERY entry**, even if whales bought. Whales get rugged too.

### 6.3 Partial fills

Jupiter V6 swaps are atomic — no partial fills at the swap level. BUT:

- Multi-hop routes through OpenBook orderbook can return less than quoted if liquidity moves between quote and execution
- Solution: **set `slippageBps` correctly** and trust the atomic guarantee. If slippage exceeds, the swap reverts (cost = priority fee + tip, no token loss).

### 6.4 Race conditions

- **Two whale signals firing within seconds for same token**: dedupe in-memory before quoting. Use a `Set<mint>` with 60s TTL.
- **Concurrent positions on same wallet**: serialize transactions to avoid `BlockhashNotFound` from nonce-like races. Use a single `TransactionQueue` with `concurrency: 1` per wallet keypair.
- **Multiple wallets same target**: parallelizable, but stagger by 200ms to avoid Jupiter rate limits.

### 6.5 Stale signal protection

```typescript
const MAX_SIGNAL_AGE_MS = 30_000;
if (Date.now() - convergence.detectedAt > MAX_SIGNAL_AGE_MS) {
  // Whale bought >30s ago, you're already late. Re-evaluate at lower size.
  positionSize *= 0.5;
  if (Date.now() - convergence.detectedAt > 120_000) skip();
}
```

### 6.6 The "all my SOL is locked in failed-retry transactions" failure

When you spam-send and 5 of them all land successfully due to blockhash overlap, you've bought 5x your intended position. **Always include a recent-swap idempotency lock:**

```typescript
const swapLock = new Map<string, { expiresAt: number; sig?: string }>();
function acquireLock(mint: string): boolean {
  const existing = swapLock.get(mint);
  if (existing && existing.expiresAt > Date.now()) return false;
  swapLock.set(mint, { expiresAt: Date.now() + 90_000 });
  return true;
}
```

### 6.7 Wallet drainer / private key safety

- **Never** put the private key in `.env` if `.env` is in repo. Use OS keyring or AWS KMS.
- Run with a **hot wallet capped at 10% of trading capital**. Refill from cold storage daily.
- Implement a **withdrawal allowlist**: only signed transactions to a whitelist of mints (Jupiter program + ATA program + System program + selected DEX programs). Anything else = abort and alert.

### 6.8 Cross-instance double-trading

If you run two replicas (active/standby), both might fire on same signal. **Use SQLite with `INSERT OR IGNORE` on a `(mint, signal_id)` unique constraint as the trade lock**, before quoting.

---

## 7. RISK GUARDRAILS — RECOMMENDED VALUES

| Guardrail | Draft | Recommended | Rationale |
|-----------|-------|-------------|-----------|
| Daily realized loss limit | -10%, pause 24h | **-7%, pause 24h** | Solana memecoin daily distributions: -7% ≈ 1.5σ. -10% means you wait until you're already deeply broken. |
| Daily unrealized DD limit | not specified | **-15%, pause new entries 12h** | Tracks open positions; prevents adding to a losing day. |
| Max positions | 10 | **8 active + 4 moonbags** | Operational complexity scales nonlinearly. |
| Max exposure | 80% | **60% active, 75% incl. moonbags** | Need SOL reserve for fees + emergency exits. |
| Min SOL float | not specified | **0.5 SOL hard reserve** | Below this, you can't pay fees to exit. |
| Single-token cap | not specified | **8% equity hard, 5% soft** | Position sizing already enforces this; double-check at order-placement. |
| Max consecutive losses | not specified | **5 → pause 4h, 8 → pause 24h** | Detects regime change. |
| RPC failure circuit breaker | not specified | **3 send failures in 60s → pause all entries 10m** | Prevents firing into a broken pipe. |

---

## 8. ENTRY/EXIT TIMING

### Entry

- **Latency budget signal-to-tx-landed: target < 8s**, hard fail at 30s
- Don't enter if more than 3 minutes elapsed since last whale buy in convergence — alpha decays fast
- **Don't enter during the first block of a new pool** (< 60s old) — sandwich bots dominate; you'll be exit liquidity
- **Skip entries during known low-liquidity periods**: Solana network upgrades (announced), major macro events (FOMC), Sundays 02:00-06:00 UTC

### Exit

- Stop-loss exits: **market sell with +500bps slippage**, not limit
- Take-profit ladders: scale out, not all-or-nothing
- Trailing stop: only after position is +30% (de-risked); 25% trailing distance
- **Convergence-exit signal** (other tracked whales selling): treated as a take-profit trigger, not stop-loss — exit calmly

---

## 9. CONCRETE PARAMETER TABLE — START WITH THESE

```typescript
export const PARAMS = {
  position: {
    baseEquityPct: 1.5,
    tierMultipliers: { WATCH: 1.0, NOTABLE: 2.0, CRITICAL: 3.5 },
    hardMaxEquityPct: 8,
    maxPoolLiquidityFractionBps: 50,  // 0.5% of SOL-side liquidity
    hardCapUsd: 2000,
  },

  stops: {
    hardStopPct: -50,
    trailingActivatePct: 30,
    trailingDistancePct: 25,
    timeStops: {
      h24:  { thresholdPct: -10 },
      h72:  { thresholdPct:   0 },
      d7:   { thresholdPct:  20 },
      d30:  { force: true }
    },
    tpLadder: [
      { atPct: 50,  sellFraction: 0.25 },
      { atPct: 150, sellFraction: 0.35 },
      { atPct: 400, sellFraction: 0.25 },
      // 15% moonbag never sells until d30 force-exit
    ],
  },

  jupiter: {
    quoteEndpoint: "https://quote-api.jup.ag/v6/quote",
    swapEndpoint: "https://quote-api.jup.ag/v6/swap",
    maxAccounts: 64,
    restrictIntermediateTokens: true,
    asLegacyTransaction: false,
    slippageBpsByTierAndAge: {
      WATCH:    { lt24h: 500,  d1to7: 300, gt7d: 200 },
      NOTABLE:  { lt24h: 800,  d1to7: 500, gt7d: 300 },
      CRITICAL: { lt24h: 1500, d1to7: 800, gt7d: 500 },
    },
    exitSlippageBonusBps: 500,
    quoteMaxAgeMs: 2000,
  },

  execution: {
    rpcPrimary: "HELIUS",
    rpcBackup: "QUICKNODE",
    bundleSubmission: "JITO",
    spamSendIntervalMs: 500,
    confirmationPollMs: 400,
    confirmationTimeoutMs: 90_000,
    cuLimitBufferMultiplier: 1.15,
    priorityFeeMaxMicroLamports: 5_000_000,
    jitoTipLamportsByTier: {
      WATCH: 50_000,
      NOTABLE: 200_000,
      CRITICAL: 1_000_000,
    },
  },

  guardrails: {
    dailyRealizedLossPct: -7,
    dailyRealizedLossPauseHours: 24,
    dailyUnrealizedDDPct: -15,
    dailyUnrealizedDDPauseHours: 12,
    maxActivePositions: 8,
    maxMoonbagPositions: 4,
    maxExposurePct: 60,
    minSolReserve: 0.5,
    singleTokenHardCapPct: 8,
    consecutiveLossPauseTriggers: [
      { count: 5, pauseHours: 4 },
      { count: 8, pauseHours: 24 },
    ],
    rpcFailureCircuitBreaker: { failures: 3, windowSec: 60, pauseMin: 10 },
  },

  signal: {
    maxSignalAgeMs: 30_000,
    sizeReductionAfterMs: 30_000,
    abortAfterMs: 120_000,
    minTimeBetweenWhaleBuysSec: 0,
    maxTimeBetweenWhaleBuysSec: 7200,  // 2h matches detection window
  },

  filters: {
    skipTokenAgeBelowMinutes: 360,    // < 6h = skip
    minPoolLiquidityUsd: 50_000,
    maxTop1HolderPct: 30,
    requireFreezeAuthorityNull: true,
    requireMintAuthorityNullOrKnown: true,
    runHoneypotSimBeforeEntry: true,
  },
};
```

---

## 10. CRITICAL FAILURE MODES — CHECKLIST BEFORE GOING LIVE

- [ ] Honeypot simulation runs on every entry
- [ ] Idempotency lock prevents double-fires from spam-send
- [ ] Wallet allowlist on signing layer (only Jupiter + ATA + System + known DEXes)
- [ ] Hot wallet capped at 10% of capital
- [ ] RPC failover tested under simulated Helius outage
- [ ] CU limit derived from simulation, not static
- [ ] Priority fee sourced from Helius `getPriorityFeeEstimate`, not static
- [ ] Jito bundle submission tested with tip account rotation
- [ ] Token balance verified post-swap (don't trust signature alone)
- [ ] Stop-loss exits use elevated slippage (+500bps)
- [ ] Convergence-exit watcher running independently
- [ ] Daily loss circuit breaker tested (manual injection)
- [ ] Min SOL reserve enforced before every entry
- [ ] Signal age check before quoting
- [ ] Time-stops actually fire (cron / interval verified)
- [ ] All log lines structured (JSON) for post-mortem

---

## Final note

The single biggest mistake bots make on Solana isn't strategy — it's **trusting `confirmTransaction()` to mean "the swap worked."** It only means the transaction landed; the program may have failed silently with a custom error. **Always verify the resulting token balance delta** before marking a trade as filled. This one check catches 90% of "I thought I had a position" bugs.

Second-biggest mistake: under-budgeting RPC. A $300/month bot has 10x the edge of a $0/month bot, all else equal. The economics work above ~$30k AUM.
