# Wallet & Entity Discovery — Technical Analysis
> Solana Whale Watcher + US Stock Tracker
> April 2026

---

## 1. Crypto Wallet Sourcing — Ranked by Data Quality

### Tier S — Ground Truth (on-chain verified PnL)

**1. On-chain PnL calculation via Helius Transaction History**
- **Method**: Pull full tx history for candidate wallets using `getSignaturesForAddress` + `parseTransaction`. Reconstruct token flows: entry price, exit price, holding period, ROI per trade.
- **API**: Helius Enhanced Transactions API (`/v0/addresses/{address}/transactions`). 1 credit per parsed tx. Free tier = 100K credits/day = ~100K parsed transactions/day.
- **Data quality**: 10/10. This is the ONLY method that gives you verified, non-gameable PnL. Every other source is derivative.
- **Limitation**: Computationally expensive. Scoring 1 wallet over 30 days of active trading (~200 txs) = 200 credits. Budget: ~500 wallets/day for full backfill scoring.
- **Integration point**: Your `wallet-scorer.ts` (currently a stub) should implement this.

**2. Co-buyer detection from known profitable wallets**
- **Method**: When a tracked whale buys token X, query `getSignaturesForAddress` on that token's mint to find other wallets that bought within a ±30min window. Wallets that repeatedly co-buy with your known winners are candidates.
- **API**: Helius `getSignaturesForAddress` (1 credit each) + `parseTransaction` (1 credit each). ~10-20 credits per co-buyer scan.
- **Data quality**: 9/10. Behavioral signal — wallets that consistently appear alongside winners are either: (a) following the same alpha sources, or (b) part of the same fund/group. Both are valuable.
- **Your codebase already supports this**: `WalletSource` type includes `"co-buyer"`, and `WalletState` has `"PROBATION"` for unverified discoveries.

### Tier A — High-Quality Aggregated Data

**3. Birdeye Top Traders API**
- **Endpoint**: `GET /defi/v3/token/top_traders` — returns top traders by PnL for any token.
- **API key**: Free tier gives 300 calls/min. Paid starts at $49/mo for 1500 calls/min.
- **Method**: For each token that triggers a convergence in your system, pull top traders. Cross-reference with your existing wallet list. New wallets that appear as top traders on multiple converged tokens = high-quality candidates.
- **Data quality**: 8/10. Birdeye computes PnL from on-chain data, but their methodology may miss some edge cases (partial fills, multi-hop routing). Still very reliable.
- **Integration**: Add a `BirdeyeClient` that runs post-convergence to discover wallets.

**4. Cielo Finance Wallet Analytics**
- **Endpoint**: `GET /api/v1/wallet/{address}/pnl` — returns realized PnL, win rate, avg trade size.
- **Free tier**: 100 requests/day. Paid: $29/mo for 10K requests/day.
- **Data quality**: 8/10. Pre-computed wallet-level PnL. Excellent for validation of candidates found via other methods. Not great for discovery (you need to already have the address).
- **Best use**: Validation layer. Found a wallet via co-buyer detection? Run it through Cielo to confirm profitability before promoting from PROBATION to ACTIVE.

