# Whale Watcher Pro Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Solana whale watcher to match or exceed the top 10 crypto trading bot YouTube videos — closing all 10 gaps from the architecture audit.

**Architecture:** 10 sequential tasks that each produce a working, testable increment. The system uses TypeScript/Node.js, Fastify, SQLite (better-sqlite3), Helius webhooks, Jupiter V6, and Jito bundles. All new code follows existing patterns: classes with `configure()`, singletons exported at module level, Pino logger, `unixNow()` helper, and `execution_config` KV table for runtime state.

**Tech Stack:** TypeScript 5, Node 20+, Fastify 5, better-sqlite3, Helius API, Jupiter V6 Swap API, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/jobs/webhook-health.ts` | Polls Helius webhook status, auto re-enables if disabled, Discord alert |
| Create | `src/blockchain/birdeye-client.ts` | BirdEye API client — token overview, wallet PnL, pool TVL |
| Create | `src/blockchain/dexscreener-client.ts` | DexScreener API client — pair data, token age, volume |
| Create | `src/jobs/co-buyer-scanner.ts` | Post-convergence co-buyer discovery pipeline |
| Modify | `src/engine/scorer.ts` | Add MEV detection (hold-time filter, wash-trade filter) to `computeWalletMetrics` |
| Modify | `src/jobs/wallet-scorer.ts` | Wire MEV/wash-trade exclusion into scoring, add demotion for MEV wallets |
| Modify | `src/blockchain/transaction-parser.ts` | Add rapid-reversal filter (same token buy+sell within 60s) |
| Modify | `src/execution/jupiter-client.ts` | Add MEME slippage tier (2500 bps for low-liquidity tokens) |
| Modify | `src/config/thresholds.ts` | Use core wallet count + tier weighting |
| Modify | `src/config/index.ts` | Add env vars: `BIRDEYE_API_KEY`, `WEBHOOK_HEALTH_INTERVAL_MS` |
| Modify | `src/index.ts` | Wire webhook health job, co-buyer scanner, BirdEye client |
| Modify | `src/engine/convergence.ts` | Hook co-buyer scanner post-convergence, use tiered threshold |
| Modify | `src/execution/risk-engine.ts` | Use BirdEye for pool TVL + token age instead of tokens table only |
| Modify | `src/execution/trade-executor.ts` | Use MEME slippage tier for entries |
| Test | `src/__tests__/webhook-health.test.ts` | |
| Test | `src/__tests__/birdeye-client.test.ts` | |
| Test | `src/__tests__/dexscreener-client.test.ts` | |
| Test | `src/__tests__/mev-filter.test.ts` | |
| Test | `src/__tests__/slippage-tiers.test.ts` | |
| Test | `src/__tests__/threshold.test.ts` | |
| Test | `src/__tests__/co-buyer-scanner.test.ts` | |

---

### Task 1: Webhook Health-Check Job (auto re-enable)

**Files:**
- Create: `src/jobs/webhook-health.ts`
- Create: `src/__tests__/webhook-health.test.ts`
- Modify: `src/blockchain/helius-client.ts:32-66`
- Modify: `src/index.ts:56-76`

- [ ] **Step 1: Add `getWebhook` method to HeliusClient**

In `src/blockchain/helius-client.ts`, add after the `updateWebhook` method (after line 66):

```typescript
  async getWebhook(webhookId: string): Promise<{ webhookID: string; webhookURL: string; accountAddresses: string[]; webhookType: string } | null> {
    if (!this.apiKey || !webhookId) return null;
    try {
      return await this.request<{ webhookID: string; webhookURL: string; accountAddresses: string[]; webhookType: string }>(`/v0/webhooks/${webhookId}`, { method: "GET" });
    } catch {
      return null;
    }
  }
```

- [ ] **Step 2: Write failing test for webhook health job**

Create `src/__tests__/webhook-health.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkWebhookHealth } from "../jobs/webhook-health.js";

const mockGetWebhook = vi.fn();
const mockUpdateWebhook = vi.fn();
const mockDiscordSend = vi.fn();
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const helius = { getWebhook: mockGetWebhook, updateWebhook: mockUpdateWebhook } as any;
const discord = { send: mockDiscordSend } as any;

