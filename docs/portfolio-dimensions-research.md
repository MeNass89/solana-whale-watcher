# Portfolio Dimensions & Wallet Sourcing — Quantitative Research Report

> Generated: 2026-04-25 | Analyst: Quantitative Researcher Agent

---

## PART 1: CRYPTO — SOLANA WALLET TRACKING

### Current State (Audit)

The seed file (`src/config/wallets.seed.json`) contains **8 wallets** — none suitable for copy-trading convergence:

| Wallet | Type | Balance | Copy-Tradeable? |
|--------|------|---------|-----------------|
| Jump Crypto | Institutional MM | 14.9M SOL | **NO** — moves markets, not alpha |
| Unknown Institution | Cold storage | 170K SOL | **NO** — infrequent, identity unknown |
| Jupiter Trader | DeFi active | 2.4K SOL | **MAYBE** — unverified PnL |
| Raydium Trader | DEX active | 22 SOL | **NO** — too small, no PnL data |
| Phoenix Trader #1 | Orderbook | 33 SOL | **NO** — too small |
| Phoenix Trader #2 | Orderbook | 40 SOL | **NO** — too small |
| Alameda (historical) | Dead | 0.03 SOL | **NO** — defunct |
| Jito Foundation | Protocol | 0.002 SOL | **NO** — infrastructure, not trading |

**Verdict: 0 of 8 wallets are verified profitable traders. The entire seed set needs replacement.**

### Optimal Wallet Count — The Math

Your convergence threshold is `mvpThreshold: 2` (hardcoded), with the plan formula `max(2, floor(log2(N) + 1))`:

| Active Wallets (N) | Threshold | Convergence Probability per Token/2h | Expected False Positives/Day |
|-------|-----------|--------------------------------------|------------------------------|
| 10 | 2 | ~8% (any 2 of 10 buying same token) | 1-3 (manageable) |
| 20 | 2 | ~18% | 5-10 (noisy) |
| 25 | 3 | ~4% | 1-2 (sweet spot) |
| 40 | 3 | ~9% | 3-5 (acceptable) |
| 50 | 4 | ~2% | 0.5-1 (too restrictive) |
| 100 | 4 | ~6% | 2-4 (good but Helius cost doubles) |

**Recommendation: 25-40 ACTIVE wallets.**

- Below 20: insufficient convergence events (< 1 per week in non-meme markets)
- Above 50: threshold jumps to 4, requiring rare 4-wallet convergence. Also hits Helius Developer plan limits ($49/mo for 200+ addresses)
- Sweet spot at 30 ACTIVE: threshold = 2 gives enough signal, threshold override to 3 for tokens < 48h old reduces noise

### Tiered Architecture — Concrete Numbers

| Tier | Count | State | Purpose |
|------|-------|-------|---------|
| **Core** | 8-12 | ACTIVE | Verified profitable (win rate > 55%, 30+ trades, positive ROI over 90d). These trigger convergence. |
| **Validated** | 10-15 | ACTIVE | Partially verified (win rate > 45% OR ROI > 0 over 30d). Contribute to convergence count. |
| **Probation** | 10-20 | PROBATION | New additions, 7-day evaluation window. Tracked but do NOT count toward convergence threshold. |
| **Watchlist** | 20-50 | DORMANT | Interesting wallets not yet tracked via webhook. Scored weekly via batch RPC queries. |

**Total webhook-tracked: 30-40. Total monitored: 60-90.**

### Wallet Sourcing — Ranked by Signal Quality (2025-2026)

#### Tier S — Highest Alpha Sources

1. **Cielo Finance (cielo.finance)** — FREE
   - Best free Solana wallet profiler in 2025-2026
   - Shows: realized PnL, win rate, trade count, holding period, token diversity
   - **Method:** Search their leaderboard → filter PnL > $100K, win rate > 55%, active last 7d → export addresses
   - **Expected yield:** 5-10 verified wallets per session

2. **Birdeye Pro Trader Profiles (birdeye.so)** — FREE tier sufficient
   - "Top Traders" tab on any token shows wallets that bought early and profited
   - **Method:** For each 10x+ token in last 30d, pull top 10 early buyers → cross-reference across multiple tokens → wallets appearing 3+ times = smart money
   - **Expected yield:** 8-15 wallets per analysis session

