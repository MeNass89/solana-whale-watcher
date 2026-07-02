# Whale-convergence alpha report

Generated 2026-07-02T07:31:10.850Z by `src/backtest` harness (branch alpha-harness).
Modeling assumptions (slippage, SOL/USD approximation, candle tolerances, no shorting) are documented in src/backtest/README.md.

## Signal study — forward returns by wallet_count × pump × tier

Resolved convergences with a positive detection price: **6322**.
Returns in %, relative to price_at_detection. "wmean" = winsorized mean (1%/99%). Win rate = share of returns > 0 at that horizon.

| wallets | pump | tier | n | med 24h | mean 24h | wmean 24h | wr 24h | med 7d | mean 7d | wmean 7d | wr 7d | WIN/LOSS/FLAT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 | non-pump | NOTABLE | 448 | -44.18 | -28.02 | -28.01 | 7.0% | -80.45 | -21.50 | -39.02 | 7.1% | 35/385/28 |
| 2 | pump | NOTABLE | 4431 | -21.77 | 51.63 | -15.81 | 17.5% | -34.32 | 71.77 | -9.71 | 34.6% | 908/2923/600 |
| 3 | non-pump | CRITICAL | 76 | -31.23 | -10.29 | -10.26 | 12.2% | -70.01 | -63.94 | -63.94 | 3.9% | 3/29/44 |
| 3 | pump | CRITICAL | 904 | -28.81 | 12.48 | 12.46 | 10.6% | -13.51 | -7.57 | -8.68 | 43.7% | 359/416/129 |
| 4 | non-pump | CRITICAL | 27 | -58.98 | -67.65 | -67.65 | 7.4% | -72.56 | -82.83 | -82.83 | 0.0% | 0/27/0 |
| 4 | pump | CRITICAL | 196 | -25.80 | -7.65 | -12.28 | 18.6% | -52.77 | -6.22 | -6.30 | 21.4% | 7/152/37 |
| 5+ | non-pump | CRITICAL | 34 | -91.36 | -55.62 | -55.62 | 38.2% | -96.47 | -90.04 | -90.04 | 0.0% | 0/34/0 |
| 5+ | pump | CRITICAL | 206 | -79.86 | -54.71 | -54.74 | 3.4% | -92.46 | -70.45 | -74.70 | 3.4% | 0/201/5 |

### Early-finding check (2-wallet pump ≈ +9%/24h vs 3+ wallets ≈ −20…−66%)

- 2-wallet pump: mean 24h = **51.63%** (wmean -15.81%, n=4382)
- 3+ wallets (all): mean 24h = **-4.12%** (wmean -24.08%, n=1436)
- Interpretation: no shorting is possible on these pools, so a negative heavy-convergence signal is a **filter/avoid** rule, not a tradeable fade.

## Horizon curve — candle-based forward returns, 1m → 12h

Anchor t0 = last_trade_at (the trigger trade — the earliest moment the signal is detectable); baseline = candle close at t0 (stored price_at_detection is NOT used). Deduped to the first trigger per token × wallet-bucket: **1677** unique signals from 16761 rows, **1203** with candle coverage. med = median %, wm = winsorized mean % (1/99), wr = share > 0.

### 2 wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 96 | -6.1 | -6.6 | 39% |
| 2m | 96 | -12.8 | -12.2 | 29% |
| 5m | 98 | -19.0 | -14.3 | 31% |
| 10m | 95 | -31.2 | -17.6 | 28% |
| 15m | 86 | -38.8 | -20.8 | 24% |
| 30m | 80 | -50.9 | -18.6 | 25% |
| 1h | 73 | -55.0 | -22.5 | 21% |
| 2h | 47 | -54.0 | -20.3 | 21% |
| 4h | 74 | -70.2 | -50.0 | 15% |
| 8h | 63 | -71.6 | -48.2 | 11% |
| 12h | 71 | -73.9 | -53.1 | 10% |

### 2 wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 719 | -1.2 | -2.6 | 42% |
| 2m | 725 | -2.0 | -4.7 | 41% |
| 5m | 753 | -6.6 | -8.9 | 34% |
| 10m | 730 | -11.3 | -12.1 | 32% |
| 15m | 707 | -13.7 | -12.4 | 29% |
| 30m | 696 | -23.7 | -15.4 | 28% |
| 1h | 637 | -28.7 | -18.2 | 27% |
| 2h | 386 | -43.0 | -18.9 | 24% |
| 4h | 678 | -55.0 | -34.5 | 17% |
| 8h | 631 | -62.4 | -40.6 | 17% |
| 12h | 615 | -64.2 | -42.4 | 16% |