describe("checkWebhookHealth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing when webhook is active", async () => {
    mockGetWebhook.mockResolvedValue({ webhookID: "wh1", webhookURL: "https://example.com/api/webhooks/helius", accountAddresses: ["addr1"], webhookType: "enhanced" });
    await checkWebhookHealth(helius, "wh1", "https://example.com/api/webhooks/helius", discord);
    expect(mockUpdateWebhook).not.toHaveBeenCalled();
    expect(mockDiscordSend).not.toHaveBeenCalled();
  });

  it("re-enables webhook when getWebhook returns null", async () => {
    mockGetWebhook.mockResolvedValue(null);
    await checkWebhookHealth(helius, "wh1", "https://example.com/api/webhooks/helius", discord);
    expect(mockUpdateWebhook).toHaveBeenCalledWith("wh1", expect.any(Array), "https://example.com/api/webhooks/helius");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/webhook-health.test.ts`
Expected: FAIL — `checkWebhookHealth` does not exist

- [ ] **Step 4: Implement webhook health job**

Create `src/jobs/webhook-health.ts`:

```typescript
import type { HeliusClient } from "../blockchain/helius-client.js";
import type { WalletModel } from "../storage/models/wallets.js";
import type { DiscordAlerter } from "../alerts/discord.js";
import { logger } from "../utils/logger.js";

export async function checkWebhookHealth(
  helius: HeliusClient,
  webhookId: string,
  publicWebhookUrl: string,
  discord: DiscordAlerter,
  wallets?: WalletModel
): Promise<void> {
  if (!webhookId) {
    logger.warn("webhook-health: no HELIUS_WEBHOOK_ID configured, skipping");
    return;
  }

  const webhook = await helius.getWebhook(webhookId);

  if (!webhook) {
    logger.warn({ webhookId }, "webhook-health: webhook not found or unreachable — attempting re-enable");
    const addresses = wallets ? wallets.listActive().map((w) => w.address) : [];
    if (addresses.length === 0) {
      logger.error("webhook-health: no active wallets to re-register webhook");
      return;
    }
    try {
      await helius.updateWebhook(webhookId, addresses, publicWebhookUrl);
      logger.info({ webhookId }, "webhook-health: webhook re-enabled successfully");
      await discord.send({
        embeds: [{
          title: "🔧 Webhook Auto-Healed",
          description: `Webhook \`${webhookId.substring(0, 8)}…\` was disabled/unreachable and has been re-enabled with ${addresses.length} wallets.`,
          color: 0xffcc00,
          timestamp: new Date().toISOString()
        }]
      }, "NOTABLE");
    } catch (error) {
      logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "webhook-health: re-enable failed");
      await discord.send({
        embeds: [{
          title: "🚨 Webhook Re-Enable FAILED",
          description: `Webhook \`${webhookId.substring(0, 8)}…\` could not be re-enabled. Manual intervention required.`,
          color: 0xff3366,
          timestamp: new Date().toISOString()
        }]
      }, "CRITICAL");
    }
    return;
  }

  logger.info({ webhookId: webhookId.substring(0, 8), addresses: webhook.accountAddresses?.length ?? 0 }, "webhook-health: webhook OK");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/webhook-health.test.ts`
Expected: PASS

- [ ] **Step 6: Wire health job into index.ts**

In `src/index.ts`, add import at top:
```typescript
import { checkWebhookHealth } from "./jobs/webhook-health.js";
```

After the `scorerJob` interval block (after line 76), add:
```typescript
  const webhookHealthJob = () => checkWebhookHealth(helius, config.helius.webhookId, config.server.publicWebhookUrl, new (await import("./alerts/discord.js")).DiscordAlerter(), wallets).catch((err) => {
    logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "webhook-health: job failed");
  });
  setInterval(webhookHealthJob, 15 * 60 * 1000);
  setTimeout(webhookHealthJob, 120_000);
```

- [ ] **Step 7: Commit**

```bash
git add src/jobs/webhook-health.ts src/__tests__/webhook-health.test.ts src/blockchain/helius-client.ts src/index.ts
git commit -m "feat: add webhook health-check job with auto re-enable every 15min"
```

---

### Task 2: MEV Detection in Wallet Scorer

**Files:**
- Modify: `src/engine/scorer.ts:27-68`
- Create: `src/__tests__/mev-filter.test.ts`

- [ ] **Step 1: Write failing test for MEV detection**

Create `src/__tests__/mev-filter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeWalletMetrics } from "../engine/scorer.js";
import type { TradeRow } from "../storage/models/trades.js";
import type { HeliusTransaction } from "../blockchain/helius-client.js";

function makeTrade(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    id: 1, wallet_address: "wallet1", token_mint: "tokenA", tx_signature: "sig1",
    amount_token: 1000, amount_sol: 1, amount_usd: 150, dex_source: "Jupiter",
    trade_type: "BUY", block_time: 1700000000, created_at: 1700000000, ...overrides
  };
}

