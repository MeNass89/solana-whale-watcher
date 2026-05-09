# Solana Whale Watcher — Architecture Audit Report

> **⚠️ HISTORICAL SNAPSHOT — pre-remediation.** This report was taken 2026-05-04 to plan the
> remediation work that ran 2026-05-09. Several gaps below (notably GAP 6 — co-buyer scanner,
> GAP 7 — webhook health) have since been implemented. See `src/jobs/co-buyer-scanner.ts`,
> `src/jobs/webhook-health.ts`, and the post-convergence hook in `src/engine/alert-manager.ts`
> for the current state. Use this document for historical context only.

**Date:** 2026-05-04  
**Auditor:** Claude Sonnet 4.6 (via expert consensus from 41 YouTube videos + full codebase read)  
**Scope:** Full comparison of current TypeScript/Node.js implementation against pro consensus findings.

---

## 1. What the System Does Well

### Solid ingestion pipeline (MVP-complete)
- `helius-client.ts` registers `enhanced` SWAP webhooks correctly, listens only to `SWAP` transaction types, handles webhook creation vs. update via `HELIUS_WEBHOOK_ID`.
- `transaction-parser.ts` maps `EnhancedTransaction` token transfers to typed `ITradeEvent` (BUY/SELL, mint, amount, walletAddress, solAmount). Logic is clean and handles multi-wallet token transfers.
- `convergence.ts` computes convergence over a configurable time window (`CONVERGENCE_WINDOW_MINUTES`, default 120 min). Threshold is dynamic via `log2(totalWallets) + 1`.
- Alert tiers (`WATCH / NOTABLE / CRITICAL`) are implemented and properly suppressed at WATCH tier — no accidental Discord spam.
- Discord alerter is production-ready: embeds include Birdeye, Jupiter, and DexScreener links.

### Execution layer is spec-complete (partially)
- `jupiter-client.ts` exists with real Jupiter V6 `/v6/quote` + `/v6/swap` calls.
- Jito bundle submission is wired: `config.execution.jitoBlockEngineUrl` points to `mainnet.block-engine.jito.wtf`, bundles submitted via `POST /api/v1/bundles`.
- `position-manager.ts` implements a full stop-loss ladder: first-30-min stop at -8%, hard stop floor at -25%, ceiling at -45%, rug detection at -60% in 5 min, trailing stop, time stop, take-profit levels.
- `risk-engine.ts` has 3-phase sizing ramp (cold_start / validated / mature), honeypot simulation gate, mint-authority check, top-holder concentration check, portfolio heat cap at 6%.
- Paper trading mode is implemented: `EXECUTION_MODE=paper` skips real Jupiter calls, fires `[PAPER]` Discord notifications, tracks virtual balance.

### Infrastructure is serviceable
- SQLite with migrations; `WalletState` enum (`NEW → PROBATION → ACTIVE → DORMANT → DEMOTED → PRUNED`) is in schema.
- Tailscale Funnel + shell script auto-updates Helius webhook URL on tunnel restart.
- Structured JSON logging via Pino.
- Fastify server with HMAC signature verification on the webhook endpoint.

---

## 2. Critical Gaps vs. Expert Consensus

### GAP 1 — Ingestion reliability: Helius webhooks vs. Yellowstone gRPC [CRITICAL]

**Current:** Helius enhanced webhooks over HTTPS POST. Known failure: webhook was auto-disabled on 2026-04-26 after 100% failure rate over 24h. The system has no automatic re-enablement, no health check, no reconnection logic. The only mitigation is a manual `setup-webhooks` script.

**Expert consensus:** Pros use Yellowstone gRPC streams (or Helius LaserStream WebSocket). Webhooks are inherently fragile — Helius disables them after sustained 100% failure, and there is no retry/re-enable API. gRPC streams are persistent, server-push, and never auto-disable.

**Impact:** Every minute the webhook is disabled = 0 trades detected. This has already caused complete blindness at least once.

**Recommended fix (ranked):**
1. **Immediate:** Add a scheduled health-check job that polls Helius GET `/v0/webhooks/{id}` every 15 minutes. If `enabled: false`, call PUT to re-enable with the same config. Add to `src/jobs/webhook-health.ts`, schedule via `setInterval` in `index.ts`.
2. **Medium-term:** Migrate ingestion to **Helius LaserStream** (WebSocket, no HTTP endpoint required) or **Yellowstone gRPC** (requires QuickNode or self-hosted Yellowstone node). LaserStream is the path-of-least-resistance since you're already paying Helius.
3. **Long-term:** Dual-feed: LaserStream primary + webhook as fallback, deduplicated by signature.

---

### GAP 2 — Wallet vetting: `wallet-scorer.ts` is a stub [CRITICAL]

**Current:** `wallet-scorer.ts` is a stub with no implemented logic. The `WalletState` lifecycle (`NEW → ACTIVE`) exists in schema but the scoring engine that drives promotion/demotion is unbuilt. Wallets are manually added to `ACTIVE` state with no quantitative gate.

