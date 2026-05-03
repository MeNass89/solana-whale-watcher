# AGENT 3 — RISK MANAGER REPORT
**Solana Whale Convergence Copy-Trading Bot — Risk Framework**

> *Former GS risk desk. I have signed off on positions that blew up. I have also blocked positions that would have. The difference was always the parameters BEFORE the trade, not the heroics after.*

---

## EXECUTIVE VERDICT ON DRAFT PARAMETERS

**REJECTED AS DRAFTED.** The proposed parameters will produce ruin within 90 days under realistic Solana memecoin conditions. Specifically:

| Draft | Problem | Risk |
|---|---|---|
| 2% base × 3x = 6% per CRITICAL position | Too large for instruments that routinely go to zero in hours | One bad CRITICAL = ~6% drawdown; three correlated = 18%+ |
| Max 10% per position | Catastrophic for memecoins | Single rug = -10% portfolio in one tx |
| -15% stop loss | Tighter than normal memecoin volatility (typical σ ≈ 25–40%/day) | Stopped out by noise on every position |
| +50% TP, single level | Whales target 5–20x; we cap at 1.5x | Asymmetric tail capture lost |
| Daily loss -10% | Allows -10% PER DAY = -50% in one bad week | No weekly/monthly circuit breaker |
| Max positions 10 / max exposure 80% | Correlation in SOL ecosystem ≈ 0.7+ during stress | Effective single-bet exposure |

**Survival is the precondition for compounding. These parameters do not prioritize survival.**

---

## 1. POSITION SIZING — PROPOSED FRAMEWORK

### Kelly-derived sizing, fractional Kelly

Realistic copy-trading priors for whale convergence on Solana memecoins:
- Win rate (price > entry at exit): **35–45%**
- Average winner: **+80%** (after slippage + tax)
- Average loser: **-45%** (after stop slippage)
- Edge: marginal positive, high variance, fat left tail (rugs)

Full Kelly ≈ 5–8%. **We use quarter-Kelly = 1.5–2% max bet.** Anything larger is gambling with the user's capital.

### Tier-based sizing (REVISED)

| Tier | Base size | Multiplier | Final | Cap |
|---|---|---|---|---|
| WATCH | 0.5% NAV | 1.0x | **0.5%** | hard cap 1% |
| NOTABLE | 0.75% NAV | 1.5x | **1.125%** | hard cap 2% |
| CRITICAL | 1.0% NAV | 2.0x | **2.0%** | hard cap 3% |

**Hard ceiling per single position: 3% NAV. No exceptions, no override flag.**

### Liquidity-adjusted sizing (MANDATORY OVERLAY)

Position size in USD must be **≤ 1% of token's 24h DEX volume** AND **≤ 0.5% of pool TVL**. Whichever is smaller wins. If either constraint reduces the tier-based size below 0.1% NAV, **skip the trade**.

```
final_size = min(
  tier_base_size × NAV,
  0.01 × token_24h_volume_usd,
  0.005 × pool_tvl_usd
)
if final_size < 0.001 × NAV: SKIP
```

### Convergence quality multiplier

Not all CRITICAL convergences are equal. Apply scoring:
- **+0.25x** if ≥3 wallets with >$1M historical PnL
- **+0.25x** if convergence window <30min (vs 2h)
- **-0.5x** if any wallet has rug-pull history (auto-flagged)
- **-1.0x → SKIP** if any wallet flagged as known sandwich/MEV bot

---

## 2. STOP LOSS / TAKE PROFIT / TIME STOPS

### Stop loss — volatility-adjusted, not flat

Flat -15% will be hit by noise. Use ATR-based stop on 1h candles:

```
stop_loss = entry × (1 - max(0.20, 2.0 × ATR_1h_pct))
hard_floor: stop_loss ≥ entry × 0.65   # never wider than -35%
```

Rationale: tight enough to cap loss, wide enough to survive normal vol. Floor at -35% prevents holding through obvious failure.

**Trailing stop activates at +30%:** lock in +10% minimum, trail at `peak × 0.80`.

### Take profit — SCALED EXITS (critical)

Single-target TP destroys edge on whale plays. Use ladder:

| Level | % of position | Trigger |
|---|---|---|
| TP1 | 33% | +40% |
| TP2 | 33% | +100% |
| TP3 (runner) | 34% | trailing stop only, no fixed cap |

This captures the right tail (memecoin 10x events) while de-risking principal early. **TP1 must execute first** — once 33% sold at +40%, the trade is mathematically de-risked vs original cost basis.

### Time stops

| Tier | Hard exit | Behavior |
|---|---|---|
| WATCH | 24h | flat exit if not at +20% |
| NOTABLE | 48h | flat exit if not at +30% |
| CRITICAL | 96h (4d) | flat exit if not at +50% |

**Rationale:** Whale convergence alpha decays fast. After 96h, you're holding bag, not riding edge. Cap holding period regardless of P&L direction.

---

