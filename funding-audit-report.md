# Cross-venue perpetual funding-rate carry audit

Generated: 2026-08-05T20:10:47.865Z  
Requested window: 2025-01-01T00:00:00.000Z to 2026-08-05T20:06:03.654Z  
Independent split: 2025-10-18T22:03:01.827Z

## Verdict

**DEAD** — No tested configuration produced a positive full-window net result after trading costs.

**Best configuration:** ETH, Binance-Bybit, 15% entry / 7.5% exit. Net annualized return was **-0.85% in the first half** and **-1.06% in the second half** (-0.95% full-window), with 6.90 round trips/year.

The headline differential is not the strategy return. With $1 notional and $1 collateral on each leg, funding P&L is divided by **two units of deployed collateral**. A 7% annualized single-notional differential is therefore about 3.5% on total capital before execution costs.

## Methodology

- Pair spread is signed as the first named venue minus the second: positive `HL-Binance`, for example, means Hyperliquid funding was higher. The strategy shorts the higher-funding venue and longs the lower-funding venue.
- The common timeline is a UTC 8-hour grid. Binance and Bybit contribute their single realized 8-hour payment. Hyperliquid contributes the sum of all eight realized hourly payments in `(T-8h, T]`; an incomplete block is discarded rather than filled with zero. A payment more than five minutes off its native boundary remains in the raw JSON but is excluded and counted. The annualized spread is `(8h rate A - 8h rate B) × 3 × 365 × 100` percentage points. This is algebraically equivalent to applying `rate × 24 × 365 × 100` to each Hyperliquid hourly observation and averaging eight hours.
- Decisions occur daily just after the 00:00 UTC funding settlement, using the block that has just completed. This is a **lagged realized-funding signal**, not an archived predicted rate. A new trade never receives the payment that triggered it; an existing trade receives that payment before the exit decision.
- Entry is strict at `|spread| > 5/10/15%`; exit is strict at `|spread| < 2.5/5/7.5%` or on a sign reversal. A qualifying reversal closes and immediately reopens the opposite carry. Missing common blocks force the position flat at the last complete block.
- Each leg uses $1 notional at 1× and $1 collateral. Funding cashflows are `short: +rate`, `long: -rate`; total return divides dollars by $2 collateral. Idle time earns zero. Returns are simple, not compounded, and annualized over calendar time.
- The first and second halves are simulated independently, flat at each start and force-closed at each boundary. Best means highest `min(first-half, second-half)` net annualized return, then highest full-window return, then lower turnover.
- Sign flips ignore exact-zero observations and never bridge a missing 8-hour block. Flips/week divides flips by observed complete-block weeks. Quantiles use linear interpolation.

### Execution costs

| Venue | Taker fee per leg/side | Slippage per leg/side |
| --- | ---: | ---: |
| Binance | 0.050% | 0.020% |
| Bybit | 0.055% | 0.020% |
| Hyperliquid | 0.045% | 0.020% |

Round-trip cost on deployed capital is `fee A + fee B + 2 × 0.020%`: 0.135% for HL-Binance, 0.140% for HL-Bybit, and 0.145% for Binance-Bybit.

## Data coverage

| Venue | Asset | Status | Raw rows | Usable rows | Off-grid | First UTC | Last UTC | Pages | Gaps | Missing periods | Max gap h |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| binance | SOL | ok | 1746 | 1746 | 0 | 2025-01-01T00:00:00.000Z | 2026-08-05T16:00:00.000Z | 2 | 0 | 0 | 8.0 |
| binance | BTC | ok | 1746 | 1746 | 0 | 2025-01-01T00:00:00.000Z | 2026-08-05T16:00:00.000Z | 2 | 0 | 0 | 8.0 |
| binance | ETH | ok | 1746 | 1746 | 0 | 2025-01-01T00:00:00.000Z | 2026-08-05T16:00:00.000Z | 2 | 0 | 0 | 8.0 |
| hyperliquid | SOL | ok | 13965 | 13964 | 1 | 2025-01-01T00:00:00.000Z | 2026-08-05T20:00:00.000Z | 28 | 1 | 1 | 2.0 |
| hyperliquid | BTC | ok | 13965 | 13964 | 1 | 2025-01-01T00:00:00.000Z | 2026-08-05T20:00:00.000Z | 28 | 1 | 1 | 2.0 |
| hyperliquid | ETH | ok | 13965 | 13964 | 1 | 2025-01-01T00:00:00.000Z | 2026-08-05T20:00:00.000Z | 28 | 1 | 1 | 2.0 |
| bybit | SOL | ok | 1746 | 1746 | 0 | 2025-01-01T00:00:00.000Z | 2026-08-05T16:00:00.000Z | 9 | 0 | 0 | 8.0 |
| bybit | BTC | ok | 1746 | 1746 | 0 | 2025-01-01T00:00:00.000Z | 2026-08-05T16:00:00.000Z | 9 | 0 | 0 | 8.0 |
| bybit | ETH | ok | 1746 | 1746 | 0 | 2025-01-01T00:00:00.000Z | 2026-08-05T16:00:00.000Z | 9 | 0 | 0 | 8.0 |

No endpoint failed.

The final UTC day is partial when the run precedes its final funding settlement. Raw exchange rows, exact requests, and canonical projections are stored in `data/funding-audit/raw/`; `run-metadata.json` records the run used here.

### Normalized pair coverage

