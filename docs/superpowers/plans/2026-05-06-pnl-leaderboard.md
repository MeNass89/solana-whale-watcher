# Plan — P&L Leaderboard + USD Backfill (A1 + A3)

**Date**: 2026-05-06
**Goal**: Establish the project's source of truth for wallet quality = realized P&L over a rolling 30-day window. Replace reputation-based wallet selection with measured profitability. Detect and exclude accumulation bots (zero exits, massive locked SOL) from the leaderboard.

## Context

- 3 028 trades stored in `data/whale-watcher.sqlite` (table `trades`).
- 99.8 % of trades have `amount_usd = NULL` — only `amount_sol` and `amount_token` are filled by the webhook parser.
- Existing client: `src/blockchain/birdeye-client.ts` exposes `BirdEyeClient` with private `request()` helper. No history-price method yet.
- API key already in `config.birdeye.apiKey`.
- Birdeye Standard tier: `/defi/history_price` (OHLCV ranges) is the cheapest path — ~450 calls instead of ~3 000 for per-trade lookup.

## Deliverables

### 1. Birdeye historical price method

**File**: `src/blockchain/birdeye-client.ts`

Add public method on `BirdEyeClient`:

```ts
async getHistoricalPrices(
  mint: string,
  fromUnix: number,
  toUnix: number,
  type: "1m" | "5m" | "15m" | "1H" | "4H" | "1D" = "5m"
): Promise<Array<{ unixTime: number; value: number }>>
```

Implementation:
- Endpoint: `/defi/history_price?address={mint}&address_type=token&type={type}&time_from={from}&time_to={to}`
- Reuse the existing private `request()` helper (already sets `X-API-KEY` and `x-chain: solana`).
- Response shape: `{ data: { items: [{ unixTime, value }] } }` — return `items` directly.
- Pagination: API caps at 1 000 candles per call. If `(toUnix-fromUnix)/intervalSec > 1000`, slice the range and concatenate. Document the slicing in a code comment.
- Throw on network error so the caller can fall back.

### 2. SOL/USD historical helper (fallback)

**File**: `src/blockchain/birdeye-client.ts` (same file)

Add convenience method:

```ts
async getSolUsdAt(unixTime: number): Promise<number | null>
```

- Calls `/defi/historical_price_unix?address=So11111111111111111111111111111111111111112&unixtime={unixTime}`.
- Returns `data.value` or `null` on error.
- Used as last-resort fallback for tokens Birdeye doesn't index.

### 3. Backfill script

**File**: `scripts/backfill-usd.ts` (new)

Runtime: Node (better-sqlite3 — Bun is broken for this project per CLAUDE rules).

Logic:

1. Open SQLite DB at `data/whale-watcher.sqlite`.
2. Query distinct token mints from trades where `amount_usd IS NULL`. For each, also fetch `MIN(block_time)` and `MAX(block_time)`.
3. For each token mint:
    a. Call `birdEyeClient.getHistoricalPrices(mint, minTs - 600, maxTs + 600, "5m")`.
    b. Build an in-memory sorted array of `[unixTime, value]`.
    c. For each trade of that mint with `amount_usd IS NULL`:
       - Binary-search nearest candle by `block_time` (must be within ±300 s).
       - Compute `usd = amount_token × candle.value`. Update the trade row.
       - If no candle within tolerance OR Birdeye returned empty → mark for fallback.
    d. **Fallback**: for trades flagged at step c, fetch SOL/USD price at `block_time` (cache by 1-hour bucket to minimize calls), then `usd = amount_sol × solUsd`. Update.
    e. Trades where both paths fail: leave NULL, log mint + reason.
4. Print final coverage report: `{ total_trades_targeted, filled_birdeye, filled_solleg, still_null }`.

Rate limiting: insert a 1 s sleep between Birdeye calls (Standard tier ≈ 1 rps). Use `setTimeout` promise wrapper.

Idempotent: re-running the script must skip trades that already have `amount_usd` set.

**Migration not required** — we only update existing rows. No new tables.

### 4. P&L leaderboard script

**File**: `scripts/leaderboard.ts` (new)

Purpose: produce the canonical wallet ranking. Outputs both human-readable table to stdout and machine-readable JSON to `data/leaderboard.json`.

Logic:

1. For each wallet in `wallets` table where `active = 1`, aggregate from `trades` (last 30 days, `block_time > now - 30*86400`):
    - `n_buys`, `n_sells`, `n_trades = n_buys + n_sells`
    - Group by `(wallet, token_mint)`:
       - `buy_sol`, `sell_sol`, `buy_tok`, `sell_tok`, `buy_usd`, `sell_usd`
       - Cycle status:
         - `CLOSED` if `sell_tok ≥ buy_tok × 0.95`
         - `OPEN` if `sell_tok = 0`
         - `PARTIAL` otherwise
    - Per wallet metrics:
       - `realized_sol = Σ (sell_sol - buy_sol)` over CLOSED cycles
       - `realized_usd = Σ (sell_usd - buy_usd)` over CLOSED cycles
       - `wins = count of CLOSED cycles where sell_sol > buy_sol`
       - `win_rate = wins / count(CLOSED)`
       - `avg_hold_time_s = avg(MAX(SELL.block_time) - MIN(BUY.block_time))` over CLOSED cycles
       - `locked_sol = Σ buy_sol over OPEN cycles`
       - `n_closed`, `n_open`, `n_partial`