## 3. SLIPPAGE & MEV PROTECTION

### Slippage — dynamic, never default

Jupiter default 0.5% is suicide on low-liquidity memecoins. Use:

```
slippage_bps = clamp(
  100,  # min 1%
  ceil(50 + 30 × (position_usd / pool_tvl_usd) × 10000),
  500   # max 5%
)
```

**If computed slippage > 5%, abort the trade.** You are paying the whale's exit, not catching their entry.

### MEV protection — non-negotiable

1. **Use Jito bundles** with priority fee in 90th percentile of last 100 blocks. Sandwich attacks on Jupiter swaps are routine.
2. **Private mempool via Helius/Triton** for entry orders. Never broadcast to public mempool — bots will front-run.
3. **Set `dynamicComputeUnitLimit: true`** and CU price floor: 50,000 microlamports.
4. **Jupiter `onlyDirectRoutes: false` BUT `maxAccounts: 64`** to avoid griefing routes.
5. **Validate quote freshness <500ms** before signing. Stale quotes = guaranteed loss.

### Sandwich detection (post-trade)

If executed price differs from quoted price by >1.5x expected slippage, **flag the route as compromised** and blacklist that pool for 24h. Repeat offender → permanent blacklist.

---

## 4. ENTRY / EXIT TIMING

### Entry rules

- **Delay entry by 30s** after convergence trigger. If price has already pumped >15% in that window, **abort** — you're the exit liquidity.
- **Reject entry if token age <2h** — too early, bundlers still active.
- **Reject if top-10 holders own >40%** of supply — concentrated dump risk.
- **Reject if LP unlocked OR mint authority not renounced** — rug-ready.
- **Reject if 24h volume <$500k** — cannot exit cleanly.
- **Reject if any tracked whale already sold >25%** of their initial buy — they're exiting, you're entering.

### Exit rules

- **Whale-exit signal:** if ≥2 of the originating convergence wallets sell >50% of their bag, **immediate market exit** of remaining position regardless of P&L. The thesis is dead.
- **Liquidity drain signal:** if pool TVL drops >30% in 1h, **exit immediately**.
- **Exit splitting:** any single sell order >0.3% of pool TVL must be split into 3+ chunks across 60s.

---

## 5. RISK GUARDRAILS — THE CIRCUIT BREAKERS

### Loss limits (NESTED — all enforced)

| Window | Limit | Action |
|---|---|---|
| Per trade | -3% NAV (hard) | force-close, regardless of stop |
| Daily | -5% NAV | pause new entries 24h, hold open positions with tightened stops (-10%) |
| Daily | -8% NAV | full halt: close all positions at market, pause 48h |
| Weekly | -12% NAV | halt 7 days, manual review required to resume |
| Monthly | -20% NAV | **kill switch**: full liquidation, bot offline, post-mortem mandatory |
| Drawdown from peak | -25% | full halt, manual restart only |

The draft -10% daily is too lax. **-5% daily / -12% weekly / -20% monthly / -25% peak** is the standard professional drawdown ladder.

### Position concentration

| Constraint | Limit |
|---|---|
| Max single position | 3% NAV |
| Max simultaneous positions | **6** (not 10) |
| Max total exposure | **40% NAV** (not 80%) |
| Max exposure to single whale's signals | 8% NAV |
| Min SOL reserve (gas + opportunity) | 5% NAV, never breached |

**Why 40% not 80%:** correlation in SOL memecoin selloffs is ~0.7. 80% nominal exposure = effective 56% single-bet. 40% nominal = 28% effective. Survives a flash crash; 80% does not.

### Correlation guards

- **Sector cap:** max 3 positions in same narrative (e.g. AI tokens, dog memes). Whale convergence often clusters by narrative — that's correlation, not diversification.
- **Time-clustering cap:** max 2 new positions per hour. Convergence storms = manipulation flag.
- **SOL drawdown halt:** if SOL/USD drops >8% in 4h, halt new entries until SOL stabilizes.

---

## 6. CRITICAL EDGE CASES & MITIGATIONS

### Honeypot detection (PRE-TRADE, MANDATORY)

Before any buy, run simulation:
1. Simulate buy via Jupiter quote
2. Simulate sell of resulting amount immediately
3. If sell simulation fails OR sell price <70% of buy price → **honeypot, blacklist token forever**
4. Use a known honeypot detection oracle (RugCheck API, GoPlus) as second signal

### Tax token handling

If sell tax >5% detected in simulation: **reject**. Tax tokens grind copy-trader edge to zero.

### Whale pump-and-dump exploitation

Whales know they're tracked. Defenses:
- **Reputation scoring:** track each whale's PnL on tokens THEY originated buys for. If whale's "led trades" have <30% follower-net-positive rate over 50 trades, downgrade or remove.
- **Ghost-whale detection:** if a whale's wallet only buys tokens within 1h of new pool creation AND sells within 4h of buying, classify as **deployer-collaborator** and exclude.
- **Cross-wallet collusion:** if 2+ "independent" whales fund from same upstream wallet within 7 days, treat as ONE signal (collusion).