| Asset | Pair | Status | 8h blocks | First UTC | Last UTC | Gaps | Missing blocks | Max gap h |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SOL | HL-Binance | ok | 1744 | 2025-01-01T08:00:00.000Z | 2026-08-05T16:00:00.000Z | 1 | 1 | 16.0 |
| SOL | HL-Bybit | ok | 1744 | 2025-01-01T08:00:00.000Z | 2026-08-05T16:00:00.000Z | 1 | 1 | 16.0 |
| SOL | Binance-Bybit | ok | 1746 | 2025-01-01T00:00:00.000Z | 2026-08-05T16:00:00.000Z | 0 | 0 | 8.0 |
| BTC | HL-Binance | ok | 1744 | 2025-01-01T08:00:00.000Z | 2026-08-05T16:00:00.000Z | 1 | 1 | 16.0 |
| BTC | HL-Bybit | ok | 1744 | 2025-01-01T08:00:00.000Z | 2026-08-05T16:00:00.000Z | 1 | 1 | 16.0 |
| BTC | Binance-Bybit | ok | 1746 | 2025-01-01T00:00:00.000Z | 2026-08-05T16:00:00.000Z | 0 | 0 | 8.0 |
| ETH | HL-Binance | ok | 1744 | 2025-01-01T08:00:00.000Z | 2026-08-05T16:00:00.000Z | 1 | 1 | 16.0 |
| ETH | HL-Bybit | ok | 1744 | 2025-01-01T08:00:00.000Z | 2026-08-05T16:00:00.000Z | 1 | 1 | 16.0 |
| ETH | Binance-Bybit | ok | 1746 | 2025-01-01T00:00:00.000Z | 2026-08-05T16:00:00.000Z | 0 | 0 | 8.0 |

## Full-window spread statistics

All values except observations are annualized percentage points; the direction is first venue minus second venue.

| Asset | Pair | N | Mean % | Median % | P10 % | P90 % | Sign flips/week |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SOL | HL-Binance | 1744 | 3.19 | 2.64 | -10.45 | 15.93 | 5.49 |
| SOL | HL-Bybit | 1744 | 1.67 | 0.52 | -12.30 | 15.34 | 5.78 |
| SOL | Binance-Bybit | 1746 | -1.53 | -0.56 | -10.34 | 7.38 | 7.47 |
| BTC | HL-Binance | 1744 | 4.24 | 3.99 | -4.60 | 11.86 | 3.84 |
| BTC | HL-Bybit | 1744 | 4.34 | 3.92 | -4.29 | 12.07 | 4.03 |
| BTC | Binance-Bybit | 1746 | 0.10 | 0.00 | -6.35 | 6.59 | 6.72 |
| ETH | HL-Binance | 1744 | 3.65 | 3.82 | -6.21 | 12.13 | 3.93 |
| ETH | HL-Bybit | 1744 | 3.45 | 3.16 | -6.19 | 12.63 | 4.09 |
| ETH | Binance-Bybit | 1746 | -0.20 | 0.00 | -7.09 | 6.49 | 6.59 |

## Monthly spread statistics