2. **Accumulation bot filter** — exclude from the ranked output any wallet matching ALL of:
    - `n_closed = 0`
    - `n_trades ≥ 50`
    - `n_sells / max(n_buys, 1) < 0.05`
   
   These wallets accumulate but never realize — they pollute the signal. They are still tracked in DB (not disabled), but flagged `class = "accumulation_bot"` in the JSON output and listed separately at the bottom of the stdout report.

3. **Stdout format** — three sections:
    ```
    === ALPHA WALLETS (ranked by realized_usd desc) ===
    rank | wallet (truncated) | realized_usd | realized_sol | win% | n_closed | locked_sol | n_trades
    
    === LOSERS (realized_usd < 0) ===
    same columns
    
    === ACCUMULATION BOTS (excluded from rank) ===
    wallet | n_trades | n_buys | n_sells | locked_sol
    ```

4. **JSON output** — `data/leaderboard.json`:
    ```json
    {
      "generated_at": <unix>,
      "window_days": 30,
      "alpha": [{ wallet, realized_usd, realized_sol, win_rate, ...}],
      "losers": [...],
      "accumulation_bots": [{ wallet, n_trades, locked_sol }],
      "incomplete": [{ wallet, n_open, n_partial, locked_sol }]  // wallets with no closed cycles but not bot-classified
    }
    ```

### 5. Disable confirmed losers

After running the leaderboard, execute via the script (or a one-shot SQL the script logs at the end if `--apply-prune` flag is passed):

```sql
UPDATE wallets SET active = 0
WHERE address IN (
  'Hq3GSgr27vEQ...',  -- full address from leaderboard output
  '9jyqFiLnruggwNn4EQwBNFXwpbLM9hrA4hV59ytyAVVz'
);
```

Currently visible losers: `Hq3GSgr…` (-2.6 SOL, 20 % win) and `9jyqFiLnrugg…` (-1 SOL, 0 %). Confirm full addresses from the actual leaderboard output before disabling. Only disable wallets where `realized_usd < 0` AND `n_closed ≥ 3` (need enough sample).

## Acceptance criteria

- [ ] `npx tsx scripts/backfill-usd.ts` runs to completion. Final coverage report shows ≥ 90 % of trades with non-null `amount_usd`. Trades with NULL after the run are logged with mint + reason.
- [ ] `npx tsx scripts/leaderboard.ts` outputs the three-section table to stdout and writes `data/leaderboard.json`.
- [ ] At least one wallet appears in the `accumulation_bots` section. The bot `99mRw3EzdJZW…` (currently 2 077 trades, 0 closed, 906 SOL locked) MUST be flagged there.
- [ ] At least the two known losers (`Hq3GSgr…`, `9jyqFi…`) are disabled in the `wallets` table. Confirm with `SELECT count(*) FROM wallets WHERE active = 0`.
- [ ] No regression on the running webhook server (Fastify on port 3000 must keep accepting trades during and after the script runs). The scripts open the DB read/write but should commit small batches.

## Out of scope

- Cron scheduling — manual run for now, automate later.
- Wallet score integration with the convergence engine — separate task.
- Dynamic auto-prune (kick wallets with N days of bottom-quartile P&L) — separate task.
- UI / dashboard.

## Verification commands

```bash
# Run backfill
npx tsx scripts/backfill-usd.ts

# Coverage check
sqlite3 data/whale-watcher.sqlite "SELECT COUNT(*) total, SUM(CASE WHEN amount_usd IS NOT NULL THEN 1 ELSE 0 END) with_usd FROM trades;"

# Run leaderboard
npx tsx scripts/leaderboard.ts

# Apply prune
npx tsx scripts/leaderboard.ts --apply-prune

# Confirm disabled
sqlite3 data/whale-watcher.sqlite "SELECT address, active FROM wallets WHERE active = 0;"
```

## Risks / things to watch

- Birdeye OHLCV may not have all memecoins → fallback to SOL-leg derivation. If both fail, leave NULL — do not invent prices.
- Token decimals are NOT in the trades table. `amount_token` is already normalized (decimal-adjusted) by the webhook parser. Verify this assumption before computing `usd = amount_token × candle.value` — read `src/blockchain/transaction-parser.ts` to confirm.
- `getHistoricalPrices` slicing: if a token's range exceeds 1 000 candles at 5 m granularity (~3.5 days), slice by ≤ 3-day windows. Sequential calls, not parallel — respect rate limit.
- Be careful with `amount_sol` for SELL trades: it represents SOL **received** (not paid). Sign convention: realized = sell_sol − buy_sol, where higher is better. Same convention for USD.