### Smart contract risk

Token program checks (auto-reject):
- Mint authority not renounced
- Freeze authority not renounced (token can be frozen mid-trade)
- Update authority retained by mutable signer
- Token-2022 with transfer hooks → **always reject** unless whitelisted program
- Metadata mutable → flag, reduce sizing 50%

### Liquidity risk — the silent killer

Pre-trade required:
- Pool TVL ≥ $200k
- 24h volume ≥ $500k
- Top-LP-holder owns <50% of LP tokens (concentration)
- LP locked ≥30 days remaining

Position-level: **never let position exceed 0.5% of current pool TVL**. If TVL shrinks during hold and position now >2% of TVL, **scale out immediately to <0.5%**.

### Bot offline / failure modes

This is where most bots blow up. Required:

1. **Heartbeat watchdog:** PM2 + external uptime monitor (Better Stack, healthcheck.io). Alert on 60s outage.
2. **Stop-loss persistence:** every open position writes its stop-loss as a **limit order on Jupiter Limit / DCA program** — this protects when bot is down. Bot's in-memory stops are belt-and-suspenders, not primary.
3. **Crash-safe state:** position state in SQLite/Postgres with WAL, fsynced. On restart, reconcile on-chain holdings vs DB before trading.
4. **Reconciliation on boot:** if any holding exists on-chain that bot has no record of → **freeze, do not trade**, alert operator.
5. **Network partition:** if RPC latency >2s sustained 60s, halt entries. Use 3 RPC providers (Helius, Triton, QuickNode) with auto-failover.

### Key compromise / wallet security

- **Hot wallet ≤ trading capital** (no cold reserves on this key)
- **Daily withdrawal cap to external addresses:** 0 (bot never withdraws — only swaps)
- **Programmatic withdrawal disabled at code level:** the bot's signing key has NO authority to call SystemProgram::Transfer to non-whitelisted addresses. Enforce at instruction-filter level.
- **Multisig for >10% NAV moves:** if a swap would exceed 10% NAV in one tx, require 2nd signer (emergency human approval).

### Recovery procedures

After any halt:
1. **Mandatory cool-down:** minimum halt duration enforced regardless of operator override
2. **Post-mortem template** auto-generated: which positions, which signals, what failed
3. **Manual restart only** for weekly/monthly/peak halts
4. **Reduced size on resume:** first 20 trades after any halt run at 50% sizing. Rebuild confidence with smaller bets.

---

## 7. WHAT I WOULD ADD THAT WASN'T ASKED

1. **Paper-trade for 30 days minimum** before live capital. Validate win-rate, slippage, latency, stop-execution quality on REAL signals with FAKE money.
2. **Capital ramp:** start at 10% of intended NAV. Double weekly only if all metrics in tolerance. Full size at week 4 earliest.
3. **Tax/accounting log:** every fill written with USD cost basis at fill time. Solana memecoin trading is a tax event nightmare; logs now save you a $50k accountant later.
4. **Kill-switch hotkey:** single CLI command that closes all positions to USDC and halts the bot. Practiced weekly. When you need it, you need it in 10 seconds, not 10 minutes.
5. **Independent risk monitor process:** SEPARATE process from the trading bot, read-only access to wallet, that can FORCE-halt the trader via flag-file if its own checks (drawdown, exposure, anomaly) trip. Defense in depth — don't trust the trader to police itself.

---

## SIGN-OFF SUMMARY

| Domain | Draft | Recommended |
|---|---|---|
| Max single position | 10% | **3%** |
| Max simultaneous positions | 10 | **6** |
| Max total exposure | 80% | **40%** |
| Stop loss | -15% flat | **ATR-based, floor -35%, trail from +30%** |
| Take profit | +50% single | **Ladder: 33%/+40%, 33%/+100%, 34% runner** |
| Daily loss limit | -10% | **-5% pause, -8% halt** |
| Weekly limit | none | **-12% halt 7d** |
| Monthly limit | none | **-20% kill switch** |
| Peak drawdown | none | **-25% kill switch** |
| Slippage | (default) | **Dynamic 1–5%, abort >5%** |
| MEV | (default) | **Jito + private mempool mandatory** |
| Honeypot check | (none) | **Mandatory pre-trade simulation** |
| Bot-offline stop | (none) | **On-chain limit-order stops** |

**Bottom line:** The draft optimizes for upside capture in a benign regime. Real Solana memecoin trading is a left-tail-dominated game. Survival of the next 30 rugs and 5 flash-crashes is what compounds — not catching the next 100x. **Cut sizes by half, halve max positions, halve max exposure, double the loss-limit discipline, mandate honeypot/MEV/on-chain-stop infrastructure.** Then we have a system that can survive long enough to find out if the edge is real.

— *Risk Manager, Agent 3*