| Month | Asset | Pair | N | Mean % | Median % | P10 % | P90 % | Sign flips/week |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2025-01 | SOL | HL-Binance | 92 | 9.36 | 7.17 | -1.32 | 21.67 | 4.57 |
| 2025-02 | SOL | HL-Binance | 84 | 4.51 | 6.45 | -13.57 | 18.42 | 5.00 |
| 2025-03 | SOL | HL-Binance | 93 | 0.55 | 0.08 | -14.23 | 13.97 | 6.10 |
| 2025-04 | SOL | HL-Binance | 90 | -3.31 | 0.23 | -22.38 | 16.49 | 4.20 |
| 2025-05 | SOL | HL-Binance | 93 | 7.91 | 7.73 | -4.31 | 18.81 | 2.26 |
| 2025-06 | SOL | HL-Binance | 90 | 4.21 | 5.56 | -5.66 | 12.87 | 4.20 |
| 2025-07 | SOL | HL-Binance | 92 | 13.70 | 9.78 | -0.71 | 37.24 | 2.28 |
| 2025-08 | SOL | HL-Binance | 93 | 6.57 | 4.25 | -1.85 | 17.74 | 3.61 |
| 2025-09 | SOL | HL-Binance | 90 | 7.80 | 7.92 | -0.09 | 16.24 | 1.40 |
| 2025-10 | SOL | HL-Binance | 93 | 6.92 | 6.59 | -4.02 | 19.37 | 4.52 |
| 2025-11 | SOL | HL-Binance | 90 | -1.71 | -1.08 | -13.00 | 9.94 | 7.70 |
| 2025-12 | SOL | HL-Binance | 93 | 2.60 | 0.00 | -4.92 | 13.12 | 7.23 |
| 2026-01 | SOL | HL-Binance | 93 | 1.83 | 0.80 | -9.32 | 12.74 | 6.55 |
| 2026-02 | SOL | HL-Binance | 84 | -4.86 | -3.44 | -20.76 | 7.34 | 9.00 |
| 2026-03 | SOL | HL-Binance | 93 | -3.94 | -4.62 | -12.93 | 5.59 | 8.13 |
| 2026-04 | SOL | HL-Binance | 90 | -0.47 | -0.57 | -9.66 | 9.30 | 8.87 |
| 2026-05 | SOL | HL-Binance | 93 | 2.65 | 3.73 | -6.27 | 11.41 | 5.42 |
| 2026-06 | SOL | HL-Binance | 90 | 2.44 | 3.15 | -8.13 | 10.61 | 7.47 |
| 2026-07 | SOL | HL-Binance | 93 | 3.59 | 3.49 | -3.59 | 11.13 | 4.97 |
| 2026-08 | SOL | HL-Binance | 15 | -0.13 | -0.32 | -6.47 | 5.62 | 4.20 |
| 2025-01 | SOL | HL-Bybit | 92 | 5.30 | 1.67 | -2.93 | 18.90 | 6.39 |
| 2025-02 | SOL | HL-Bybit | 84 | -1.75 | 0.00 | -17.76 | 16.14 | 5.00 |
| 2025-03 | SOL | HL-Bybit | 93 | -1.92 | -1.10 | -15.16 | 11.12 | 7.90 |
| 2025-04 | SOL | HL-Bybit | 90 | -4.51 | -2.10 | -31.21 | 15.34 | 5.13 |
| 2025-05 | SOL | HL-Bybit | 93 | 3.63 | 2.15 | -9.23 | 14.98 | 3.39 |
| 2025-06 | SOL | HL-Bybit | 90 | 5.36 | 6.31 | -4.30 | 15.08 | 2.80 |
| 2025-07 | SOL | HL-Bybit | 92 | 12.72 | 9.11 | -0.32 | 33.87 | 2.74 |
| 2025-08 | SOL | HL-Bybit | 93 | 6.00 | 4.74 | -2.99 | 18.68 | 4.97 |
| 2025-09 | SOL | HL-Bybit | 90 | 6.66 | 4.96 | -1.03 | 18.22 | 2.33 |
| 2025-10 | SOL | HL-Bybit | 93 | 5.51 | 2.42 | -6.08 | 18.94 | 7.00 |
| 2025-11 | SOL | HL-Bybit | 90 | -1.09 | -1.36 | -14.05 | 14.59 | 7.93 |
| 2025-12 | SOL | HL-Bybit | 93 | 3.90 | 2.88 | -5.10 | 15.44 | 6.55 |
| 2026-01 | SOL | HL-Bybit | 93 | 2.67 | 0.80 | -8.19 | 16.62 | 6.55 |
| 2026-02 | SOL | HL-Bybit | 84 | -11.09 | -9.53 | -28.09 | 4.70 | 5.00 |
| 2026-03 | SOL | HL-Bybit | 93 | -5.40 | -5.63 | -16.43 | 6.76 | 6.32 |
| 2026-04 | SOL | HL-Bybit | 90 | -2.20 | -2.05 | -11.61 | 10.03 | 9.57 |
| 2026-05 | SOL | HL-Bybit | 93 | 0.20 | -0.12 | -8.87 | 9.95 | 7.45 |
| 2026-06 | SOL | HL-Bybit | 90 | 1.16 | 0.14 | -9.38 | 12.23 | 7.00 |
| 2026-07 | SOL | HL-Bybit | 93 | 4.93 | 5.27 | -3.23 | 12.88 | 4.52 |
| 2026-08 | SOL | HL-Bybit | 15 | 2.14 | 5.07 | -7.51 | 7.55 | 5.60 |
| 2025-01 | SOL | Binance-Bybit | 93 | -4.13 | -3.76 | -10.33 | 0.81 | 5.42 |
| 2025-02 | SOL | Binance-Bybit | 84 | -6.26 | -3.24 | -16.67 | 5.62 | 5.50 |
| 2025-03 | SOL | Binance-Bybit | 93 | -2.47 | -1.61 | -14.18 | 6.89 | 7.00 |
| 2025-04 | SOL | Binance-Bybit | 90 | -1.20 | -1.05 | -10.68 | 8.02 | 7.23 |
| 2025-05 | SOL | Binance-Bybit | 93 | -4.28 | -3.05 | -12.13 | 1.51 | 4.52 |
| 2025-06 | SOL | Binance-Bybit | 90 | 1.15 | 1.13 | -6.14 | 8.08 | 7.00 |
| 2025-07 | SOL | Binance-Bybit | 93 | -0.97 | 0.00 | -7.58 | 3.86 | 5.65 |
| 2025-08 | SOL | Binance-Bybit | 93 | -0.57 | 0.00 | -7.11 | 4.48 | 4.74 |
| 2025-09 | SOL | Binance-Bybit | 90 | -1.14 | -0.66 | -10.15 | 6.94 | 7.70 |
| 2025-10 | SOL | Binance-Bybit | 93 | -1.41 | -1.10 | -15.55 | 7.61 | 8.13 |
| 2025-11 | SOL | Binance-Bybit | 90 | 0.62 | 0.00 | -9.50 | 10.16 | 8.87 |
| 2025-12 | SOL | Binance-Bybit | 93 | 1.30 | 0.00 | -5.17 | 8.50 | 7.00 |
| 2026-01 | SOL | Binance-Bybit | 93 | 0.83 | 0.00 | -6.24 | 8.67 | 6.77 |
| 2026-02 | SOL | Binance-Bybit | 84 | -6.23 | -4.25 | -18.77 | 5.05 | 8.00 |
| 2026-03 | SOL | Binance-Bybit | 93 | -1.46 | -1.65 | -11.31 | 9.29 | 9.26 |
| 2026-04 | SOL | Binance-Bybit | 90 | -1.73 | -0.34 | -10.90 | 6.76 | 9.80 |
| 2026-05 | SOL | Binance-Bybit | 93 | -2.45 | -2.76 | -11.02 | 5.93 | 6.77 |
| 2026-06 | SOL | Binance-Bybit | 90 | -1.27 | -0.49 | -9.84 | 6.22 | 10.73 |
| 2026-07 | SOL | Binance-Bybit | 93 | 1.34 | 0.11 | -4.07 | 7.53 | 9.71 |
| 2026-08 | SOL | Binance-Bybit | 15 | 2.27 | 1.40 | -2.47 | 8.24 | 8.40 |
| 2025-01 | BTC | HL-Binance | 92 | 7.96 | 3.68 | 0.00 | 18.85 | 3.20 |
| 2025-02 | BTC | HL-Binance | 84 | 6.19 | 5.55 | 0.00 | 11.81 | 3.00 |
| 2025-03 | BTC | HL-Binance | 93 | 0.89 | 4.00 | -10.30 | 10.36 | 6.10 |
| 2025-04 | BTC | HL-Binance | 90 | 2.61 | 3.26 | -9.78 | 11.32 | 5.60 |
| 2025-05 | BTC | HL-Binance | 93 | 11.13 | 7.10 | 0.10 | 36.11 | 1.81 |
| 2025-06 | BTC | HL-Binance | 90 | 5.61 | 6.07 | -1.08 | 11.60 | 3.73 |
| 2025-07 | BTC | HL-Binance | 92 | 10.98 | 7.40 | 0.02 | 26.64 | 0.00 |
| 2025-08 | BTC | HL-Binance | 93 | 4.25 | 3.79 | 0.00 | 10.14 | 2.71 |
| 2025-09 | BTC | HL-Binance | 90 | 4.76 | 4.68 | 0.00 | 9.14 | 2.33 |
| 2025-10 | BTC | HL-Binance | 93 | 7.03 | 7.42 | 0.00 | 13.84 | 1.81 |
| 2025-11 | BTC | HL-Binance | 90 | 3.55 | 2.98 | -0.24 | 8.37 | 3.27 |
| 2025-12 | BTC | HL-Binance | 93 | 1.22 | 2.26 | -7.37 | 8.04 | 4.97 |
| 2026-01 | BTC | HL-Binance | 93 | 1.93 | 2.92 | -7.35 | 8.20 | 3.61 |
| 2026-02 | BTC | HL-Binance | 84 | 3.22 | 4.58 | -7.08 | 12.38 | 5.75 |
| 2026-03 | BTC | HL-Binance | 93 | 2.11 | 2.23 | -7.71 | 11.10 | 6.32 |
| 2026-04 | BTC | HL-Binance | 90 | 1.27 | 1.43 | -10.21 | 12.54 | 5.37 |
| 2026-05 | BTC | HL-Binance | 93 | 0.18 | 1.37 | -11.55 | 8.73 | 6.10 |
| 2026-06 | BTC | HL-Binance | 90 | 3.44 | 4.15 | -4.68 | 9.77 | 2.80 |
| 2026-07 | BTC | HL-Binance | 93 | 2.82 | 2.81 | -0.77 | 7.73 | 3.61 |
| 2026-08 | BTC | HL-Binance | 15 | 1.05 | 0.84 | -1.08 | 3.71 | 4.20 |
| 2025-01 | BTC | HL-Bybit | 92 | 8.18 | 4.18 | 0.00 | 21.89 | 1.83 |
| 2025-02 | BTC | HL-Bybit | 84 | 5.80 | 4.94 | -1.34 | 13.45 | 1.50 |
| 2025-03 | BTC | HL-Bybit | 93 | 0.39 | 2.30 | -14.65 | 10.78 | 6.55 |
| 2025-04 | BTC | HL-Bybit | 90 | 2.91 | 3.62 | -8.57 | 11.48 | 6.07 |
| 2025-05 | BTC | HL-Bybit | 93 | 11.47 | 7.93 | 0.00 | 31.33 | 2.26 |
| 2025-06 | BTC | HL-Bybit | 90 | 5.49 | 5.67 | -0.30 | 12.23 | 3.73 |
| 2025-07 | BTC | HL-Bybit | 92 | 10.63 | 6.79 | 0.01 | 26.64 | 0.46 |
| 2025-08 | BTC | HL-Bybit | 93 | 3.41 | 1.49 | -2.12 | 12.59 | 3.16 |
| 2025-09 | BTC | HL-Bybit | 90 | 3.49 | 2.23 | -0.99 | 10.12 | 4.67 |
| 2025-10 | BTC | HL-Bybit | 93 | 5.28 | 4.84 | -2.24 | 11.84 | 2.71 |
| 2025-11 | BTC | HL-Bybit | 90 | 6.23 | 6.06 | 0.92 | 11.43 | 1.40 |
| 2025-12 | BTC | HL-Bybit | 93 | 3.04 | 4.32 | -6.53 | 9.56 | 4.97 |
| 2026-01 | BTC | HL-Bybit | 93 | 4.09 | 5.08 | -5.15 | 11.20 | 4.06 |
| 2026-02 | BTC | HL-Bybit | 84 | 0.85 | 2.40 | -10.68 | 9.99 | 5.25 |
| 2026-03 | BTC | HL-Bybit | 93 | 1.18 | 1.05 | -7.46 | 10.39 | 5.87 |
| 2026-04 | BTC | HL-Bybit | 90 | 0.03 | 1.45 | -9.80 | 7.90 | 6.77 |
| 2026-05 | BTC | HL-Bybit | 93 | 0.84 | 1.43 | -8.04 | 6.88 | 7.45 |
| 2026-06 | BTC | HL-Bybit | 90 | 4.51 | 5.14 | -2.07 | 10.48 | 4.20 |
| 2026-07 | BTC | HL-Bybit | 93 | 4.85 | 5.10 | -0.60 | 11.75 | 2.71 |
| 2026-08 | BTC | HL-Bybit | 15 | 2.03 | -0.01 | -3.05 | 8.53 | 7.00 |
| 2025-01 | BTC | Binance-Bybit | 93 | 0.22 | 0.00 | -3.54 | 4.99 | 4.97 |
| 2025-02 | BTC | Binance-Bybit | 84 | -0.39 | -0.54 | -8.38 | 9.25 | 5.50 |
| 2025-03 | BTC | Binance-Bybit | 93 | -0.50 | 0.08 | -9.95 | 6.17 | 6.10 |
| 2025-04 | BTC | Binance-Bybit | 90 | 0.30 | -0.33 | -6.87 | 8.00 | 7.70 |
| 2025-05 | BTC | Binance-Bybit | 93 | 0.33 | 0.27 | -6.04 | 5.80 | 7.00 |
| 2025-06 | BTC | Binance-Bybit | 90 | -0.12 | -0.31 | -5.49 | 4.92 | 7.70 |
| 2025-07 | BTC | Binance-Bybit | 93 | -0.34 | 0.00 | -2.62 | 1.39 | 2.48 |
| 2025-08 | BTC | Binance-Bybit | 93 | -0.84 | -0.04 | -6.56 | 5.30 | 4.52 |
| 2025-09 | BTC | Binance-Bybit | 90 | -1.28 | -1.25 | -7.93 | 5.84 | 8.17 |
| 2025-10 | BTC | Binance-Bybit | 93 | -1.75 | -1.82 | -9.94 | 5.34 | 7.90 |
| 2025-11 | BTC | Binance-Bybit | 90 | 2.68 | 2.46 | -1.86 | 7.75 | 6.07 |
| 2025-12 | BTC | Binance-Bybit | 93 | 1.82 | 1.75 | -3.85 | 7.54 | 7.00 |
| 2026-01 | BTC | Binance-Bybit | 93 | 2.16 | 1.70 | -3.19 | 7.53 | 5.87 |
| 2026-02 | BTC | Binance-Bybit | 84 | -2.37 | -2.58 | -9.34 | 5.06 | 7.50 |
| 2026-03 | BTC | Binance-Bybit | 93 | -0.94 | -1.31 | -6.41 | 4.60 | 9.03 |
| 2026-04 | BTC | Binance-Bybit | 90 | -1.24 | -0.67 | -8.28 | 5.13 | 7.70 |
| 2026-05 | BTC | Binance-Bybit | 93 | 0.66 | 0.44 | -5.23 | 6.33 | 8.35 |
| 2026-06 | BTC | Binance-Bybit | 90 | 1.07 | 1.15 | -4.52 | 6.40 | 6.07 |
| 2026-07 | BTC | Binance-Bybit | 93 | 2.03 | 2.16 | -3.23 | 7.03 | 5.87 |
| 2026-08 | BTC | Binance-Bybit | 15 | 0.98 | -0.93 | -3.51 | 6.23 | 9.80 |
| 2025-01 | ETH | HL-Binance | 92 | 2.33 | 0.15 | -3.57 | 7.27 | 4.11 |
| 2025-02 | ETH | HL-Binance | 84 | 3.39 | 3.53 | -6.90 | 12.04 | 5.00 |
| 2025-03 | ETH | HL-Binance | 93 | -0.78 | -0.03 | -13.28 | 10.25 | 6.32 |
| 2025-04 | ETH | HL-Binance | 90 | -5.00 | -4.76 | -15.80 | 6.12 | 6.30 |
| 2025-05 | ETH | HL-Binance | 93 | 6.07 | 4.60 | -0.47 | 17.20 | 2.26 |
| 2025-06 | ETH | HL-Binance | 90 | 2.47 | 2.64 | -6.26 | 10.91 | 4.67 |
| 2025-07 | ETH | HL-Binance | 92 | 13.64 | 8.06 | 0.00 | 34.44 | 0.91 |
| 2025-08 | ETH | HL-Binance | 93 | 5.24 | 4.96 | -4.54 | 15.48 | 3.16 |
| 2025-09 | ETH | HL-Binance | 90 | 4.42 | 5.65 | -4.81 | 13.23 | 3.27 |
| 2025-10 | ETH | HL-Binance | 93 | 3.81 | 5.25 | -2.32 | 11.14 | 3.16 |
| 2025-11 | ETH | HL-Binance | 90 | 2.85 | 3.55 | -4.62 | 9.20 | 3.50 |
| 2025-12 | ETH | HL-Binance | 93 | 4.68 | 5.07 | -2.06 | 10.85 | 2.71 |
| 2026-01 | ETH | HL-Binance | 93 | 3.23 | 3.12 | -2.78 | 10.06 | 4.97 |
| 2026-02 | ETH | HL-Binance | 84 | 5.79 | 6.62 | -6.47 | 16.82 | 2.75 |
| 2026-03 | ETH | HL-Binance | 93 | 3.77 | 3.75 | -4.63 | 12.98 | 6.32 |
| 2026-04 | ETH | HL-Binance | 90 | 1.11 | 2.37 | -11.31 | 10.16 | 4.43 |
| 2026-05 | ETH | HL-Binance | 93 | 4.20 | 4.53 | -3.04 | 11.87 | 3.61 |
| 2026-06 | ETH | HL-Binance | 90 | 2.73 | 3.83 | -9.54 | 11.55 | 4.20 |
| 2026-07 | ETH | HL-Binance | 93 | 5.58 | 5.88 | 1.16 | 9.58 | 1.35 |
| 2026-08 | ETH | HL-Binance | 15 | 1.83 | 0.00 | -2.32 | 7.00 | 7.00 |
| 2025-01 | ETH | HL-Bybit | 92 | 3.03 | 0.23 | -2.57 | 12.15 | 4.57 |
| 2025-02 | ETH | HL-Bybit | 84 | 2.31 | 2.00 | -7.04 | 11.12 | 5.75 |
| 2025-03 | ETH | HL-Bybit | 93 | -0.98 | -1.13 | -11.53 | 11.42 | 6.32 |
| 2025-04 | ETH | HL-Bybit | 90 | -6.01 | -5.15 | -16.74 | 4.72 | 3.97 |
| 2025-05 | ETH | HL-Bybit | 93 | 4.85 | 2.71 | -2.11 | 15.08 | 3.16 |
| 2025-06 | ETH | HL-Bybit | 90 | 4.15 | 3.60 | -4.06 | 12.34 | 4.67 |
| 2025-07 | ETH | HL-Bybit | 92 | 12.99 | 7.22 | 0.00 | 34.44 | 0.91 |
| 2025-08 | ETH | HL-Bybit | 93 | 5.30 | 4.01 | -4.93 | 17.73 | 2.26 |
| 2025-09 | ETH | HL-Bybit | 90 | 1.70 | 1.35 | -9.43 | 12.04 | 4.20 |
| 2025-10 | ETH | HL-Bybit | 93 | 4.04 | 2.39 | -1.00 | 11.66 | 3.84 |
| 2025-11 | ETH | HL-Bybit | 90 | 5.53 | 5.24 | -0.61 | 12.11 | 3.73 |
| 2025-12 | ETH | HL-Bybit | 93 | 7.26 | 8.43 | 0.23 | 14.29 | 0.90 |
| 2026-01 | ETH | HL-Bybit | 93 | 4.56 | 3.97 | -3.58 | 12.15 | 4.06 |
| 2026-02 | ETH | HL-Bybit | 84 | 1.37 | 2.43 | -12.05 | 11.38 | 5.25 |
| 2026-03 | ETH | HL-Bybit | 93 | 0.93 | 0.42 | -5.86 | 9.81 | 6.55 |
| 2026-04 | ETH | HL-Bybit | 90 | 0.34 | 1.43 | -10.13 | 8.45 | 8.17 |
| 2026-05 | ETH | HL-Bybit | 93 | 4.66 | 5.23 | -1.34 | 10.81 | 4.06 |
| 2026-06 | ETH | HL-Bybit | 90 | 3.02 | 4.13 | -8.33 | 12.10 | 3.27 |
| 2026-07 | ETH | HL-Bybit | 93 | 5.73 | 6.01 | 0.04 | 10.59 | 1.81 |
| 2026-08 | ETH | HL-Bybit | 15 | 4.22 | 5.46 | -0.51 | 8.93 | 5.60 |
| 2025-01 | ETH | Binance-Bybit | 93 | 0.76 | 0.00 | -2.50 | 5.31 | 2.48 |
| 2025-02 | ETH | Binance-Bybit | 84 | -1.08 | -0.92 | -8.87 | 6.05 | 6.00 |
| 2025-03 | ETH | Binance-Bybit | 93 | -0.19 | -0.82 | -8.08 | 8.61 | 6.10 |
| 2025-04 | ETH | Binance-Bybit | 90 | -1.01 | -0.80 | -8.33 | 4.87 | 7.23 |
| 2025-05 | ETH | Binance-Bybit | 93 | -1.22 | -0.51 | -8.69 | 6.99 | 5.87 |
| 2025-06 | ETH | Binance-Bybit | 90 | 1.68 | 1.46 | -3.25 | 7.58 | 7.93 |
| 2025-07 | ETH | Binance-Bybit | 93 | -0.64 | 0.00 | -5.21 | 1.44 | 2.71 |
| 2025-08 | ETH | Binance-Bybit | 93 | 0.07 | 0.00 | -5.45 | 6.58 | 5.87 |
| 2025-09 | ETH | Binance-Bybit | 90 | -2.73 | -2.93 | -9.85 | 4.53 | 5.37 |
| 2025-10 | ETH | Binance-Bybit | 93 | 0.22 | 0.00 | -8.19 | 4.76 | 7.68 |
| 2025-11 | ETH | Binance-Bybit | 90 | 2.69 | 1.54 | -4.11 | 11.47 | 7.47 |
| 2025-12 | ETH | Binance-Bybit | 93 | 2.58 | 2.02 | -3.19 | 9.84 | 5.19 |
| 2026-01 | ETH | Binance-Bybit | 93 | 1.33 | 0.73 | -4.49 | 7.83 | 8.13 |
| 2026-02 | ETH | Binance-Bybit | 84 | -4.42 | -4.19 | -11.98 | 2.83 | 5.00 |
| 2026-03 | ETH | Binance-Bybit | 93 | -2.84 | -2.42 | -7.98 | 2.05 | 7.68 |
| 2026-04 | ETH | Binance-Bybit | 90 | -0.77 | -0.96 | -7.62 | 6.51 | 6.07 |
| 2026-05 | ETH | Binance-Bybit | 93 | 0.46 | 0.21 | -5.16 | 5.63 | 9.26 |
| 2026-06 | ETH | Binance-Bybit | 90 | 0.29 | -0.14 | -5.48 | 5.48 | 7.70 |
| 2026-07 | ETH | Binance-Bybit | 93 | 0.14 | 0.26 | -4.05 | 3.95 | 9.26 |
| 2026-08 | ETH | Binance-Bybit | 15 | 2.38 | 1.81 | 0.22 | 4.77 | 5.60 |

