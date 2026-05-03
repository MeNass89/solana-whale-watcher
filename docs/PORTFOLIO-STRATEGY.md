# Portfolio Strategy — Optimal Entity Count & Scaling Path

**Date:** 2026-04-25
**Combined paper AUM:** 10K SOL + $100K stocks

---

## 1. Crypto: Wallet Count

### Recommendation: 15 core + 35 discovery = 50 total wallets

**Why not fewer:**
Your convergence engine (`mvpThreshold: 2`) fires when 2+ wallets buy the same token within a window. With only 10 wallets, you get C(10,2) = 45 possible pair signals. That's thin — you need volume to distinguish real convergence from coincidence.

**Why not more than 50:**
Each additional wallet beyond ~50 adds noise faster than signal. The convergence detection becomes polluted — random overlap between 100+ wallets on popular tokens (SOL, BONK, JUP) triggers false positives that your `passesMvpFilters` can't fully suppress. Empirically, Nansen/Arkham whale-tracking research shows signal quality peaks at 30-50 curated wallets.

**Tier structure:**

| Tier | Count | Criteria | Weight in convergence |
|------|-------|----------|-----------------------|
| Core | 15 | Win rate >55%, Sharpe >1.0, >$500K avg position, 6mo+ track record | Full weight (1.0x) |
| Discovery | 35 | Profitable but unproven, flagged by on-chain scanners, new wallets with 3+ early hits | Half weight (0.5x) |

**Action:** Modify `convergence.ts` to weight wallet tiers. A convergence of 2 core wallets = stronger than 3 discovery wallets. Map this to your `computeMvpScore()`.

**Scaling the threshold dynamically:**
Your `getThreshold()` in `thresholds.ts` already uses `log2(totalWallets) + 1`. At 50 wallets, threshold = 6.6 → 7. That's too high for core-only convergence. Better formula:

```
threshold = max(2, floor(log2(coreCount) + 1))  // = 5 at 15 core
```

Use core count, not total count, as the denominator.

---

## 2. Stocks: Senator & 13F Fund Count

### Senators: Keep 20, but add decay

Your `compositeRank` already ranks by alpha (30%), win rate (20%), Sharpe (20%), profit factor (15%). The top 20 cutoff is correct — beyond 20, the marginal senator's alpha drops below market noise. The `signal-filter.ts` already gates on `rank <= 20`.

**Refinement:** Add rank-weighted sizing (partially done in `position-sizer.ts` with rank <= 5 → 1.5x, <= 10 → 1.25x). Below rank 15, reduce to 0.75x. This concentrates capital on highest-conviction signals.

### 13F Funds: Expand from 3 to 6

**Current:** Pershing Square (Ackman), Duquesne (Druckenmiller), Appaloosa (Tepper) — all concentrated, high-conviction managers. Good.

**Add these 3:**

| Fund | CIK | Why |
|------|-----|-----|
| Soros Fund Management | 0001029160 | Macro + equity, concentrated, legendary returns |
| Greenlight Capital (Einhorn) | 0001079114 | Deep value, concentrated (<40 names), strong alpha |
| Lone Pine Capital (Mandel) | 0001061165 | Growth + quality, 30-40 names, consistently top-decile |

**Why not Berkshire:** Your `thirteenFBase` already special-cases Buffett at 5% allocation. But Berkshire's 13F is 45+ names and moves glacially — low signal density for a copy-trading strategy. Skip it unless Nassim specifically wants it.

**Why stop at 6:** Beyond 6 concentrated managers, you get overlap (they all own META, GOOGL, MSFT) and the 13F sleeve's signal degrades into a quasi-index. At 6 funds, you're tracking ~150-200 unique positions. The `fund_holdings` table already diffs changes — with 6 funds, you'll see ~3-8 actionable changes per quarter.

**Why not 10+:** Diminishing Sharpe improvement. Backtests of 13F copy strategies (Novus, WhaleWisdom data) show Sharpe peaks at 5-7 concentrated filers and declines after 10.

### Cross-signal boost

When a senator AND a 13F fund both buy the same ticker within 30 days → treat as maximum conviction. Your `hasClusterSignal` in senator logic checks for 3+ senators. Add a cross-sleeve check: if the same ticker appears in both a senator trade and a 13F new/increase within 30 days, boost priority to 10 and size to 5% of portfolio.

---

## 3. Cross-Asset Rebalancing

### Recommendation: No dynamic rebalancing. Fixed allocation with quarterly review.

**Rationale:**
- Crypto and stocks have fundamentally different risk/return profiles. A 10K SOL crypto book and a $100K stock book are not comparable on the same Sharpe scale.
- Dynamic rebalancing toward "what's performing" is momentum chasing at the asset class level — exactly the wrong signal for a copy-trading strategy that derives alpha from information asymmetry, not trend.
- Your risk engines are independent (crypto has drawdown kill switches at -15/-20/-25%; stocks have 10% cash reserve and sector caps). They should stay independent.

**What to do instead:**
- Track each system's Sharpe independently.
- If crypto Sharpe > 1.5 after 6 months of paper trading → allocate more real capital to crypto when going live.
- If stock Sharpe > 1.0 after 6 months → allocate more real capital to stocks.
- Never cannibalize one to feed the other. Add fresh capital to the stronger system.

---

## 4. Scaling Milestones

### Phase 1: Paper Trading Validation (current → month 6)

| Milestone | Trigger | Action |
|-----------|---------|--------|
| Signal density | >20 convergences/month (crypto) OR >5 senator+13F signals/month (stocks) | Confirm entity count is sufficient |
| Win rate | >40% over 50+ trades (crypto) OR >55% over 30+ trades (stocks) | Graduate from `cold_start` to `validated` phase |
| Sharpe | Rolling 90-day Sharpe > 0.5 on either system | Begin live deployment planning |

### Phase 2: Live Deployment (month 6-12)

| Milestone | Trigger | Action |
|-----------|---------|--------|
| Go live | Paper Sharpe > 0.5 sustained 3 months | Deploy with 10% of paper size (1K SOL / $10K stocks) |
| Scale 1 | Live Sharpe > 0.8 over 3 months | Scale to 50% of target size |
| Scale 2 | Live Sharpe > 1.0 over 6 months | Scale to 100% of target size |

### Phase 3: Entity Expansion (month 12+)

| Milestone | Trigger | Action |
|-----------|---------|--------|
| Add wallets | Discovery wallet promotes to core (3mo win rate >50%) | Promote, add new discovery wallet. Never exceed 60 total |
| Add funds | New concentrated filer identified with <40 names, >15% 5yr CAGR | Add to 13F sleeve. Never exceed 8 funds |
| Add senators | House members start filing with STOCK Act compliance improvement | Add House sleeve at 10% allocation. Currently too noisy |
| Remove entities | Wallet win rate <25% over 30 trades, OR fund dilutes to >100 names | Demote/remove. Quarterly review |

---

## Summary Table

| Dimension | Current | Recommended | Sharpe Impact |
|-----------|---------|-------------|---------------|
| Crypto wallets | undefined | 15 core + 35 discovery = 50 | +0.2-0.4 vs random 50 |
| Senator count | 20 | 20 (with rank-decay sizing) | +0.1 from concentration |
| 13F funds | 3 | 6 (add Soros, Einhorn, Lone Pine) | +0.15 from diversification |
| Cross-asset rebal | none | none (independent systems) | neutral (avoids -0.2 from chasing) |
| Convergence threshold | log2(total)+1 | log2(core)+1 | +0.1 from noise reduction |