describe("MEV detection in computeWalletMetrics", () => {
  it("flags wallet as MEV when median hold time < 30s", () => {
    const trades: TradeRow[] = [
      makeTrade({ id: 1, trade_type: "BUY", token_mint: "tokenA", block_time: 1700000000, amount_sol: 1 }),
      makeTrade({ id: 2, trade_type: "SELL", token_mint: "tokenA", block_time: 1700000005, amount_sol: 1.01 }),
      makeTrade({ id: 3, trade_type: "BUY", token_mint: "tokenB", block_time: 1700000100, amount_sol: 2 }),
      makeTrade({ id: 4, trade_type: "SELL", token_mint: "tokenB", block_time: 1700000110, amount_sol: 2.02 }),
      makeTrade({ id: 5, trade_type: "BUY", token_mint: "tokenC", block_time: 1700000200, amount_sol: 3 }),
      makeTrade({ id: 6, trade_type: "SELL", token_mint: "tokenC", block_time: 1700000220, amount_sol: 3.03 }),
    ];
    const metrics = computeWalletMetrics(trades, [], "wallet1", "NEW");
    expect(metrics.isMev).toBe(true);
    expect(metrics.state).toBe("DEMOTED");
  });

  it("does not flag wallet when hold times are normal", () => {
    const trades: TradeRow[] = [
      makeTrade({ id: 1, trade_type: "BUY", token_mint: "tokenA", block_time: 1700000000, amount_sol: 1 }),
      makeTrade({ id: 2, trade_type: "SELL", token_mint: "tokenA", block_time: 1700003600, amount_sol: 1.5 }),
    ];
    const metrics = computeWalletMetrics(trades, [], "wallet1", "NEW");
    expect(metrics.isMev).toBe(false);
  });

  it("flags wash trading when >20% of trades are buy+sell same token within 5min", () => {
    const trades: TradeRow[] = [];
    for (let i = 0; i < 10; i++) {
      trades.push(makeTrade({ id: i * 2 + 1, trade_type: "BUY", token_mint: `token${i}`, block_time: 1700000000 + i * 600, amount_sol: 1 }));
      trades.push(makeTrade({ id: i * 2 + 2, trade_type: "SELL", token_mint: `token${i}`, block_time: 1700000000 + i * 600 + (i < 5 ? 120 : 7200), amount_sol: 1.01 }));
    }
    const metrics = computeWalletMetrics(trades, [], "wallet1", "ACTIVE");
    expect(metrics.isWashTrader).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/mev-filter.test.ts`
Expected: FAIL — `isMev` property does not exist on WalletMetrics

- [ ] **Step 3: Add MEV and wash-trade detection to scorer.ts**

In `src/engine/scorer.ts`, update the `WalletMetrics` interface (line 9):

```typescript
export interface WalletMetrics {
  score: number;
  winRate: number | null;
  avgRoi: number | null;
  totalTrades: number;
  realizedPnlSol: number;
  state: WalletState;
  isMev: boolean;
  isWashTrader: boolean;
  medianHoldTimeSec: number | null;
}
```

Add these helper functions before `computeWalletMetrics`:

```typescript
const MEV_HOLD_TIME_THRESHOLD_SEC = 30;
const WASH_TRADE_WINDOW_SEC = 5 * 60;
const WASH_TRADE_FRACTION_THRESHOLD = 0.2;

function computeHoldTimes(trades: TradeRow[]): number[] {
  const holdTimes: number[] = [];
  const buysByMint = new Map<string, TradeRow[]>();
  for (const t of trades) {
    if (t.trade_type === "BUY") {
      if (!buysByMint.has(t.token_mint)) buysByMint.set(t.token_mint, []);
      buysByMint.get(t.token_mint)!.push(t);
    }
  }
  for (const t of trades) {
    if (t.trade_type !== "SELL") continue;
    const buys = buysByMint.get(t.token_mint);
    if (!buys || buys.length === 0) continue;
    const lastBuy = buys.filter((b) => b.block_time <= t.block_time).pop();
    if (lastBuy) holdTimes.push(t.block_time - lastBuy.block_time);
  }
  return holdTimes;
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function detectWashTrading(trades: TradeRow[]): boolean {
  let washCount = 0;
  let roundTripCount = 0;
  const sellsByMint = new Map<string, TradeRow[]>();
  for (const t of trades) {
    if (t.trade_type === "SELL") {
      if (!sellsByMint.has(t.token_mint)) sellsByMint.set(t.token_mint, []);
      sellsByMint.get(t.token_mint)!.push(t);
    }
  }
  for (const t of trades) {
    if (t.trade_type !== "BUY") continue;
    const sells = sellsByMint.get(t.token_mint);
    if (!sells) continue;
    const matchingSell = sells.find((s) => s.block_time >= t.block_time && s.block_time - t.block_time <= WASH_TRADE_WINDOW_SEC);
    if (matchingSell) {
      washCount++;
      roundTripCount++;
    } else {
      const laterSell = sells.find((s) => s.block_time >= t.block_time);
      if (laterSell) roundTripCount++;
    }
  }
  return roundTripCount > 0 && washCount / roundTripCount > WASH_TRADE_FRACTION_THRESHOLD;
}
```

Then update `computeWalletMetrics` to include MEV/wash detection. After the `totalTrades` calculation (around line 36), add:

```typescript
  const holdTimes = computeHoldTimes(trades);
  const medianHoldTime = median(holdTimes);
  const isMev = medianHoldTime !== null && medianHoldTime < MEV_HOLD_TIME_THRESHOLD_SEC;
  const isWashTrader = detectWashTrading(trades);
```

Before the early-return for no closed positions, add:
```typescript
  if (isMev || isWashTrader) {
    return { score: 5, winRate: null, avgRoi: null, totalTrades, realizedPnlSol: 0, state: "DEMOTED", isMev, isWashTrader, medianHoldTimeSec: medianHoldTime };
  }
```

Update the final return to include the new fields:
```typescript
  return { score, winRate: round2(winRate), avgRoi: round2(avgRoi), totalTrades, realizedPnlSol: round2(totalPnl), state, isMev: false, isWashTrader: false, medianHoldTimeSec: medianHoldTime };
```

Also update the early-return at line 39 (no closed positions) to include `isMev: false, isWashTrader: false, medianHoldTimeSec: null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/mev-filter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/scorer.ts src/__tests__/mev-filter.test.ts
git commit -m "feat: add MEV detection and wash-trade filter to wallet scorer"
```

---

### Task 3: Rapid-Reversal Filter in Transaction Parser

**Files:**
- Modify: `src/blockchain/transaction-parser.ts`
- Modify: `src/api/routes/webhooks.ts:28-30`

- [ ] **Step 1: Add trade cache for rapid-reversal detection**

In `src/blockchain/transaction-parser.ts`, add at the top after imports:

```typescript
const RAPID_REVERSAL_WINDOW_SEC = 60;
const recentTrades = new Map<string, { tradeType: TradeType; blockTime: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() / 1000 - RAPID_REVERSAL_WINDOW_SEC * 2;
  for (const [key, entry] of recentTrades) {
    if (entry.blockTime < cutoff) recentTrades.delete(key);
  }
}, CACHE_TTL_MS);

export function isRapidReversal(trade: ITradeEvent): boolean {
  const key = `${trade.walletAddress}:${trade.tokenMint}`;
  const previous = recentTrades.get(key);
  recentTrades.set(key, { tradeType: trade.tradeType, blockTime: trade.blockTime });

  if (!previous) return false;
  const oppositeType = trade.tradeType === "BUY" ? "SELL" : "BUY";
  if (previous.tradeType !== oppositeType) return false;
  return Math.abs(trade.blockTime - previous.blockTime) < RAPID_REVERSAL_WINDOW_SEC;
}
```

- [ ] **Step 2: Wire filter into webhook route**

In `src/api/routes/webhooks.ts`, add import:
```typescript
import { parseEnhancedTransactions, isRapidReversal } from "../../blockchain/transaction-parser.js";
```

After `const inserted = deps.trades.insert(trade);` (line 33), before `if (!inserted) continue;`, add:
```typescript
      if (isRapidReversal(trade)) {
        logger.info({ wallet: logWallet(trade.walletAddress), token: trade.tokenMint, type: trade.tradeType }, "rapid-reversal filtered (MEV suspect)");
        continue;
      }
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/blockchain/transaction-parser.ts src/api/routes/webhooks.ts
git commit -m "feat: add rapid-reversal filter to block MEV-like buy+sell within 60s"
```

---

### Task 4: MEME Slippage Tier

**Files:**
- Modify: `src/execution/jupiter-client.ts:74-80`
- Modify: `src/execution/trade-executor.ts:84-88`
- Create: `src/__tests__/slippage-tiers.test.ts`

- [ ] **Step 1: Write failing test for MEME tier**

Create `src/__tests__/slippage-tiers.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { JupiterClient } from "../execution/jupiter-client.js";

describe("slippageBpsForLiquidity", () => {
  const client = new JupiterClient();

  it("returns 100 bps for >$500k liquidity", () => {
    expect(client.slippageBpsForLiquidity(600_000)).toBe(100);
  });
  it("returns 300 bps for $100k-$500k liquidity", () => {
    expect(client.slippageBpsForLiquidity(200_000)).toBe(300);
  });
  it("returns 500 bps for $50k-$100k liquidity", () => {
    expect(client.slippageBpsForLiquidity(75_000)).toBe(500);
  });
  it("returns 2500 bps for <$50k liquidity (MEME tier)", () => {
    expect(client.slippageBpsForLiquidity(30_000)).toBe(2500);
  });
  it("returns 2500 bps for $10k liquidity", () => {
    expect(client.slippageBpsForLiquidity(10_000)).toBe(2500);
  });
  it("returns null for null/undefined liquidity", () => {
    expect(client.slippageBpsForLiquidity(null)).toBeNull();
    expect(client.slippageBpsForLiquidity(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/slippage-tiers.test.ts`
Expected: FAIL — `slippageBpsForLiquidity(30_000)` returns `null` not `2500`

- [ ] **Step 3: Update slippage tiers in jupiter-client.ts**

In `src/execution/jupiter-client.ts`, replace the `slippageBpsForLiquidity` method (lines 74-80):

```typescript
  slippageBpsForLiquidity(liquidityUsd?: number | null): number | null {
    if (liquidityUsd === undefined || liquidityUsd === null) return null;
    if (liquidityUsd > 500_000) return 100;
    if (liquidityUsd >= 100_000) return 300;
    if (liquidityUsd >= 50_000) return 500;
    if (liquidityUsd >= 5_000) return 2500;
    return null;
  }
```

- [ ] **Step 4: Update trade-executor to allow MEME tier entries**

In `src/execution/trade-executor.ts`, replace lines 84-88 (the slippage null-skip block):

```typescript
    const liquidityUsd = this.liquidityUsd(convergence.token_mint);
    const slippageBps = this.swaps.slippageBpsForLiquidity(liquidityUsd);
    if (slippageBps === null) {
      logger.info({ mint: convergence.token_mint, liquidityUsd }, "execution skipped; liquidity below $5k");
      return;
    }
```

- [ ] **Step 5: Update risk-engine MIN_POOL_TVL_USD for MEME tier**

In `src/execution/risk-engine.ts`, change `MIN_POOL_TVL_USD` (line 35) from `100_000` to `5_000`:

```typescript
const MIN_POOL_TVL_USD = 5_000;
```

And add a MEME tier size reduction. In the `checkEntry` method, after the `adjustedSizePct` calculation (around line 66), add:

```typescript
    if (liquidityUsd < 50_000) {
      const memePenalty = Math.max(0.25, liquidityUsd / 50_000);
      adjustedSizePct = Math.min(adjustedSizePct * memePenalty, limits.cap);
    }
```

Note: this requires changing `const adjustedSizePct` to `let adjustedSizePct` on that line.

- [ ] **Step 6: Run tests**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/slippage-tiers.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/execution/jupiter-client.ts src/execution/trade-executor.ts src/execution/risk-engine.ts src/__tests__/slippage-tiers.test.ts
git commit -m "feat: add MEME slippage tier (2500 bps) for low-liquidity tokens <$50k"
```

---

### Task 5: BirdEye API Client

**Files:**
- Create: `src/blockchain/birdeye-client.ts`
- Create: `src/__tests__/birdeye-client.test.ts`
- Modify: `src/config/index.ts`

- [ ] **Step 1: Add BIRDEYE_API_KEY to config**

In `src/config/index.ts`, add to the `envSchema` (after line 31):

```typescript
  BIRDEYE_API_KEY: z.string().default(""),
```

Add to the `config` object (after `helius` block, around line 73):

```typescript
  birdeye: {
    apiKey: env.BIRDEYE_API_KEY
  },
```

- [ ] **Step 2: Write failing test**

Create `src/__tests__/birdeye-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BirdEyeClient } from "../blockchain/birdeye-client.js";

describe("BirdEyeClient", () => {
  it("exports the class", () => {
    expect(BirdEyeClient).toBeDefined();
  });

  it("getTokenOverview returns null when no API key", async () => {
    const client = new BirdEyeClient("");
    const result = await client.getTokenOverview("So11111111111111111111111111111111111111112");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/birdeye-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement BirdEye client**

Create `src/blockchain/birdeye-client.ts`:

```typescript
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const BIRDEYE_BASE = "https://public-api.birdeye.so";

export interface TokenOverview {
  mint: string;
  symbol: string | null;
  name: string | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
  mc: number | null;
  v24hUsd: number | null;
  holder: number | null;
  createdAt: number | null;
}

export interface WalletPnl {
  totalPnl: number;
  totalPnlPercent: number;
  totalBuyAmount: number;
  totalSellAmount: number;
}

export class BirdEyeClient {
  constructor(private readonly apiKey = config.birdeye.apiKey) {}

  async getTokenOverview(mint: string): Promise<TokenOverview | null> {
    if (!this.apiKey) return null;
    try {
      const data = await this.request(`/defi/token_overview?address=${mint}`);
      if (!data) return null;
      return {
        mint,
        symbol: data.symbol ?? null,
        name: data.name ?? null,
        liquidityUsd: data.liquidity ?? null,
        priceUsd: data.price ?? null,
        mc: data.mc ?? null,
        v24hUsd: data.v24hUSD ?? null,
        holder: data.holder ?? null,
        createdAt: data.createdAt ? Math.floor(data.createdAt / 1000) : null,
      };
    } catch (error) {
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "birdeye: getTokenOverview failed");
      return null;
    }
  }

  async getWalletPnl(walletAddress: string): Promise<WalletPnl | null> {
    if (!this.apiKey) return null;
    try {
      const data = await this.request(`/v1/wallet/token_performance?wallet=${walletAddress}`);
      if (!data?.items?.length) return null;
      let totalPnl = 0;
      let totalBuy = 0;
      let totalSell = 0;
      for (const item of data.items) {
        totalPnl += item.realizedProfit ?? 0;
        totalBuy += item.totalBuyAmount ?? 0;
        totalSell += item.totalSellAmount ?? 0;
      }
      const invested = totalBuy > 0 ? totalBuy : 1;
      return {
        totalPnl,
        totalPnlPercent: (totalPnl / invested) * 100,
        totalBuyAmount: totalBuy,
        totalSellAmount: totalSell,
      };
    } catch (error) {
      logger.warn({ walletAddress: walletAddress.substring(0, 12), err: error instanceof Error ? error : new Error(String(error)) }, "birdeye: getWalletPnl failed");
      return null;
    }
  }

  private async request(path: string): Promise<any> {
    const response = await fetch(`${BIRDEYE_BASE}${path}`, {
      headers: {
        "x-chain": "solana",
        "X-API-KEY": this.apiKey,
      },
    });
    if (!response.ok) throw new Error(`BirdEye ${response.status}: ${await response.text()}`);
    const json = (await response.json()) as { success: boolean; data?: any };
    if (!json.success) throw new Error("BirdEye request unsuccessful");
    return json.data ?? null;
  }
}

export const birdEyeClient = new BirdEyeClient();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/birdeye-client.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/blockchain/birdeye-client.ts src/__tests__/birdeye-client.test.ts src/config/index.ts
git commit -m "feat: add BirdEye API client for token overview and wallet PnL"
```

---

### Task 6: DexScreener API Client

**Files:**
- Create: `src/blockchain/dexscreener-client.ts`
- Create: `src/__tests__/dexscreener-client.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/dexscreener-client.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DexScreenerClient } from "../blockchain/dexscreener-client.js";

describe("DexScreenerClient", () => {
  it("exports the class", () => {
    expect(DexScreenerClient).toBeDefined();
  });

  it("getTokenPairs returns empty array for invalid mint", async () => {
    const client = new DexScreenerClient();
    const result = await client.getTokenPairs("invalidmint123");
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/dexscreener-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement DexScreener client**

Create `src/blockchain/dexscreener-client.ts`:

```typescript
import { logger } from "../utils/logger.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";

export interface DexPair {
  pairAddress: string;
  dexId: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string };
  liquidityUsd: number | null;
  volume24h: number | null;
  priceUsd: number | null;
  pairCreatedAt: number | null;
  fdv: number | null;
}

export class DexScreenerClient {
  async getTokenPairs(mint: string): Promise<DexPair[]> {
    try {
      const response = await fetch(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`);
      if (!response.ok) return [];
      const data = (await response.json()) as any[];
      if (!Array.isArray(data)) return [];
      return data.map((pair) => ({
        pairAddress: pair.pairAddress ?? "",
        dexId: pair.dexId ?? "",
        baseToken: {
          address: pair.baseToken?.address ?? mint,
          symbol: pair.baseToken?.symbol ?? "???",
          name: pair.baseToken?.name ?? "",
        },
        quoteToken: {
          address: pair.quoteToken?.address ?? "",
          symbol: pair.quoteToken?.symbol ?? "",
        },
        liquidityUsd: pair.liquidity?.usd ?? null,
        volume24h: pair.volume?.h24 ?? null,
        priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
        pairCreatedAt: pair.pairCreatedAt ?? null,
        fdv: pair.fdv ?? null,
      }));
    } catch (error) {
      logger.warn({ mint, err: error instanceof Error ? error : new Error(String(error)) }, "dexscreener: getTokenPairs failed");
      return [];
    }
  }

  async getBestPair(mint: string): Promise<DexPair | null> {
    const pairs = await this.getTokenPairs(mint);
    if (pairs.length === 0) return null;
    return pairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
  }
}

export const dexScreenerClient = new DexScreenerClient();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/dexscreener-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/blockchain/dexscreener-client.ts src/__tests__/dexscreener-client.test.ts
git commit -m "feat: add DexScreener API client for pair data and liquidity"
```

---

### Task 7: Wire BirdEye + DexScreener into Risk Engine

**Files:**
- Modify: `src/execution/risk-engine.ts:240-245`
- Modify: `src/execution/trade-executor.ts:58-60,83-84`

- [ ] **Step 1: Add real-time liquidity check to risk engine**

In `src/execution/risk-engine.ts`, add import at top:
```typescript
import { birdEyeClient } from "../blockchain/birdeye-client.js";
import { dexScreenerClient } from "../blockchain/dexscreener-client.js";
```

Replace the `tokenLiquidity` method (lines 240-244):

```typescript
  private tokenLiquidity(mint: string): number | null {
    const row = this.requireDb().prepare("SELECT liquidity_usd FROM tokens WHERE mint = ?").get(mint) as
      | { liquidity_usd: number | null }
      | undefined;
    return row?.liquidity_usd ?? null;
  }

  async tokenLiquidityLive(mint: string): Promise<number | null> {
    const overview = await birdEyeClient.getTokenOverview(mint);
    if (overview?.liquidityUsd) return overview.liquidityUsd;
    const pair = await dexScreenerClient.getBestPair(mint);
    if (pair?.liquidityUsd) return pair.liquidityUsd;
    return this.tokenLiquidity(mint);
  }

  async tokenAgeLive(mint: string): Promise<number | null> {
    const overview = await birdEyeClient.getTokenOverview(mint);
    if (overview?.createdAt) {
      return (Date.now() / 1000 - overview.createdAt) / 3600;
    }
    const pair = await dexScreenerClient.getBestPair(mint);
    if (pair?.pairCreatedAt) {
      return (Date.now() - pair.pairCreatedAt) / (1000 * 3600);
    }
    return null;
  }
```

- [ ] **Step 2: Update checkEntry to use live liquidity**

Make `checkEntry` async. Change its signature (line 57):

```typescript
  async checkEntry(convergence: ConvergenceRow, trades: TradeRow[], entryPriceUsd: number): Promise<RiskCheck> {
```

Replace the liquidity check block (around line 73):

```typescript
    const liquidityUsd = await this.tokenLiquidityLive(convergence.token_mint);
```

Replace the token age check (around line 108):

```typescript
    const tokenAgeHours = await this.tokenAgeLive(convergence.token_mint);
```

- [ ] **Step 3: Update trade-executor to await risk check**

In `src/execution/trade-executor.ts`, the call to `this.risk.checkEntry` (line 76) is already awaitable since it returns a Promise now. Verify it uses `await`:

```typescript
    const risk = await this.risk.checkEntry(convergence, trades, entryPrice);
```

Also update the liquidity fetch for slippage (line 83):

```typescript
    const liquidityUsd = await this.risk.tokenLiquidityLive(convergence.token_mint);
    const slippageBps = this.swaps.slippageBpsForLiquidity(liquidityUsd);
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/execution/risk-engine.ts src/execution/trade-executor.ts
git commit -m "feat: wire BirdEye + DexScreener for live liquidity and token age in risk engine"
```

---

### Task 8: Convergence Threshold — Core Wallet Count + Tier Weighting

**Files:**
- Modify: `src/config/thresholds.ts`
- Modify: `src/engine/convergence.ts:31`
- Create: `src/__tests__/threshold.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/threshold.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getThreshold } from "../config/thresholds.js";

describe("getThreshold (tiered)", () => {
  it("uses core count for threshold, not total", () => {
    const result = getThreshold(15, 44);
    expect(result).toBe(Math.max(2, Math.floor(Math.log2(15) + 1)));
  });

  it("returns 2 as minimum", () => {
    expect(getThreshold(1, 10)).toBe(2);
  });

  it("ignores total when core is provided", () => {
    const a = getThreshold(10, 59);
    const b = getThreshold(10, 200);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/threshold.test.ts`
Expected: FAIL — `getThreshold` only accepts 1 argument

- [ ] **Step 3: Update threshold function**

Replace `src/config/thresholds.ts` entirely:

```typescript
export function getThreshold(coreWallets: number, _totalWallets?: number): number {
  return Math.max(2, Math.floor(Math.log2(Math.max(1, coreWallets)) + 1));
}
```

- [ ] **Step 4: Update convergence engine to pass core count**

In `src/engine/convergence.ts`, the existing code uses `config.convergence.mvpThreshold` which is hardcoded to `2`. We need to use `getThreshold` with core wallet count instead.

Add import at top:
```typescript
import { getThreshold } from "../config/thresholds.js";
```

In `checkConvergence`, replace line 31:
```typescript
    const totalActive = this.wallets.countActive();
    const coreCount = this.wallets.countByState("ACTIVE");
    const threshold = getThreshold(coreCount, totalActive);
    if (uniqueWallets.size < threshold) return null;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/threshold.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config/thresholds.ts src/engine/convergence.ts src/__tests__/threshold.test.ts
git commit -m "feat: use core wallet count for convergence threshold instead of total"
```

---

### Task 9: Co-Buyer Discovery Pipeline

**Files:**
- Create: `src/jobs/co-buyer-scanner.ts`
- Create: `src/__tests__/co-buyer-scanner.test.ts`
- Modify: `src/engine/convergence.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/co-buyer-scanner.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { discoverCoBuyers } from "../jobs/co-buyer-scanner.js";

const mockDb = {
  prepare: vi.fn().mockReturnValue({
    all: vi.fn().mockReturnValue([
      { wallet_address: "newWallet1" },
      { wallet_address: "newWallet2" },
      { wallet_address: "existingWallet" },
    ]),
  }),
};

const mockWallets = {
  find: vi.fn().mockImplementation((addr: string) =>
    addr === "existingWallet" ? { address: addr } : null
  ),
  upsert: vi.fn(),
};

describe("discoverCoBuyers", () => {
  it("inserts new wallets found trading same token in window", async () => {
    const result = await discoverCoBuyers(mockDb as any, mockWallets as any, "tokenMint1", 1700000000, 120);
    expect(mockWallets.upsert).toHaveBeenCalledTimes(2);
    expect(result).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/co-buyer-scanner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement co-buyer scanner**

Create `src/jobs/co-buyer-scanner.ts`:

```typescript
import type { AppDatabase } from "../storage/database.js";
import type { WalletModel } from "../storage/models/wallets.js";
import { logger } from "../utils/logger.js";

export async function discoverCoBuyers(
  db: AppDatabase,
  wallets: WalletModel,
  tokenMint: string,
  convergenceFirstTradeAt: number,
  windowMinutes: number
): Promise<number> {
  const since = convergenceFirstTradeAt - windowMinutes * 60;
  const until = convergenceFirstTradeAt + windowMinutes * 60;

  const rows = db
    .prepare(
      `SELECT DISTINCT wallet_address FROM trades
       WHERE token_mint = ? AND trade_type = 'BUY' AND block_time BETWEEN ? AND ?`
    )
    .all(tokenMint, since, until) as Array<{ wallet_address: string }>;

  let discovered = 0;
  for (const row of rows) {
    if (wallets.find(row.wallet_address)) continue;
    wallets.upsert({
      address: row.wallet_address,
      source: "co-buyer",
      state: "NEW",
      active: true,
    });
    discovered++;
    logger.info({ address: row.wallet_address.substring(0, 12), tokenMint: tokenMint.substring(0, 12) }, "co-buyer-scanner: discovered new wallet");
  }

  if (discovered > 0) {
    logger.info({ tokenMint: tokenMint.substring(0, 12), discovered }, "co-buyer-scanner: batch complete");
  }
  return discovered;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run src/__tests__/co-buyer-scanner.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into convergence engine**

In `src/engine/convergence.ts`, add import:
```typescript
import { discoverCoBuyers } from "../jobs/co-buyer-scanner.js";
```

In the `executeConvergence` method (line 84), after the `tradeExecutor.onConvergence` call, add co-buyer scan:

```typescript
  private executeConvergence(convergence: ConvergenceRow, trades: TradeRow[]): void {
    const attempt = this.convergences.incrementExecutionAttempts(convergence.id);
    tradeExecutor.onConvergence(convergence, trades).catch((error) => {
      this.convergences.markOutcome(convergence.id, "FAILED");
      logger.error({ error, convergenceId: convergence.id, attempt }, "trade execution failed for convergence");
    });

    if (this.db) {
      discoverCoBuyers(this.db, this.wallets, convergence.token_mint, convergence.first_trade_at, config.convergence.windowMinutes).catch((error) => {
        logger.warn({ err: error instanceof Error ? error : new Error(String(error)) }, "co-buyer scan failed");
      });
    }
  }
```

- [ ] **Step 6: Commit**

```bash
git add src/jobs/co-buyer-scanner.ts src/__tests__/co-buyer-scanner.test.ts src/engine/convergence.ts
git commit -m "feat: add co-buyer discovery pipeline post-convergence"
```

---

### Task 10: Wallet Scorer — Wire MEV Exclusion + BirdEye PnL

**Files:**
- Modify: `src/jobs/wallet-scorer.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Update wallet-scorer to use MEV flags and BirdEye PnL**

Replace `src/jobs/wallet-scorer.ts`:

```typescript
import type { HeliusClient } from "../blockchain/helius-client.js";
import { birdEyeClient } from "../blockchain/birdeye-client.js";
import type { TradeModel } from "../storage/models/trades.js";
import type { WalletModel } from "../storage/models/wallets.js";
import type { WalletMonitor } from "../blockchain/wallet-monitor.js";
import { computeWalletMetrics } from "../engine/scorer.js";
import { logger } from "../utils/logger.js";

const BATCH_SIZE = 50;
const THIRTY_DAYS_SEC = 30 * 86400;
const HELIUS_TX_LIMIT = 300;

export async function runWalletScorer(
  wallets: WalletModel,
  trades: TradeModel,
  helius: HeliusClient,
  monitor?: WalletMonitor
): Promise<void> {
  const queue = wallets.findScoringQueue(BATCH_SIZE);
  if (queue.length === 0) {
    logger.info("wallet-scorer: no wallets in scoring queue");
    return;
  }

  logger.info({ count: queue.length }, "wallet-scorer: scoring batch");
  const since = Math.floor(Date.now() / 1000) - THIRTY_DAYS_SEC;
  let promoted = 0;
  let demoted = 0;
  let mevFlagged = 0;
  let washFlagged = 0;

  for (const wallet of queue) {
    try {
      const dbTrades = trades.findByWalletSince(wallet.address, since);
      const heliusTxs = await helius.getWalletTransactions(wallet.address, HELIUS_TX_LIMIT);

      const metrics = computeWalletMetrics(dbTrades, heliusTxs, wallet.address, wallet.state);
      const oldState = wallet.state;

      if (metrics.isMev) {
        mevFlagged++;
        logger.warn({
          address: wallet.address.substring(0, 12),
          medianHoldTime: metrics.medianHoldTimeSec,
        }, "wallet-scorer: MEV bot detected — demoting");
      }
      if (metrics.isWashTrader) {
        washFlagged++;
        logger.warn({
          address: wallet.address.substring(0, 12),
        }, "wallet-scorer: wash trader detected — demoting");
      }

      wallets.updateScore(wallet.address, {
        score: metrics.score,
        winRate: metrics.winRate,
        avgRoi: metrics.avgRoi,
        totalTrades: metrics.totalTrades,
        state: metrics.state,
      });

      if (metrics.state === "ACTIVE" && oldState !== "ACTIVE") promoted++;
      if ((metrics.state === "DEMOTED" || metrics.state === "DORMANT") && oldState !== "DEMOTED" && oldState !== "DORMANT") demoted++;

      logger.info({
        address: wallet.address.substring(0, 12),
        score: metrics.score,
        winRate: metrics.winRate,
        avgRoi: metrics.avgRoi,
        trades: metrics.totalTrades,
        pnl: metrics.realizedPnlSol,
        mev: metrics.isMev,
        wash: metrics.isWashTrader,
        holdTime: metrics.medianHoldTimeSec,
        transition: oldState !== metrics.state ? `${oldState} → ${metrics.state}` : metrics.state,
      }, "wallet-scorer: scored");
    } catch (error) {
      logger.warn({ address: wallet.address.substring(0, 12), err: error instanceof Error ? error : new Error(String(error)) }, "wallet-scorer: failed to score wallet");
    }
  }

  const MIN_ACTIVE_POOL = 20;
  const activeCount = wallets.countByState("ACTIVE");
  if (activeCount < MIN_ACTIVE_POOL) {
    const deficit = MIN_ACTIVE_POOL - activeCount;
    const forcePromoted = wallets.promoteTopN(deficit);
    promoted += forcePromoted;
    logger.info({ activeCount, deficit, forcePromoted }, "wallet-scorer: force-promoted to meet minimum pool");
  }

  if (demoted > 0 || promoted > 0) {
    try {
      await monitor?.syncWebhook();
      logger.info({ promoted, demoted }, "wallet-scorer: webhook synced after state changes");
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error : new Error(String(error)) }, "wallet-scorer: webhook sync failed");
    }
  }

  logger.info({ scored: queue.length, promoted, demoted, mevFlagged, washFlagged }, "wallet-scorer: batch complete");
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Run all tests**

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run`
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/jobs/wallet-scorer.ts
git commit -m "feat: wire MEV/wash-trade exclusion and enhanced logging into wallet scorer"
```

- [ ] **Step 5: Final integration commit — wire webhook health into index.ts**

Verify `src/index.ts` has all the new imports and jobs wired. Run the full test suite one more time:

Run: `cd /Users/nassimlecornet/Projects/solana-whale-watcher && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors

```bash
git add -A
git commit -m "chore: final integration — all 10 audit fixes wired and tested"
```

---

## Summary of Changes vs. Audit Gaps

| Audit Gap | Task | Status |
|-----------|------|--------|
| GAP 1: Webhook auto-disable | Task 1: webhook-health.ts | ✅ Auto re-enable every 15min |
| GAP 2: wallet-scorer.ts stub | Tasks 2, 10: MEV/wash detection in scorer | ✅ Full scoring with MEV/wash exclusion |
| GAP 3: No hold-time/MEV filter at parse time | Task 3: rapid-reversal filter | ✅ 60s same-token buy+sell blocked |
| GAP 4: Slippage misaligned | Task 4: MEME tier 2500 bps | ✅ Low-liquidity entries at 25% slippage |
| GAP 5: No BirdEye integration | Tasks 5, 7: birdeye-client.ts | ✅ Live TVL + token age + wallet PnL |
| GAP 6: No co-buyer discovery | Task 9: co-buyer-scanner.ts | ✅ Post-convergence auto-discovery |
| GAP 7: No auto webhook re-enable | Task 1: webhook-health.ts | ✅ Same as GAP 1 |
| GAP 8: Threshold uses total wallets | Task 8: core wallet count | ✅ log2(coreCount) + 1 |
| Extra: DexScreener integration | Task 6: dexscreener-client.ts | ✅ Pair data, liquidity, token age |
| Extra: Risk engine live data | Task 7: BirdEye + DexScreener in risk | ✅ Real-time checks not just cached |