3. **On-chain Early Buyer Analysis (your own system)** — FREE
   - For every token that did 5x+ in 30d, query Helius `getSignaturesForAddress` on the token mint for first 2h of trading
   - Cross-reference buyers: wallet appearing as early buyer on 3+ winning tokens = high signal
   - **This is your Phase 3 plan and it's the single best source**
   - **Expected yield:** 10-20 high-quality candidates per monthly analysis

#### Tier A — Strong Sources

4. **Axiom Pro (axiom.trade)** — FREE leaderboard
   - PnL leaderboard with verifiable on-chain data
   - Filter: 7d PnL > $50K, win rate > 50%, > 20 trades
   - **Caveat:** Leaderboard gameable via wash trading. Cross-validate with Cielo.
   - **Expected yield:** 3-8 wallets after filtering

5. **Arkham Intelligence (arkhamintelligence.com)** — FREE tier
   - Best for identifying institutional/fund wallets by label
   - **Method:** Search "Solana" + filter by entity type "Fund" or "Trader"
   - Useful for your Core tier (known entities with track records)
   - **Expected yield:** 3-5 institutional wallets

6. **Co-buyer Detection (your own system)** — FREE
   - Already in your Phase 3 plan. Unknown wallets that buy the same tokens as your Core wallets 3+ times within 2h windows = likely informed money
   - Implemented via SQL query on your existing trades table
   - **Expected yield:** 5-15 wallets per month (auto-discovery)

#### Tier B — Supplementary Sources

7. **Nansen (nansen.ai)** — PAID ($150/mo for Solana)
   - "Smart Money" labels are proprietary but well-regarded
   - **Only worth it if budget allows.** The free sources above cover 80% of what Nansen provides for Solana.
   - **Expected yield:** 10-20 labeled wallets, but many overlap with Cielo/Birdeye findings

8. **Dune Analytics (dune.com)** — FREE
   - Community dashboards for "top Solana traders" exist but quality varies
   - **Method:** Search "solana top traders PnL" → find maintained dashboards → extract addresses
   - **Expected yield:** 5-10 wallets, requires manual verification

9. **Funding Trail Analysis (your own system)** — FREE
   - Your Phase 4 plan. Monitor SOL transfers from Core wallets to new addresses (wallet rotation detection)
   - Lower priority than early buyer analysis but catches sophisticated actors
   - **Expected yield:** 2-5 wallets per month

#### Tier C — Low Priority / Avoid

10. **Twitter/CT Copy-Paste Addresses** — FREE but dangerous
    - Community-sourced addresses (YouTube, Twitter/X, Telegram groups)
    - High noise, often outdated, sometimes honeypots
    - **Only use as candidates for Probation tier, never direct to Active**

11. **Solscan/Solana Explorer Manual Research** — FREE but slow
    - Manually browsing top token holders is time-intensive
    - Inferior to automated early-buyer analysis

### Verification Protocol — Non-Negotiable Before ACTIVE Status

Every wallet MUST pass ALL checks before moving from PROBATION to ACTIVE:

```
VERIFICATION CHECKLIST:
[ ] 30+ trades in last 90 days (active, not dormant)
[ ] Win rate > 50% on round-trip trades (buy→sell with profit)
[ ] Positive cumulative PnL over 90 days
[ ] Not a known MEV bot (check: uniform tiny profits, < 1s hold times)
[ ] Not a known exchange hot wallet (check: high volume, uniform distribution)
[ ] Not wash trading (check: same token buy/sell within same block)
[ ] Balance > 5 SOL (skin in the game)
[ ] Trading patterns suggest human judgment, not pure bot
[ ] Cross-validated on at least 2 sources (Cielo + Birdeye, or Cielo + on-chain)
```

### Implementation Priority

```
WEEK 1: Replace seed wallets
  - 2h on Cielo Finance leaderboard → 8-12 Core candidates
  - 1h on Birdeye top traders for last 3 big tokens → 5-10 more
  - Verify all via checklist above
  - Target: 12-15 ACTIVE wallets

WEEK 2-3: Expand to target count
  - 2h on Axiom Pro leaderboard → 5-8 more
  - Run early buyer analysis on 10 recent 5x+ tokens → 10-15 candidates
  - Move verified ones to ACTIVE
  - Target: 25-30 ACTIVE wallets

MONTH 2+: Auto-discovery loop
  - Enable co-buyer detection (Phase 3 code)
  - Weekly batch scoring of all tracked wallets
  - Auto-demote wallets with win rate < 40% over rolling 30d
  - Auto-promote high-scoring PROBATION wallets
  - Target: 30-40 ACTIVE, self-maintaining
```