### 3 wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 24 | -3.0 | -2.9 | 42% |
| 2m | 24 | -3.6 | -5.9 | 33% |
| 5m | 25 | -20.9 | -22.4 | 28% |
| 10m | 26 | -21.1 | -17.2 | 27% |
| 15m | 24 | -22.3 | -2.9 | 33% |
| 30m | 25 | -36.1 | 6.8 | 28% |
| 1h | 25 | -46.9 | 3.9 | 28% |
| 2h | 15 | -72.6 | -42.5 | 13% |
| 4h | 24 | -79.0 | -56.1 | 13% |
| 8h | 20 | -75.0 | -47.5 | 15% |
| 12h | 23 | -77.2 | -52.1 | 13% |

### 3 wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 151 | -4.8 | -8.3 | 34% |
| 2m | 153 | -5.1 | -8.6 | 34% |
| 5m | 153 | -9.6 | -10.3 | 37% |
| 10m | 152 | -21.8 | -17.0 | 30% |
| 15m | 151 | -26.2 | -18.8 | 26% |
| 30m | 148 | -38.5 | -14.3 | 22% |
| 1h | 140 | -50.8 | -22.1 | 19% |
| 2h | 80 | -55.3 | -11.7 | 25% |
| 4h | 145 | -70.0 | -47.9 | 12% |
| 8h | 139 | -70.2 | -48.8 | 13% |
| 12h | 136 | -76.0 | -48.9 | 12% |

### 4 wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 10 | -0.8 | 9.5 | 50% |
| 2m | 10 | -1.8 | 8.1 | 50% |
| 5m | 11 | -6.4 | 7.5 | 27% |
| 10m | 11 | -15.0 | 5.4 | 36% |
| 15m | 10 | -17.5 | 45.0 | 30% |
| 30m | 10 | -3.9 | 50.2 | 40% |
| 1h | 10 | -15.9 | -3.2 | 30% |
| 2h | 3 | -72.7 | -56.7 | 0% |
| 4h | 11 | -63.5 | -53.4 | 9% |
| 8h | 10 | -76.5 | -62.2 | 0% |
| 12h | 11 | -59.5 | -58.2 | 0% |

### 4 wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 54 | -0.1 | -2.6 | 46% |
| 2m | 53 | -3.1 | -3.6 | 42% |
| 5m | 53 | -8.5 | -5.5 | 34% |
| 10m | 52 | -25.7 | -14.6 | 21% |
| 15m | 50 | -21.8 | -12.0 | 32% |
| 30m | 48 | -31.3 | -16.8 | 25% |
| 1h | 44 | -53.7 | -38.6 | 11% |
| 2h | 26 | -56.9 | -41.5 | 19% |
| 4h | 51 | -73.7 | -57.1 | 8% |
| 8h | 48 | -73.4 | -63.2 | 6% |
| 12h | 49 | -74.6 | -64.8 | 10% |

### 5+ wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 2 | 14.5 | 14.5 | 50% |
| 2m | 2 | 15.7 | 15.7 | 50% |
| 5m | 2 | -6.9 | -6.9 | 50% |
| 10m | 2 | -22.6 | -22.6 | 50% |
| 15m | 2 | -19.7 | -19.7 | 50% |
| 30m | 2 | 19.0 | 19.0 | 50% |
| 1h | 2 | -47.0 | -47.0 | 0% |
| 2h | 1 | -84.2 | -84.2 | 0% |
| 4h | 2 | -84.4 | -84.4 | 0% |
| 8h | 2 | -77.6 | -77.6 | 0% |
| 12h | 2 | -84.3 | -84.3 | 0% |

### 5+ wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 18 | -3.0 | -4.3 | 28% |
| 2m | 18 | -2.6 | -3.0 | 39% |
| 5m | 18 | -1.1 | -1.0 | 50% |
| 10m | 19 | -7.0 | -4.5 | 42% |
| 15m | 17 | -10.8 | -1.5 | 41% |
| 30m | 17 | -22.6 | -4.5 | 35% |
| 1h | 17 | -36.2 | -19.4 | 18% |
| 2h | 12 | -45.6 | -32.7 | 33% |
| 4h | 18 | -47.2 | -40.7 | 17% |
| 8h | 18 | -64.6 | -55.0 | 11% |
| 12h | 19 | -67.9 | -55.5 | 16% |

## Replay backtest

_Not yet run — execute `npx tsx src/backtest/cli.ts replay` once the candle fetch has finished, then re-run `report`._