**5. Jupiter Swap Volume Leaders**
- **No direct API for leaderboard**. Must be reconstructed from on-chain data.
- **Method**: Use Helius to parse Jupiter program transactions (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`), extract signers, aggregate by volume.
- **Data quality**: 7/10. High volume ≠ high profit. But high volume on Jupiter specifically (vs Raydium) correlates with more sophisticated traders who use aggregation.

### Tier B — Useful but Noisy

**6. Axiom Pro Leaderboard**
- **Access**: Web scraping only, no public API. Leaderboard at axiom.trade shows top PnL traders.
- **Method**: Puppeteer/Playwright scrape, or manual export. Addresses are public on the leaderboard.
- **Data quality**: 6/10. Self-selecting bias — only shows traders using Axiom's interface. Misses all Jupiter/Raydium direct users. PnL calculation may differ from on-chain reality. However, the wallets shown ARE real on-chain addresses you can verify independently.
- **Risk**: Leaderboard gameable via wash trading on low-liquidity tokens.

**7. Manual Solscan Research**
- **Method**: Browse Solscan's "Top Accounts" or manually investigate wallets found in Discord alpha groups.
- **Data quality**: 5/10. Time-consuming, not scalable, subject to survivorship bias. Useful for initial seeding (which you've already done) but not for ongoing discovery.

### Tier C — Supplementary

**8. Helius Transaction History Analysis (brute force)**
- **Method**: Monitor high-value swaps across ALL Helius webhook events (not just tracked wallets), identify wallets with unusually high success rates.
- **Data quality**: 4/10 without PnL verification. The raw signal is interesting but requires Tier S validation to be actionable.
- **Credit cost**: Very high. Monitoring all swaps would require the Business tier ($499/mo, 100M credits/day).

---

## 2. Helius Free Tier Capacity

### Webhook Credit Cost
- **Enhanced Webhooks: 0 credits per event delivery**. Helius webhooks are push-based — they consume zero credits from your daily allocation. The 100K credits/day budget is for REST API calls only.
- **Webhook limits (free tier)**:
  - Max webhooks: 2
  - Max addresses per webhook: 100,000
  - Event types: SWAP, TRANSFER, NFT_SALE, etc.
  - Delivery: HTTP POST to your endpoint
  - Rate: No rate limit on incoming webhook events

### What costs credits:
| API Call | Credits |
|----------|---------|
| `parseTransaction` | 1 |
| `getSignaturesForAddress` | 1 |
| `getAsset` (DAS) | 1 |
| `getAssetsByOwner` | 1 |
| `searchAssets` | 1 |
| Enhanced Webhook events | **0** |

### Practical wallet limit
- **Webhook addresses**: You can track up to 100,000 wallets on the free tier (2 webhooks × 100K addresses each, though the practical limit per webhook is ~100K).
- **Scoring bottleneck**: The real constraint is scoring. If you score each wallet monthly (200 txs × 1 credit = 200 credits/wallet), 100K credits/day lets you score ~500 wallets/day = ~15,000 wallets/month.
- **Recommended sweet spot for your system**: **50-100 tracked wallets** in the active pool, with a **500-wallet candidate pipeline** being continuously scored and promoted/demoted.

### Your current 10 wallets: massively underutilizing capacity
Your seed file has 10 wallets, 3 of which are useless for copy-trading (Jump Crypto = market maker, Alameda = dead, Jito = infrastructure). Effective tracking: 7 wallets. You should be at 50-100 minimum.

---

## 3. Stock Data — Quiver vs Alternatives

### Quiver Quantitative
| Feature | Free | Pro ($20/mo) | Enterprise |
|---------|------|-------------|------------|
| Congressional trades | 100 req/day, 30-day delay | Real-time, 10K req/day | Custom |
| Senator/Rep filtering | Yes | Yes | Yes |
| Historical depth | 1 year | Full history | Full |
| 13F filings | No | Yes | Yes |
| Insider trades | No | Yes | Yes |
| API format | JSON REST | JSON REST | JSON REST |

### What you're missing on free tier
1. **30-day delay** on congressional disclosures. Senators file within 45 days of a trade (STOCK Act). Free Quiver adds another 30 days. Total lag: **45-75 days**. Alpha is largely gone.
2. **No 13F data**. Institutional holdings (hedge funds, family offices managing >$100M) require Pro.
3. **100 requests/day cap**. Enough for polling but not backtesting or discovery.

### Better free sources

**SEC EDGAR EFTS (Full-Text Search System)**
- **URL**: `https://efts.sec.gov/LATEST/search-index?q=...`
- **Rate limit**: 10 requests/sec with User-Agent header including email.
- **Advantage**: Zero-delay access to raw filings (4, 13F-HR, 13F-HR/A).
- **Congressional**: Search for `<formType>4</formType>` with issuer filtering for known senator-held securities.
- **13F**: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=13F-HR&dateb=&owner=include&count=40`
- **Data quality**: 10/10 — this is the primary source. Quiver just repackages it.

**Senate.gov eFD (Electronic Financial Disclosures)**
- **URL**: `https://efdsearch.senate.gov/search/`
- **No API**, but structured HTML that can be scraped.
- **This is the actual source** for periodic transaction reports (PTR) that senators file.
- **Advantage**: No delay — filings appear here before Quiver processes them.
- **Limitation**: Scraping-only, fragile, needs maintenance.

**House.gov Financial Disclosures**
- **URL**: `https://disclosures-clerk.house.gov/PublicDisclosure/FinancialDisclosure`
- Same story — primary source, no API, scrapeable.

**Capitol Trades (capitoltrades.com)**
- Free web access to recent congressional trades.
- No API, but cleaner scraping target than Senate.gov.

### Recommendation
Use **SEC EDGAR EFTS as primary** (free, real-time, rate-generous) + **Quiver free tier as validation layer**. If congressional alpha matters, the $20/mo Pro tier eliminates the 30-day delay and is worth it.

---

## 4. Auto-Discovery Pipeline — Technical Design

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  DISCOVERY PIPELINE                       │
│                                                           │
│  ┌──────────┐   ┌───────────┐   ┌──────────┐            │
│  │ Sources  │──▶│ Candidate │──▶│ Scoring  │            │
│  │ (ingest) │   │   Pool    │   │  Engine  │            │
│  └──────────┘   └───────────┘   └──────────┘            │
│       │              │               │                    │
│  - co-buyer     500 wallets    PnL calc via              │
│  - birdeye      in PROBATION   Helius tx history         │
│  - convergence                                            │
│    participants      │               │                    │
│                      ▼               ▼                    │
│               ┌──────────┐   ┌──────────────┐            │
│               │ Promote/ │◀──│  Score Card  │            │
│               │  Demote  │   │  win_rate    │            │
│               └──────────┘   │  avg_roi     │            │
│                    │         │  trade_count  │            │
│                    ▼         │  sharpe_proxy │            │
│              ACTIVE pool     └──────────────┘            │
│              (50-100 wallets)                              │
│              tracked via webhook                          │
└─────────────────────────────────────────────────────────┘
```

### Implementation — 4 Jobs

#### Job 1: Co-Buyer Scanner (runs on every convergence event)
```
Trigger: convergence.ts detects convergence on token X
Action:
  1. Pull recent buyers of token X via getSignaturesForAddress on the token mint
  2. Filter: exclude known wallets, exclude < $100 trades
  3. For each new wallet: insert into wallets table with source="co-buyer", state="NEW"
  4. Max 10 new candidates per convergence event (rate limit)
Credit cost: ~20-50 credits per convergence event
```

#### Job 2: Birdeye Top Trader Scanner (daily cron, 2 AM)
```
Action:
  1. Get list of tokens with recent convergences (last 7 days)
  2. For each token: call Birdeye /defi/v3/token/top_traders
  3. Extract top 20 profitable wallets per token
  4. Deduplicate across tokens — wallets appearing on 2+ token leaderboards get priority
  5. Insert new candidates with source="discovered", state="NEW"
Credit cost: 0 Helius credits (Birdeye API). ~50 Birdeye API calls/day.
```

#### Job 3: Wallet Scorer (daily cron, 4 AM)
```
Action:
  1. Select wallets in state NEW or PROBATION, ordered by oldest last_scored_at
  2. For each wallet (batch of 100/day):
     a. Pull last 30 days of tx history via Helius getSignaturesForAddress
     b. Parse each SWAP tx: extract token, direction, amount, timestamp
     c. Match buys to sells for same token → compute per-trade PnL
     d. Aggregate: win_rate, avg_roi, total_trades, sharpe_proxy
     e. Update wallet row with scores
  3. Promote: win_rate > 55% AND total_trades > 10 AND avg_roi > 5% → state="ACTIVE"
  4. Demote: win_rate < 40% OR avg_roi < -10% → state="DEMOTED"
  5. Prune: state="DEMOTED" for > 30 days → state="PRUNED", active=0
Credit cost: ~200 credits/wallet × 100 wallets = 20,000 credits/day (well within 100K budget)
```

#### Job 4: Webhook Sync (runs after Job 3)
```
Action:
  1. Collect all wallets where state="ACTIVE" and active=1
  2. Call helius.updateWebhook() with the new address list
  3. Log additions/removals
Credit cost: 1 API call
```

### Scoring Formula

```typescript
interface WalletScoreCard {
  winRate: number;        // % of trades with positive PnL
  avgRoi: number;         // mean ROI per trade
  medianRoi: number;      // median ROI (robust to outliers)
  tradeCount: number;     // total trades in scoring window
  sharpeProxy: number;    // avgRoi / stddev(roi) — risk-adjusted return
  maxDrawdown: number;    // worst peak-to-trough
  avgHoldTime: number;    // mean seconds between buy and sell
  dexDiversity: number;   // number of unique DEXes used (>1 = sophisticated)
}

function compositeScore(card: WalletScoreCard): number {
  const w = {
    winRate: 0.25,
    sharpeProxy: 0.25,
    avgRoi: 0.20,
    tradeCount: 0.15,  // more trades = more confidence
    maxDrawdown: 0.10,  // penalize huge drawdowns
    dexDiversity: 0.05
  };
  
  return (
    w.winRate * normalize(card.winRate, 0.3, 0.8) +
    w.sharpeProxy * normalize(card.sharpeProxy, 0, 3) +
    w.avgRoi * normalize(card.avgRoi, -0.1, 0.5) +
    w.tradeCount * normalize(card.tradeCount, 5, 100) +
    w.maxDrawdown * normalize(1 - card.maxDrawdown, 0, 1) +
    w.dexDiversity * normalize(card.dexDiversity, 1, 5)
  ) * 100;
}
```

### Promotion Thresholds

| Score Range | State | Action |
|-------------|-------|--------|
| 70-100 | ACTIVE | Track via webhook, eligible for copy-trading |
| 50-69 | PROBATION | Track via webhook, observe only (no copy) |
| 30-49 | DORMANT | Remove from webhook, re-score monthly |
| 0-29 | DEMOTED | Remove from webhook, re-score in 90 days |

---

## 5. Optimal Fleet Size

### Crypto Wallets
| Tier | Count | Purpose |
|------|-------|---------|
| ACTIVE (copy-eligible) | 30-50 | Core fleet, webhook-tracked, convergence signals trigger execution |
| PROBATION (observe) | 50-100 | Webhook-tracked, building score history, no execution |
| Candidate pool | 300-500 | Not tracked, scored periodically via tx history |
| **Total webhook addresses** | **80-150** | Well within 100K Helius limit |

### Stock Entities
| Category | Count | Source |
|----------|-------|--------|
| US Senators | 20-30 most active traders | Quiver/EDGAR — focus on Finance/Armed Services/Intelligence committee members |
| US Representatives | 10-20 most active | Same — smaller because they disclose less reliably |
| Hedge fund 13Fs | 10-15 super-performers | Berkshire, Citadel, Renaissance, Appaloosa, Baupost, etc. |
| Insider buys (Form 4) | Aggregate signal | Track cluster insider buying (3+ insiders at same company within 30 days) |
| **Total tracked entities** | **60-80** | |

### Why not more?
- **Signal-to-noise**: Above 50 active crypto wallets, convergence signals become noisy (more false positives from random overlap).
- **Your convergence formula** `threshold = max(2, floor(log2(total_wallets) + 1))`: at 50 wallets, threshold = max(2, floor(5.64+1)) = 6 wallets must converge. At 100 wallets, threshold = 7. The threshold scales logarithmically — you need proportionally more wallets agreeing, which reduces false positives but also reduces signal frequency.
- **Scoring budget**: 100 wallets in ACTIVE+PROBATION × monthly re-scoring = trivial credit cost. 500 candidates × quarterly scoring = still fine.

---

## 6. Implementation Priority for Your Codebase

Your `wallet-scorer.ts` is a stub. The discovery pipeline requires these changes:

1. **Implement `wallet-scorer.ts`** — the PnL calculation engine using Helius tx history
2. **Add `src/jobs/co-buyer-scanner.ts`** — triggered post-convergence
3. **Add `src/jobs/discovery-cron.ts`** — daily Birdeye top trader scan
4. **Extend `WalletModel`** — add `updateScore()`, `promote()`, `demote()` methods
5. **Extend `WalletMonitor.syncWebhook()`** — already works, just needs to be called after scoring job
6. **Add Birdeye client** — `src/blockchain/birdeye-client.ts`
7. **Update convergence threshold** — currently hardcoded at `mvpThreshold: 2`, should be dynamic based on active wallet count

The `WalletSource` type already supports `"discovered"` and `"co-buyer"`. The `WalletState` enum already has the full lifecycle (`NEW → PROBATION → ACTIVE → DORMANT → DEMOTED → PRUNED`). The schema is ready — the logic just needs to be built.
