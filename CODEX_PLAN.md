# Codex Plan: Liquidity-Relative Cap + Jupiter Quote P&L

Two fixes for the whale watcher paper trading P&L inflation.

## Context

The bot paper-trades Solana tokens by copying whale convergences. The existing liquidity gate (`risk-engine.ts`) checks if the *entry position* exceeds 0.5% of pool TVL — but with a $10K portfolio and 0.3% min position, entries are always ~$30, which passes any pool above $5K. The problem: after a 1000x price increase, the bot "holds" tokens worth $500K in a pool with $5K liquidity. It can never sell them at that price. The displayed unrealized P&L is fantasy.

## Fix 1: Liquidity-Relative Position Cap

**Goal:** Cap position size at 5% of pool TVL. This prevents entering pools where you'd own a disproportionate share of liquidity.

**File:** `src/execution/risk-engine.ts`

### Changes

1. **Line 40** — Replace constant:
```ts
// REMOVE
const MAX_POSITION_POOL_TVL_PCT = 0.5;
// ADD
const MAX_POSITION_LIQUIDITY_PCT = 5;   // never buy more than 5% of pool TVL
```

2. **Lines 139-144** — After `finalSizeUsd` is computed (line 139) and before the existing TVL check (line 142), insert a liquidity cap that *shrinks* the position instead of hard-rejecting:

```ts
// Cap position to MAX_POSITION_LIQUIDITY_PCT of pool TVL
const maxLiquiditySizeUsd = (liquidityUsd * MAX_POSITION_LIQUIDITY_PCT) / 100;
if (finalSizeUsd > maxLiquiditySizeUsd) {
  finalSizeUsd = maxLiquiditySizeUsd;
  finalSizePct = (finalSizeUsd / portfolioValueUsd) * 100;
}
```

3. **Remove** the old 0.5% hard-reject check at lines 142-144 (the new cap subsumes it):
```ts
// REMOVE these lines:
if ((finalSizeUsd / liquidityUsd) * 100 > MAX_POSITION_POOL_TVL_PCT) {
  return { allowed: false, reason: "position exceeds 0.5% of pool TVL", phase, portfolioValueUsd };
}
```

4. **Line 16** — Add to `RiskCheck` interface:
```ts
liquidityCapApplied?: boolean;
```
Set it to `true` in the return when the cap shrinks the position.

## Fix 2: Jupiter Quote-Based Unrealized P&L

**Goal:** When tracking open position value, use a real Jupiter exit quote (how much USDC you'd actually get selling your tokens) instead of `spot_price * quantity`.

### File 1: `src/execution/jupiter-client.ts`

**Add method** to the `JupiterClient` class (after `getPriceUsd`, around line 105):

```ts
/**
 * Get a real exit quote: "if I sold all my tokens right now, how much USDC would I get?"
 * Returns null if quote fails (token dead, pool drained, etc.)
 */
async getExitQuoteUsd(
  tokenMint: string,
  amountToken: number,
  decimals: number
): Promise<{ totalUsd: number; effectivePrice: number; priceImpactPct: number } | null> {
  if (amountToken <= 0 || decimals < 0) return null;

  const amountLamports = BigInt(Math.floor(amountToken * 10 ** decimals));
  if (amountLamports < 1n) return null;

  try {
    const quote = await this.getQuote({
      inputMint: tokenMint,
      outputMint: USDC_MINT,
      amountLamports,
      slippageBps: 300,
    });
    const outAmount = Number(quote.outAmount) / 1e6; // USDC = 6 decimals
    if (!Number.isFinite(outAmount) || outAmount <= 0) return null;
    return {
      totalUsd: outAmount,
      effectivePrice: outAmount / amountToken,
      priceImpactPct: Number(quote.priceImpactPct ?? 0),
    };
  } catch {
    return null;
  }
}
```

`USDC_MINT` is already defined at line 10 of this file. `getQuote` is already defined at line 209.

### File 2: `src/execution/position-manager.ts`

**Modify `checkOpenPositions`** (lines 152-191):

1. Add a cache to the class:
```ts
private exitQuoteCache = new Map<number, { effectivePrice: number; at: number }>();
```

2. Add a `tokenDecimals` helper (same pattern as trade-executor.ts line 363):
```ts
private tokenDecimals(mint: string): number {
  const row = this.db.prepare("SELECT decimals FROM tokens WHERE mint = ?").get(mint) as { decimals: number } | undefined;
  return row?.decimals ?? 9; // default SOL-like
}
```

3. In the price update loop inside `checkOpenPositions`, after getting the spot price (which is fast and still needed for stop-loss triggers), also get the exit quote every 120 seconds:

```ts
// After: const price = await this.priceClient.getPriceUsd(position.token_mint);
// Add:
const cached = this.exitQuoteCache.get(position.id);
const now = Date.now();
let displayPrice = price; // default to spot

if (!cached || now - cached.at > 120_000) {
  const decimals = this.tokenDecimals(position.token_mint);
  const exitQuote = await this.jupiterClient.getExitQuoteUsd(
    position.token_mint,
    position.amount_token,
    decimals
  );
  if (exitQuote) {
    displayPrice = exitQuote.effectivePrice;
    this.exitQuoteCache.set(position.id, { effectivePrice: displayPrice, at: now });
  }
} else {
  displayPrice = cached.effectivePrice;
}
```

4. Use `displayPrice` (not `price`) when updating `current_price_usd` in the DB and for portfolio valuation. Keep using `price` (spot) for stop-loss and take-profit trigger comparisons in `onPriceUpdate` — stops need responsiveness, not slippage accuracy.

**Note:** `this.jupiterClient` needs to be available in PositionManager. Check if it's already injected via constructor. If not, add it as a constructor parameter (it's already instantiated in the dependency setup, likely in `src/index.ts` or `src/execution/index.ts`).

## Testing

After implementing:
1. Run existing tests: `npm test` — ensure risk-engine tests pass (they may need `MAX_POSITION_LIQUIDITY_PCT` updated in test setup)
2. Manual check: restart the bot, wait for a convergence on a low-liquidity token (<$10K TVL), confirm the position is capped at 5% of TVL in the logs
3. For any open position, compare `getPriceUsd` vs `getExitQuoteUsd` in logs — the exit quote should be significantly lower for illiquid tokens
4. Run the P&L query: `SELECT token_symbol, current_price_usd, amount_token FROM positions WHERE status = 'open'` — values should now reflect real exit prices

## Files touched
- `src/execution/risk-engine.ts` (Fix 1)
- `src/execution/jupiter-client.ts` (Fix 2, new method)
- `src/execution/position-manager.ts` (Fix 2, use exit quote)