## Strategy simulation

Gross, cost drag, and net are annualized percentages on total deployed capital. Cost drag includes every entry and exit, including forced boundary exits.

| Asset | Pair | Entry % | Exit % | Gross ann. % | Cost drag ann. % | Net ann. % | Round trips |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SOL | HL-Binance | 5 | 2.5 | 1.93 | 14.40 | -12.47 | 170 |
| SOL | HL-Binance | 10 | 5 | 1.51 | 10.59 | -9.08 | 125 |
| SOL | HL-Binance | 15 | 7.5 | 1.07 | 6.18 | -5.12 | 73 |
| SOL | HL-Bybit | 5 | 2.5 | 1.83 | 16.60 | -14.77 | 189 |
| SOL | HL-Bybit | 10 | 5 | 1.56 | 12.65 | -11.09 | 144 |
| SOL | HL-Bybit | 15 | 7.5 | 1.10 | 7.55 | -6.46 | 86 |
| SOL | Binance-Bybit | 5 | 2.5 | 0.45 | 15.92 | -15.47 | 175 |
| SOL | Binance-Bybit | 10 | 5 | 0.27 | 8.28 | -8.01 | 91 |
| SOL | Binance-Bybit | 15 | 7.5 | 0.18 | 3.09 | -2.91 | 34 |
| BTC | HL-Binance | 5 | 2.5 | 1.90 | 11.52 | -9.62 | 136 |
| BTC | HL-Binance | 10 | 5 | 1.13 | 6.52 | -5.39 | 77 |
| BTC | HL-Binance | 15 | 7.5 | 0.60 | 2.63 | -2.02 | 31 |
| BTC | HL-Bybit | 5 | 2.5 | 1.91 | 12.38 | -10.47 | 141 |
| BTC | HL-Bybit | 10 | 5 | 1.17 | 7.82 | -6.65 | 89 |
| BTC | HL-Bybit | 15 | 7.5 | 0.65 | 3.25 | -2.60 | 37 |
| BTC | Binance-Bybit | 5 | 2.5 | 0.45 | 12.28 | -11.83 | 135 |
| BTC | Binance-Bybit | 10 | 5 | 0.12 | 3.18 | -3.06 | 35 |
| BTC | Binance-Bybit | 15 | 7.5 | 0.04 | 1.18 | -1.14 | 13 |
| ETH | HL-Binance | 5 | 2.5 | 1.85 | 11.35 | -9.50 | 134 |
| ETH | HL-Binance | 10 | 5 | 1.15 | 6.69 | -5.54 | 79 |
| ETH | HL-Binance | 15 | 7.5 | 0.56 | 3.47 | -2.91 | 41 |
| ETH | HL-Bybit | 5 | 2.5 | 1.70 | 12.47 | -10.77 | 142 |
| ETH | HL-Bybit | 10 | 5 | 1.15 | 7.38 | -6.23 | 84 |
| ETH | HL-Bybit | 15 | 7.5 | 0.69 | 3.60 | -2.91 | 41 |
| ETH | Binance-Bybit | 5 | 2.5 | 0.37 | 12.55 | -12.18 | 138 |
| ETH | Binance-Bybit | 10 | 5 | 0.17 | 4.37 | -4.20 | 48 |
| ETH | Binance-Bybit | 15 | 7.5 | 0.05 | 1.00 | -0.95 | 11 |