**Expert consensus:** Requires at minimum:
- 30+ trades over 60+ days (no lucky streaks)
- Win rate > 55% on round-trip trades
- Positive cumulative PnL over 90 days
- Avg ROI > 5%
- Minimum 5 SOL balance (skin in the game)
- MEV bot exclusion (uniform tiny profits, hold time < 1s)
- Wash trading exclusion (same token buy+sell within same block)
- Exchange hot wallet exclusion (e.g., MEXC, Gate.io)

**Impact:** Tracking wallets that are MEV bots, exchange wallets, or serial ruggers will produce meaningless convergences and bad trades.

**Recommended implementation:**
```
src/jobs/wallet-scorer.ts (IMPLEMENT — currently stub)
  1. Pull 30 days of tx history via Helius getSignaturesForAddress
  2. Parse each SWAP: token, direction, amount, timestamp
  3. Match buy→sell pairs for same token → realized PnL per trade
  4. Compute: win_rate, avg_roi, total_trades, hold_time_median
  5. MEV filter: if hold_time_median < 30s → flag MEV, do not promote
  6. Wash filter: if buy+sell of same token within 5 min > 20% of trades → flag
  7. PROMOTE: win_rate > 55% AND total_trades > 30 AND avg_roi > 5%
  8. DEMOTE: win_rate < 40% OR avg_roi < -10%
Run daily at 04:00 via setInterval or node-cron.
```

---

### GAP 3 — Transaction parser: no hold-time or MEV filtering [HIGH]

**Current:** `transaction-parser.ts` fires a `ITradeEvent` for every SWAP involving a monitored wallet. There is no minimum hold-time check, no MEV detection at parse time, no wash-trade detection.

**Expert consensus:** Minimum hold time > 1 minute. MEV bots operate in milliseconds. Without this filter, MEV arbitrage tx will register as "whale buys" and trigger false convergences.

**Recommended fix:** In `parseEnhancedTransaction`, add a timestamp delta check against the wallet's last opposite trade for the same token. If `abs(current_ts - last_opposite_trade_ts) < 60s` → discard the event and log a MEV suspect.

---

### GAP 4 — Execution: slippage parameters misaligned with expert consensus [HIGH]

**Current (from `jupiter-client.ts` design spec):**
- `>$500k LP: 100 bps (1%)`
- `$100k-$500k: 300 bps (3%)`
- `$50k-$100k: 500 bps (5%)`
- `<$50k: SKIP`

**Expert consensus from YouTube videos:** Meme coin copy traders use 15–40% slippage on entries. The 1–5% tier the system uses is appropriate for liquid tokens (mid-caps) but will produce systematic transaction failures on low-liquidity meme tokens — the exact tokens whales tend to buy early.

**Recommended fix:** Add a `MEME` liquidity tier: if `pool TVL < $100k AND token age < 7 days` → use 2500 bps (25%) slippage, or pass `dynamicSlippage: { minBps: 500, maxBps: 3000 }` to Jupiter. Already present in the panic-exit path (2500 bps) — needs to be available at entry too.

---

### GAP 5 — No Birdeye / DexScreener API integration [MEDIUM]

**Current:** Birdeye and DexScreener appear only as hyperlinks in Discord embeds (`formatter.ts`). No API client exists. Token metadata comes from Helius DAS only.

**Expert consensus:** BirdEye API + DexScreener for real-time price, liquidity, and token age data. These are used to:
1. Gate entries by pool TVL (already in risk engine spec, but data source missing)
2. Source wallet P&L for scoring
3. Track post-signal price performance

**Recommended fix:**
- `src/blockchain/birdeye-client.ts`: implement `/defi/token_overview` for TVL + price, `/trader/gainers-losers` for wallet leaderboard.
- `src/blockchain/dexscreener-client.ts`: implement `/tokens/{mint}` for pair data, age, volume.
- Wire into `risk-engine.ts` honeypot/TVL checks (currently rely on Jupiter quote price only).

---

### GAP 6 — No co-buyer discovery pipeline [MEDIUM]

**Current:** Wallets are added manually. The schema supports `WalletSource = "discovered" | "co-buyer"` but the discovery job (`src/jobs/co-buyer-scanner.ts`) does not exist.

**Expert consensus:** Top performers build self-expanding wallet lists. When a convergence fires, scan which OTHER wallets bought the same token within the window — they are co-buyer candidates. Auto-add as `NEW` state for scoring.

**Recommended fix:** Post-convergence hook in `alert-manager.ts` that queries recent trades for the same token mint within the window, extracts non-monitored wallet addresses, and inserts them as `WalletSource="co-buyer"`, `WalletState="NEW"`.

---

### GAP 7 — No automatic webhook re-enablement [HIGH]

**Current:** When Helius disables the webhook (100% failure rate = tunnel down), the only recovery path is manually running `npm run setup-webhooks`. There is no monitoring, no alert, no automatic recovery.

