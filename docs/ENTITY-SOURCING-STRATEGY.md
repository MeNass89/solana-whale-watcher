# Entity Sourcing Strategy — Smart Money Trackers
> Optimal wallet/entity counts, sourcing methods, and balance ratios.
> Date: 2026-04-25

---

## DIAGNOSTIC — Current State Problems

### Crypto (12 wallets in DB)
Your 12 wallets are **fundamentally broken for copy-trading memecoins**:
- **Jump Crypto** (14.9M SOL) — market maker, not a copy-trade target. Their buys move markets; by the time you detect them, the move is priced in.
- **Alameda Remnant** (0.03 SOL) — dead wallet. Zero alpha.
- **Jito Foundation** (0.002 SOL) — protocol infra wallet. Not a trader.
- **Institution 170K SOL** — unknown identity. Could be an exchange hot wallet, OTC desk, or custodian. Not actionable.
- **Phoenix DEX traders** (13-40 SOL) — orderbook traders on a low-volume venue. Their trades are hedging/market-making, not directional bets.
- **"Memecoin Hunter"**, **"DeFi Degen"**, **"Whale Alpha"** — zero trades recorded, zero win rate, zero verification. Labels are aspirational, not earned.

**Verdict:** 0 out of 12 wallets are verified profitable memecoin/DeFi traders. Your convergence engine has no signal to detect.

### Stocks (3 funds, 0 senators in DB)
- **Pershing Square, Duquesne, Appaloosa** — excellent tier-1 picks.
- **Politicians table is empty** — the Quiver API key is missing, so zero senator data is ingested. The signal filter requires `rank <= 20` but `rankings` table is also empty.
- The architecture is sound (committee alignment, cluster detection, wash sale tracking), but it's running on zero data.

---

## 1. CRYPTO WALLETS — Optimal Count & Sourcing

### Target Numbers (by phase)

| Phase | Active Wallets | Convergence Threshold | Rationale |
|-------|---------------|----------------------|-----------|
| Now (MVP) | **8-12 verified** | 2 | Enough for 2-wallet convergence without noise |
| 3 months | **25-40 curated** | 3 | log2(32)+1 = 6, but keep at 3 for actionable signals |
| 6 months | **40-60 scored** | 3-4 dynamic | Sweet spot: enough diversity for convergence, few enough to verify |
| Steady state | **60-80 active** | dynamic (log2) | Beyond 80, signal dilutes faster than it compounds |

**Why NOT 100-500 as PLAN.md suggests:** On Solana memecoins, 500 wallets = you're tracking half the active traders on Axiom. Convergence becomes "the market is buying" instead of "smart money is buying." The alpha is in the curation, not the count. 60-80 ACTIVE (scored, verified) wallets is the ceiling.

### Wallet Discovery — Ranked by Alpha Quality

#### Tier 1: Highest Alpha (use these NOW)

**1. Axiom Pro Leaderboard — "Top Traders" tab**
- URL: app.axiom.trade → Discover → Top Traders
- Filter: 30d PnL > $100K, Win Rate > 55%, Trades > 50 in 30d
- Sort by: ROI % (not absolute PnL — PnL favors big wallets, ROI favors skill)
- Yield: 5-10 wallets per session
- **Verification:** Click each wallet → check 30d trade history on Axiom itself. Look for: (a) consistent sizing, (b) early entries on tokens that later 5x+, (c) NOT farming airdrops or wash trading
- **This is your #1 source. Do this first.**

**2. GMGN.ai — Smart Money Dashboard**
- URL: gmgn.ai → Smart Money → Top Traders (Solana)
- Best feature: shows "early buyer" wallets per token — who bought in the first 5 minutes of tokens that did 10x+
- Filter: 7d PnL > $50K, exclude wallets with >200 trades/day (bots)
- Yield: 8-15 wallets per session
- **Cross-reference with Axiom.** A wallet that appears on BOTH leaderboards has real edge.

**3. Birdeye Pro — Top Traders per Token**
- For any token that recently did 5x+, go to Birdeye → Token page → Top Traders tab
- Extract wallets that bought in the first 2 hours AND sold for profit
- Do this for 5-10 recent winners → you'll see the same wallets appear repeatedly
- Those repeat early buyers are your highest-conviction targets
- Yield: 3-5 wallets per token analyzed