## Time-split validation

Each half starts flat; no position or P&L crosses the split.

| Asset | Pair | Entry % | First-half net ann. % | Second-half net ann. % | Worse half % |
| --- | --- | --- | --- | --- | --- |
| SOL | HL-Binance | 5 | -12.23 | -12.71 | -12.71 |
| SOL | HL-Binance | 10 | -10.56 | -7.59 | -10.56 |
| SOL | HL-Binance | 15 | -7.17 | -3.06 | -7.17 |
| SOL | HL-Bybit | 5 | -13.63 | -15.89 | -15.89 |
| SOL | HL-Bybit | 10 | -12.12 | -10.05 | -12.12 |
| SOL | HL-Bybit | 15 | -7.73 | -5.18 | -7.73 |
| SOL | Binance-Bybit | 5 | -15.37 | -15.57 | -15.57 |
| SOL | Binance-Bybit | 10 | -8.12 | -7.90 | -8.12 |
| SOL | Binance-Bybit | 15 | -3.15 | -2.68 | -3.15 |
| BTC | HL-Binance | 5 | -8.63 | -10.79 | -10.79 |
| BTC | HL-Binance | 10 | -5.76 | -5.20 | -5.76 |
| BTC | HL-Binance | 15 | -2.80 | -1.26 | -2.80 |
| BTC | HL-Bybit | 5 | -9.14 | -11.98 | -11.98 |
| BTC | HL-Bybit | 10 | -7.85 | -5.45 | -7.85 |
| BTC | HL-Bybit | 15 | -4.54 | -0.66 | -4.54 |
| BTC | Binance-Bybit | 5 | -12.32 | -11.34 | -12.32 |
| BTC | Binance-Bybit | 10 | -3.98 | -2.14 | -3.98 |
| BTC | Binance-Bybit | 15 | -1.92 | -0.36 | -1.92 |
| ETH | HL-Binance | 5 | -9.82 | -9.17 | -9.82 |
| ETH | HL-Binance | 10 | -6.47 | -4.61 | -6.47 |
| ETH | HL-Binance | 15 | -3.99 | -1.83 | -3.99 |
| ETH | HL-Bybit | 5 | -11.56 | -9.96 | -11.56 |
| ETH | HL-Bybit | 10 | -6.89 | -5.56 | -6.89 |
| ETH | HL-Bybit | 15 | -4.18 | -1.64 | -4.18 |
| ETH | Binance-Bybit | 5 | -13.03 | -11.32 | -13.03 |
| ETH | Binance-Bybit | 10 | -4.21 | -4.18 | -4.21 |
| ETH | Binance-Bybit | 15 | -0.85 | -1.06 | -1.06 |