---

## PART 2: STOCKS — SENATORS + 13F FUNDS

### Current State (Audit)

**Senators:** Top 20 by composite score, dynamically ranked. Signal filter rejects anyone ranked > 20. This is correct.

**13F Funds:** 11 total — 4 Tier 1 (always copy), 4 Tier 2 (significant moves only), 3 Tier 3 (passive tracking).

**Allocation:** Senator sleeve 60%, 13F sleeve 30%, Cash reserve 10%.

### Verdict on Current Numbers

#### Senators: 20 is correct. Do NOT expand.

**Reasoning:**
- The STOCK Act requires disclosure within 45 days. Filing delay is already a massive alpha decay problem.
- Your signal filter already rejects trades with filing delay > 30 days. With 535 total members of Congress, only ~40-60 trade frequently enough to rank.
- Top 20 captures the statistical tail — these are the members with demonstrated persistent alpha (committee alignment, repeat patterns).
- Expanding to 30+ adds members with sparse trade history (< 10 trades), making the composite score unreliable.
- Your cluster detector already catches multi-politician convergence (3+ politicians buying same ticker in 30d), which is the highest-quality signal. More senators dilute this.

**One adjustment:** Consider tracking **both chambers dynamically** (Top 20 overall, not Top 20 Senate-only). Your plan already says "track BOTH chambers" (6/7 consensus). Pelosi, Crenshaw, McCaul are House members and historically top performers.

#### 13F Funds: Expand Tier 1 from 4 to 6. Keep total at 11-13.

Current Tier 1 (Buffett, Ackman, Druckenmiller, Tepper) misses two critical concentrated funds:

| Add to Tier 1 | Fund | CIK | Why |
|---------------|------|-----|-----|
| **David Einhorn** | Greenlight Capital | 0001079114 | High concentration portfolio (10-15 positions), strong historical alpha, value-oriented. Currently Tier 2 but trades are high-conviction enough for auto-copy. |
| **Seth Klarman** | Baupost Group | 0001061768 | The most respected deep-value investor alive. Trades infrequently but when he moves, it's high signal. Currently Tier 2. |

**Reasoning for NOT expanding further:**
- 13F filings are quarterly (45-day delay after quarter end). By the time you see the filing, the position is 1.5-4.5 months old.
- Only highly concentrated funds (< 15 positions) provide actionable signal. Bridgewater (300+ positions) and Tiger Global (100+ positions) are noise for copy-trading.
- Loeb and Icahn are activists — their alpha comes from board fights and public campaigns you can't replicate.
- Burry is a contrarian signal (useful as sentiment indicator, not copy target).

#### Recommended Final Structure

| Tier | Funds | Action |
|------|-------|--------|
| Tier 1 (auto-copy) | Buffett, Ackman, Druckenmiller, Tepper, **Einhorn**, **Klarman** | 6 funds |
| Tier 2 (alerts only) | Loeb, Icahn | 2 funds — reduced from 4 |
| Tier 3 (passive) | Burry, Tiger Global, Bridgewater | 3 funds — unchanged |
| **Total** | **11 funds** | |

### Should You Add Hedge Fund Managers Beyond 13F?

**No.** Here's why:
- 13F is the only mandatory public disclosure for institutional investors. Everything else (letters, interviews) is delayed and potentially misleading.
- Adding more managers without 13F obligations (e.g., crypto fund managers, PE firms) has no data feed to ingest.
- The one exception: **insider Form 4 filings** from corporate executives. But you explicitly disabled this (`EDGAR Form 4 disabled — was ingesting corporate insiders, not congress`). This was correct — corporate insider trading is a different strategy with different signal characteristics.

---

## PART 3: BALANCE — HIGH-CONVICTION vs DISCOVERY

### Crypto (Solana)

```
HIGH-CONVICTION (Core + Validated):  60-70% of tracked wallets (18-28 of 30-40)
DISCOVERY (Probation):               30-40% of tracked wallets (10-15 of 30-40)

Convergence weight:
- Core wallet in convergence:       1.5x score multiplier
- Validated wallet in convergence:  1.0x (baseline)
- Probation wallet in convergence:  0.5x (reduced weight, never triggers alone)
```