**Recommended fix:** Health-check job in `src/jobs/webhook-health.ts`:
```typescript
async function checkAndHealWebhook() {
  const wh = await helius.getWebhook(config.helius.webhookId);
  if (!wh.enabled) {
    logger.warn("Helius webhook disabled — re-enabling");
    await helius.updateWebhook(...);
    await discord.send("[ALERT] Webhook was disabled — re-enabled automatically");
  }
}
setInterval(checkAndHealWebhook, 15 * 60 * 1000); // every 15 min
```

---

### GAP 8 — Convergence threshold formula uses total wallet count, not core count [LOW]

**Current:** `getThreshold()` uses `log2(totalWallets) + 1`. At 59 wallets, threshold ≈ 7. This means 7+ wallets must buy the same token to fire a signal — extremely conservative and may suppress real alpha.

**Expert recommendation:** Use core wallet count as the denominator:
```typescript
threshold = max(2, floor(log2(coreCount) + 1)) // = 4-5 at 15 core wallets
```
And weight core wallets (1.0x) vs. discovery wallets (0.5x) so a convergence of 2 cores equals a convergence of 4 discovery wallets.

---

## 3. Yellowstone gRPC: Replace Helius Webhooks?

**Verdict: Yes, eventually. Immediate priority: auto-heal + Helius LaserStream.**

| Option | Latency | Reliability | Cost | Effort |
|--------|---------|------------|------|--------|
| Current webhooks | ~1-3s | Fragile (auto-disables) | Included in Helius | Deployed |
| Webhook + health-check | ~1-3s | Acceptable | Included | Low (1-2h) |
| Helius LaserStream | ~200ms | High (persistent WS) | +$49/mo (Growth plan) | Medium (1-2d) |
| Yellowstone gRPC | ~50ms | Highest | +$100-300/mo (dedicated node) | High (3-5d, new protocol) |

**Recommendation:** 
1. Ship the webhook health-check immediately (closes the re-enable gap, 2h work).
2. Migrate to Helius LaserStream in the next sprint (same provider, WebSocket-based, no HTTP endpoint dependency, eliminates the auto-disable risk entirely).
3. Yellowstone gRPC only if latency becomes a bottleneck (front-running requires < 100ms — not needed for copy trading where 1-3s is fine).

---

## 4. Does the System Need Wallet Vetting Logic?

**Yes. This is the #1 alpha-quality driver.** The entire system's edge depends on the quality of tracked wallets. Running 59 unvetted wallets produces:
- False convergences from MEV bots trading the same arb opportunities
- Convergences from exchange hot wallets doing routine settlement
- Signal from serial ruggers who coordinate buys then dump

The `wallet-scorer.ts` stub must be implemented before going live with real capital.

---

## 5. Risk Management Assessment

### What's implemented and correct
- 3-phase position sizing (cold 0.5%, validated 1%, mature 1.5% base) — matches expert 2-5% bankroll guideline
- Hard stop at -25% to -45%, rug stop at -60%/5min — appropriate
- Portfolio heat cap at 6% — correct
- Paper mode mandatory for first 2-3 weeks — correct
- Circuit breakers: daily -7%, weekly -15%, monthly -25% — appropriate
- Jito bundle submission — critical for MEV protection, implemented

### Gaps
- **No stop on portfolio-level daily drawdown during paper mode** — the daily_loss check is implemented but the paper balance might not reflect mark-to-market accurately without real price feeds
- **Honeypot simulation** is in the risk engine spec but the actual roundtrip call is not confirmed implemented (calls to Jupiter for a simulated sell pre-entry)
- **No max new trades per day hard cap** during cold start — spec says max 3/day but implementation status unconfirmed
- **Priority fee** should use Helius `getPriorityFeeEstimate` dynamically — confirm this is not static in `jupiter-client.ts`

---

## 6. Ranked Action Items

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| 1 | **Implement webhook health-check job** (auto re-enable every 15 min) | Eliminates blind spots from auto-disable | 2h |
| 2 | **Implement `wallet-scorer.ts`** (PnL scoring, MEV filter, promotion/demotion) | Core alpha quality gate | 2-3d |
| 3 | **Add hold-time / wash-trade filter in `transaction-parser.ts`** | Eliminates MEV false positives | 4h |
| 4 | **Migrate to Helius LaserStream** (replace HTTP webhook endpoint) | Eliminates webhook reliability class of bugs | 2d |
| 5 | **Add Birdeye client** for pool TVL + token age in risk gate | Makes honeypot/TVL checks functional | 1d |
| 6 | **Increase meme-tier slippage to 15-25%** for low-liquidity tokens | Reduces failed entries on meme coins | 2h |
| 7 | **Fix convergence threshold formula** (use coreCount, add tier weighting) | Better signal/noise ratio | 4h |
| 8 | **Implement co-buyer discovery post-convergence** | Self-expanding wallet list | 1d |
| 9 | **Add DexScreener client** for real-time pair data | Improves token age / liquidity accuracy | 4h |
| 10 | **Verify honeypot simulation and daily trade cap** are wired in `risk-engine.ts` | Prevents catastrophic entries | 2h |