## Position-count reality

Worst round trip is net of both funding and all entry/exit costs. Holding time is entry-to-exit calendar days.

| Asset | Pair | Entry % | Round trips | Round trips/year | Avg hold days | Worst trip % | Cost/trip % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SOL | HL-Binance | 5 | 170 | 106.64 | 2.24 | -0.20 | 0.135 |
| SOL | HL-Binance | 10 | 125 | 78.42 | 1.95 | -0.20 | 0.135 |
| SOL | HL-Binance | 15 | 73 | 45.79 | 1.90 | -0.20 | 0.135 |
| SOL | HL-Bybit | 5 | 189 | 118.56 | 1.99 | -0.17 | 0.140 |
| SOL | HL-Bybit | 10 | 144 | 90.33 | 1.78 | -0.17 | 0.140 |
| SOL | HL-Bybit | 15 | 86 | 53.95 | 1.62 | -0.17 | 0.140 |
| SOL | Binance-Bybit | 5 | 175 | 109.78 | 1.67 | -0.24 | 0.145 |
| SOL | Binance-Bybit | 10 | 91 | 57.09 | 1.43 | -0.24 | 0.145 |
| SOL | Binance-Bybit | 15 | 34 | 21.33 | 1.32 | -0.22 | 0.145 |
| BTC | HL-Binance | 5 | 136 | 85.32 | 2.77 | -0.15 | 0.135 |
| BTC | HL-Binance | 10 | 77 | 48.30 | 2.34 | -0.15 | 0.135 |
| BTC | HL-Binance | 15 | 31 | 19.45 | 1.97 | -0.15 | 0.135 |
| BTC | HL-Bybit | 5 | 141 | 88.45 | 2.60 | -0.15 | 0.140 |
| BTC | HL-Bybit | 10 | 89 | 55.83 | 2.09 | -0.15 | 0.140 |
| BTC | HL-Bybit | 15 | 37 | 23.21 | 1.95 | -0.15 | 0.140 |
| BTC | Binance-Bybit | 5 | 135 | 84.69 | 1.75 | -0.16 | 0.145 |
| BTC | Binance-Bybit | 10 | 35 | 21.96 | 1.34 | -0.16 | 0.145 |
| BTC | Binance-Bybit | 15 | 13 | 8.16 | 1.23 | -0.16 | 0.145 |
| ETH | HL-Binance | 5 | 134 | 84.06 | 2.74 | -0.17 | 0.135 |
| ETH | HL-Binance | 10 | 79 | 49.56 | 2.27 | -0.15 | 0.135 |
| ETH | HL-Binance | 15 | 41 | 25.72 | 1.61 | -0.15 | 0.135 |
| ETH | HL-Bybit | 5 | 142 | 89.08 | 2.43 | -0.16 | 0.140 |
| ETH | HL-Bybit | 10 | 84 | 52.70 | 2.10 | -0.16 | 0.140 |
| ETH | HL-Bybit | 15 | 41 | 25.72 | 1.98 | -0.15 | 0.140 |
| ETH | Binance-Bybit | 5 | 138 | 86.57 | 1.73 | -0.19 | 0.145 |
| ETH | Binance-Bybit | 10 | 48 | 30.11 | 1.33 | -0.15 | 0.145 |
| ETH | Binance-Bybit | 15 | 11 | 6.90 | 1.18 | -0.15 | 0.145 |

## Interpretation limits

This is a funding-cashflow audit, not a complete historical cross-venue perp P&L reconstruction. It assumes continuously matched $1 notionals and excludes cross-venue mark-price/basis divergence, collateral yield, borrow costs, transfers, taxes, liquidation mechanics, and dynamic margin top-ups. Slippage covers execution only. Because history endpoints expose realized rather than contemporaneously predicted funding, the signal deliberately lags one completed block; any backtest entering before that payment would contain look-ahead.

## What would break this live

- **Venue risk:** insolvency, withdrawal freezes, ADL, API degradation, or different mark/index methodologies can turn a hedged price position into an unsecured venue exposure.
- **Funding reversal speed:** spreads can invert inside the daily decision interval. The backtest bears those signed payments until the next rebalance; live latency and forecast error may be worse.
- **Collateral fragmentation:** 1× per leg still requires two separately funded margin accounts. A move that creates gains on one venue and losses on the other can trigger a margin call before collateral is transferable.
- **Basis and execution:** same-asset perps need not track identically during stress. The fixed 0.02% slippage assumption can fail precisely when the carry is largest.
