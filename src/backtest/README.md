# Alpha / backtest harness

Offline research harness for the whale-convergence signal. Lives entirely in
`src/backtest/`, runs via `npx tsx src/backtest/cli.ts <fetch|resolve|replay|report>`
(`--help` for options), and is **excluded from the service build** (tsup only
builds its named entry points; `npm run typecheck` covers this code).

## Data-safety contract

- Candles live in **`data/candles.sqlite`** — a separate SQLite file, never the
  live DB.
- The live DB (`data/whale-watcher.sqlite`, WAL, service running against it) is
  opened **read-only** everywhere except the resolver, whose only writes are:
  1. a one-time idempotent `ALTER TABLE convergences ADD COLUMN resolved_via TEXT`;
  2. `UPDATE convergences SET price_*, outcome, resolved_via='candles'` in short
     transactions of ≤200 rows. Existing non-null price fields are never
     overwritten (`COALESCE`).
- Nothing here restarts or reconfigures the live service.

## Data source

GeckoTerminal public API (no key), throttled to **1 request / 2.1 s**
(≈28 req/min under the ~30/min limit) with exponential backoff on 429/5xx
(5 s · 2^attempt, max 5 retries). Per token: top pool by USD reserve, then
OHLCV with `token={mint}` so the series is the token's USD price regardless of
pool orientation. Candle `volume` is in USD. Fetch state
(`done`/`no_data`/`error`) makes the fetcher resumable; `error` tokens are
retried on the next `fetch` run and are *skipped* (not marked DEAD) by the
resolver.

## Modeling assumptions

| Assumption | Value | Rationale |
|---|---|---|
| **SOL/USD approximation** | Per-day close of WSOL daily candles (GeckoTerminal), nearest day if missing, constant **$78** if the table is empty (matches the live quote and the observed `amount_usd/amount_sol` ratio in `trades`) | Most `trades` rows have `amount_sol` but not `amount_usd`; trade size in USD = `amount_sol × SOL(day)`. Real `amount_usd` is used when present. Daily granularity is enough for a size *threshold*; intraday SOL moves (±3%) are noise next to memecoin moves. |
| **Candle-close pricing** | A candle's `ts` is its bucket open; we use the *close* of the nearest bucket | Standard approximation; at minute granularity the error is seconds of drift. |
| **Resolver tolerances** | 1h: ±10 min (minute candles) · 24h: ±2 h (hourly) · 7d: ±6 h (hourly) | Per spec. Outside tolerance → price left NULL. |
| **Resolver outcomes** | WIN if 7d return ≥ +10%, LOSS if ≤ −20%, else FLAT; token with no candle data, no resolvable baseline, or no 7d close within tolerance → **DEAD** | A token with no market a week later is untradeable; classifying it WIN/LOSS from stale prices would be fiction. |
| **Baseline price** | `price_at_detection` if > 0, else minute close nearest `first_trade_at` (±10 min) | Per spec. |
| **Entry** | detection ts + `latency_seconds` (default 60); price = close of nearest candle **at or before** entry ts (minute ±10 min preferred, hourly ±2 h fallback); no candle → trade skipped | At-or-before prevents pricing entries off future candles. |
| **Slippage** | `bps = min(300, 10 000 × size_usd / (candle_volume_usd + 1))`, applied on **both** entry and exit | K = 10 000 means a trade sized at 1% of the fill candle's volume pays 100 bps; cap 300 bps. Crude but monotone in size/liquidity, which is what a grid comparison needs. |
| **Position size** | Fixed $1,000 per trade (`--size`) | Comparability across configs; no compounding. |
| **Exit evaluation** | Candle-by-candle strictly *after* the entry candle; within a candle **SL is checked before TP** (conservative); SL fills at `min(open, sl_price)` (gap-through fills worse); TP fills exactly at the TP price; time exit at the close of the last candle ≤ entry + max hold. Minute candles first, hourly after minute coverage ends. | Conservative tie-breaking understates, never overstates, performance. |
| **Detection dedup** | After a token emits an event it is suppressed for one `window_minutes` cooldown | One buying burst = one signal, mirroring live alerting behaviour. |
| **No shorting** | Long-only simulation | These are DEX memecoin pools; you cannot short them. A negative signal (e.g. heavy 3+-wallet convergence fading) is therefore a **filter/avoid rule**, not a tradeable fade. |
| **Candle coverage in replay** | Minute candles exist only around convergence detections ([ft−1h, ft+2h]); hourly candles cover [ft, ft+8d] per token | Replay events far from any fetched window fall back to hourly pricing or are skipped; skips are counted and reported. |
| **No lookahead** | Detector consumes trades in `block_time` order; every event at ts T uses only trades ≤ T; entry pricing only uses candles ≤ entry ts | Proven by the truncation test in `__tests__/detector.test.ts`. |

## Walk-forward

The trade time range is split at its midpoint: configs are ranked by total PnL
on the first half (train) and re-ranked on the second half (validation).
A config in the train top quartile that falls below the validation median is
flagged ⚠️ overfit in the report.

## Outputs

- `backtest/replay-results.json` — full config grid results (`replay`).
- `backtest/REPORT.md` — signal study + replay tables (`report`), copied to
  `~/Library/Mobile Documents/com~apple~CloudDocs/temp/whale-alpha-report.md`.