**4. Cielo Finance (cielo.finance)**
- Portfolio tracker that lets you input any wallet and see full PnL history
- Use it as VERIFICATION, not discovery. After finding a wallet on Axiom/GMGN, paste it into Cielo to see actual realized PnL across all tokens.
- Kill criterion: if Cielo shows negative 90d PnL, reject the wallet regardless of what Axiom says.

#### Tier 2: Good Discovery (use after Tier 1)

**5. DexScreener — "Top Traders" on trending tokens**
- For each token trending on DexScreener homepage, click → Traders → sort by PnL
- Same "repeat early buyer" method as Birdeye but different data source
- Yield: 2-4 wallets per session

**6. Twitter/X Solana CT (Crypto Twitter) — Manual OSINT**
- Accounts that regularly post wallet addresses with PnL screenshots: @lookonchain, @spotonchain, @ai_9684xtpa, @EmberCN
- These accounts analyze whale moves in real-time and publish wallet addresses
- Yield: 1-3 wallets per week (high quality, already community-vetted)

**7. Solscan/SolanaFM — Funding Trail Analysis**
- When you find one alpha wallet, check its SOL funding sources
- "Where did this wallet get its initial SOL from?" → often reveals the parent wallet or other wallets from the same operator
- If Wallet A funds Wallet B and Wallet C, and A is profitable, B and C are candidates
- This is your **co-buyer detection** method's manual equivalent

#### Tier 3: Supplementary

**8. Nansen — Smart Money labels (paid)**
- Nansen's "Smart Money" tag on Solana is decent but lags behind Axiom/GMGN by days
- Useful for institutional wallets (VCs, funds) but less useful for memecoin degens
- Only worth it if you already have a Nansen subscription

**9. Dune Analytics — Community Dashboards**
- Search "Solana top traders" or "Solana whale tracker" dashboards
- Quality varies wildly. Best ones: @ilemi's dashboards, @0xKofi's analyses
- Yield: 2-5 wallets per quality dashboard found

**10. Helius DAS API — Programmatic Discovery (your auto-discovery pipeline)**
- Already in your plan for Phase 3-4
- Query recent large swaps on Jupiter/Raydium programs → extract signers → score by PnL
- This is what `wallet-scorer.ts` should evolve into
- Only activate AFTER you have 15+ manually verified wallets as ground truth

### Wallet Verification Checklist (NON-NEGOTIABLE before adding)

Every wallet MUST pass ALL of these:

```
[ ] 30d realized PnL > $20K (Cielo or Axiom)
[ ] Win rate > 45% on tokens held > 1 hour (excludes bot scalps)
[ ] At least 30 trades in last 30 days (not dormant)
[ ] NOT a known MEV bot (check tx patterns: sandwich, backrun)
[ ] NOT an exchange hot/cold wallet (check if receives from many unique wallets)
[ ] NOT a market maker (check if places both buys and sells on same token within same block)
[ ] Has at least 2 trades that resulted in 3x+ gain in last 90 days
[ ] SOL balance between 5 and 50,000 (below 5 = dust, above 50K = likely institutional/MM)
```

---

## 2. STOCK ENTITIES — Optimal Count

### Senators: 20 is correct, BUT...

The rank <= 20 filter in `signal-filter.ts` is well-calibrated. The academic research (Eggers & Hainmueller 2013, Ziobrowski et al. 2004) shows that congressional outperformance concentrates in the top quartile of traders. With ~100 senators, top 20 captures that quartile.

**What to change:**
- **Ingest the data first.** Get the Quiver API key. Zero senators in DB = zero signals.
- **Add House members selectively.** Top 5 House members by composite score (some outperform senators). Speaker, Ways & Means chair, and Armed Services/Intelligence committee chairs have the strongest informational edge.
- **Final target: 20 senators + 5 House members = 25 politicians**

### 13F Funds: 3 is too few