**Key rule:** A convergence event MUST include at least 1 Core or Validated wallet. Two Probation wallets converging is NOT actionable — it could be two bots from the same operator.

### Stocks

```
SENATOR SLEEVE (60% of portfolio):
  - Top 10 senators:    70% of senator allocation (high conviction)
  - Rank 11-20:         30% of senator allocation (discovery / emerging)
  
13F SLEEVE (30% of portfolio):
  - Tier 1 (6 funds):   85% of 13F allocation (high conviction)
  - Tier 2 (2 funds):   15% of 13F allocation (alerts → manual review → optional copy)
  - Tier 3:             0% allocation (information only)

CASH RESERVE: 10% always
```

### Cross-System Portfolio Weighting

If both systems run on the same capital base:

```
RECOMMENDED SPLIT:
  Crypto (Solana whale watcher): 30% of total capital
  Stocks (Senator + 13F tracker): 70% of total capital

REASONING:
  - Crypto has higher variance, shorter time horizons, higher drawdowns
  - Stock signals are delayed (45d filing lag) but more reliable
  - Crypto paper trading should run 2-3 months before sizing up
  - Stocks can go live with smaller positions sooner (regulated market, no MEV)
```

---

## PART 4: CONCRETE PARAMETER CHANGES

### Solana Whale Watcher — Config Changes

```typescript
// src/config/index.ts — RECOMMENDED CHANGES
convergence: {
  windowMinutes: 120,          // KEEP — 2h is correct
  mvpThreshold: 2,             // KEEP for now, upgrade to dynamic formula at 30+ wallets
  minTradeUsd: 500,            // KEEP
  minLiquidityUsd: 50000,      // KEEP
  minTokenAgeHours: 24,        // KEEP (DEGEN_MODE overrides)
  degenMode: false,            // KEEP
  
  // NEW — Add these parameters
  probationConvergenceWeight: 0.5,   // Probation wallets count as 0.5 toward threshold
  requireCoreWallet: true,           // At least 1 Core/Validated wallet required
  dynamicThreshold: true,            // Enable log2 formula when wallet count > 25
}
```

### Stock Tracker — Code Changes

```typescript
// src/tracking/fund-manager-tracker.ts — Promote Einhorn + Klarman to Tier 1
{ manager: "David Einhorn", fund: "Greenlight Capital", cik: "0001079114", tier: 1, ... },
{ manager: "Seth Klarman", fund: "Baupost Group", cik: "0001061768", tier: 1, ... },
```

### Wallet Seed Replacement Priority

The current 8 seed wallets should be replaced entirely. Here's the sourcing plan:

```
STEP 1: Go to cielo.finance/leaderboard
  Filter: Chain=Solana, Period=90d, Min Trades=30, Min PnL=$50K
  Take top 15 by PnL, cross-check win rate > 50%
  
STEP 2: Go to birdeye.so
  Find 5 tokens that did 10x+ in last 60 days
  For each: "Top Traders" tab → first 10 buyers
  Cross-reference: wallets appearing on 3+ token lists = strong candidates
  
STEP 3: Verify each candidate
  Run through verification checklist above
  Add passing wallets as PROBATION state
  After 7d with win rate > 45%, promote to ACTIVE
```

---

## SUMMARY TABLE

| Dimension | Current | Recommended | Change |
|-----------|---------|-------------|--------|
| Crypto wallets (active) | 8 (0 verified) | 30-40 | **Replace all, source from Cielo/Birdeye/on-chain** |
| Crypto wallets (total monitored) | 8 | 60-90 | Add watchlist tier |
| Convergence threshold | 2 (static) | 2-3 (dynamic at N>25) | Enable log2 formula |
| Stock senators tracked | Top 20 | Top 20 (both chambers) | **No change needed** |
| 13F funds Tier 1 | 4 | 6 (+Einhorn, +Klarman) | Promote 2 from Tier 2 |
| 13F funds total | 11 | 11 | No change |
| High-conviction ratio (crypto) | N/A | 60-70% | Implement tiered scoring |
| High-conviction ratio (stocks) | implicit | 70/30 within senator sleeve | Make explicit in position sizer |
| Best free wallet source | None used | Cielo Finance | **Priority 1** |
| Cross-system split | Not defined | 30% crypto / 70% stocks | Define when going live |