| Current | Add | Rationale |
|---------|-----|-----------|
| Pershing Square (Ackman) | **Already have** | Concentrated portfolio, high conviction |
| Duquesne (Druckenmiller) | **Already have** | Macro + tech, fast mover |
| Appaloosa (Tepper) | **Already have** | Distressed + event-driven |
| — | **Berkshire Hathaway** | Buffett/Abel. Slower but highest long-term alpha |
| — | **Soros Fund Management** | Macro, reflexivity trades |
| — | **Third Point (Dan Loeb)** | Activist + event-driven |
| — | **Viking Global** | Long/short equity, tech-heavy |
| — | **Coatue Management** | Tech/growth specialist |

**Target: 8 funds total.** Beyond 8, you hit the same dilution problem as crypto — if everyone is buying NVDA, that's the market, not alpha.

**Filter already handles this:** Your `evaluate13FDiff` rejects funds with 500+ names. This correctly excludes index-huggers. Keep that gate.

### Portfolio Allocation Adjustment

Current: Senator 60% / 13F 30% / Cash 10%

**Proposed:** Senator 50% / 13F 40% / Cash 10%

Rationale: 13F data is more reliable (audited SEC filings, exact share counts) vs senator data (ranges like "$100K-$250K", 45-day reporting lag). Give more weight to the cleaner signal.

---

## 3. HIGH-CONVICTION vs DISCOVERY RATIO

### Crypto

| Category | % of Tracked Wallets | Description |
|----------|---------------------|-------------|
| **Core** (verified, scored > 70) | 40% (~25 wallets) | Your best performers. Full convergence weight. |
| **Proven** (scored 50-70) | 30% (~20 wallets) | Passed verification, building track record. Normal weight. |
| **Probation** (scored < 50 or new) | 20% (~12 wallets) | Recently added, unproven. Reduced weight (0.5x in convergence). |
| **Discovery** (auto-detected) | 10% (~5 wallets) | Co-buyers, funding trail. Watch-only, no convergence weight until promoted. |

**Key rule:** A convergence signal from 2 Core wallets > 3 Probation wallets. Weight the convergence score by wallet tier, not just count.

### Stocks

| Category | Entities | Treatment |
|----------|----------|-----------|
| **Core senators** (rank 1-10) | 10 | Full position size, priority boost +2 |
| **Extended senators** (rank 11-20) | 10 | Standard position size |
| **House picks** (top 5) | 5 | 70% of standard position size |
| **Tier-1 funds** (concentrated) | 3 (Ackman, Druckenmiller, Tepper) | Full allocation, "new" position type = immediate action |
| **Tier-2 funds** (diversified) | 5 (Buffett, Soros, Loeb, Viking, Coatue) | 60% allocation, only "new" and "increase > 50%" actionable |

---

## 4. IMMEDIATE ACTION ITEMS

### This Week (Priority Order)

1. **Purge the current 12 wallets.** None are verified profitable traders. Start fresh.
2. **Spend 2 hours on Axiom Pro + GMGN.ai.** Find 8-10 wallets using the Tier 1 methods above. Verify each with Cielo.
3. **Get the Quiver API key** for stock tracker. Senator sleeve is dead without it.
4. **Add 5 more 13F funds** (Berkshire, Soros, Third Point, Viking, Coatue) to the EDGAR ingestion.

### This Month

5. **Implement wallet scoring** (`wallet-scorer.ts` is a stub). Score by: realized PnL (40%), win rate (30%), avg entry timing vs ATH (20%), activity recency (10%).
6. **Add wallet tier weighting** to convergence engine. A Core wallet should count 2x a Probation wallet.
7. **Build the Birdeye "repeat early buyer" scraper** — automated version of Tier 1 method #3.
8. **Add top 5 House members** to stock tracker scope.

---

## Summary Numbers

| System | Current | Optimal (now) | Optimal (steady state) |
|--------|---------|---------------|----------------------|
| Crypto wallets | 12 (0 verified) | 8-12 verified | 60-80 scored |
| Senators | 0 (no data) | 20 (need Quiver key) | 20 senators + 5 House |
| 13F funds | 3 | 8 | 8 (ceiling) |
| Convergence threshold | 2 static | 2 (with 8-12 wallets) | 3-4 dynamic |
