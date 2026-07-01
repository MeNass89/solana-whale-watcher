# Whale-convergence alpha report

Generated 2026-07-01T22:11:02.023Z by `src/backtest` harness (branch alpha-harness).
Modeling assumptions (slippage, SOL/USD approximation, candle tolerances, no shorting) are documented in src/backtest/README.md.

## Signal study — forward returns by wallet_count × pump × tier

Resolved convergences with a positive detection price: **384**.
Returns in %, relative to price_at_detection. "wmean" = winsorized mean (1%/99%). Win rate = share of returns > 0 at that horizon.

| wallets | pump | tier | n | med 24h | mean 24h | wmean 24h | wr 24h | med 7d | mean 7d | wmean 7d | wr 7d | WIN/LOSS/FLAT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 | non-pump | NOTABLE | 81 | -85.75 | -56.37 | -56.79 | 1.2% | -89.59 | -67.57 | -67.57 | 0.0% | 0/81/0 |
| 2 | pump | NOTABLE | 201 | -2.93 | 46.13 | 46.13 | 41.3% | -79.85 | -64.75 | -64.86 | 5.0% | 8/188/5 |
| 3 | non-pump | CRITICAL | 16 | -89.23 | -66.30 | -66.26 | 0.0% | -91.08 | -74.98 | -75.05 | 0.0% | 0/16/0 |
| 3 | pump | CRITICAL | 61 | 0.00 | -13.84 | -13.84 | 9.8% | -24.35 | -26.70 | -26.70 | 9.8% | 2/59/0 |
| 4 | pump | CRITICAL | 3 | -46.74 | -43.18 | -43.25 | 0.0% | -56.68 | -48.83 | -48.99 | 0.0% | 0/3/0 |
| 5+ | pump | CRITICAL | 22 | -18.50 | -29.55 | -29.55 | 0.0% | -32.08 | -36.38 | -36.38 | 13.6% | 0/22/0 |

### Early-finding check (2-wallet pump ≈ +9%/24h vs 3+ wallets ≈ −20…−66%)

- 2-wallet pump: mean 24h = **46.13%** (wmean 46.13%, n=201)
- 3+ wallets (all): mean 24h = **-26.32%** (wmean -26.30%, n=102)
- Interpretation: no shorting is possible on these pools, so a negative heavy-convergence signal is a **filter/avoid** rule, not a tradeable fade.

## Horizon curve — candle-based forward returns, 1m → 12h

Baseline = candle close at detection time (stored price_at_detection is NOT used — it was stamped late for backlogged rows). **642** of 16760 convergences have candle coverage. med = median %, wm = winsorized mean % (1/99), wr = share > 0.

### 2 wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 121 | 9.4 | -4.7 | 67% |
| 2m | 124 | 3.4 | -3.9 | 52% |
| 5m | 121 | 28.0 | 12.7 | 75% |
| 10m | 123 | 57.3 | 51.1 | 76% |
| 15m | 104 | 110.9 | 79.6 | 79% |
| 30m | 107 | 71.4 | 132.5 | 77% |
| 1h | 108 | 59.3 | 97.0 | 59% |
| 2h | 108 | 9.6 | 125.4 | 56% |
| 4h | 109 | -26.0 | -21.2 | 41% |
| 8h | 103 | -28.2 | -16.6 | 43% |
| 12h | 103 | -38.0 | -38.1 | 0% |

### 2 wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 294 | -0.1 | -2.3 | 44% |
| 2m | 299 | -0.7 | -4.3 | 45% |
| 5m | 331 | 5.2 | 13.6 | 56% |
| 10m | 341 | 0.8 | 0.8 | 50% |
| 15m | 340 | -6.8 | -6.7 | 35% |
| 30m | 340 | -21.5 | 12.1 | 42% |
| 1h | 315 | -12.9 | 93.0 | 43% |
| 2h | 283 | -17.7 | -28.5 | 30% |
| 4h | 302 | -51.5 | 77.2 | 24% |
| 8h | 291 | -68.3 | 7.5 | 20% |
| 12h | 296 | -67.3 | -7.8 | 26% |

### 3 wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 27 | -4.9 | -34.8 | 41% |
| 2m | 27 | -3.5 | -36.0 | 44% |
| 5m | 27 | -13.3 | -32.0 | 48% |
| 10m | 27 | -23.3 | -29.0 | 41% |
| 15m | 27 | -18.4 | -25.0 | 41% |
| 30m | 47 | -37.4 | -24.9 | 19% |
| 1h | 47 | -27.9 | -30.4 | 17% |
| 2h | 47 | -90.9 | -69.2 | 9% |
| 4h | 47 | -91.3 | -81.5 | 0% |
| 8h | 36 | -95.7 | -76.1 | 0% |
| 12h | 36 | -95.1 | -85.6 | 0% |

### 3 wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 53 | 44.7 | 28.9 | 79% |
| 2m | 74 | 28.6 | 16.8 | 55% |
| 5m | 74 | 49.3 | 56.7 | 95% |
| 10m | 74 | 20.2 | 22.5 | 82% |
| 15m | 74 | -0.4 | -10.4 | 32% |
| 30m | 74 | -13.4 | -16.8 | 5% |
| 1h | 74 | -53.2 | -36.6 | 49% |
| 2h | 71 | 14.8 | -32.1 | 52% |
| 4h | 74 | -68.1 | -39.3 | 47% |
| 8h | 74 | -74.0 | -38.9 | 49% |
| 12h | 72 | -53.8 | -56.8 | 3% |

### 4 wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 30m | 3 | -37.4 | -37.4 | 0% |
| 1h | 3 | -27.9 | -27.9 | 0% |
| 2h | 3 | -90.9 | -90.9 | 0% |
| 4h | 3 | -94.4 | -94.4 | 0% |
| 8h | 3 | -95.7 | -95.7 | 0% |
| 12h | 3 | -95.1 | -95.1 | 0% |

### 4 wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 6 | -2.4 | -3.8 | 17% |
| 2m | 8 | -0.7 | -1.6 | 13% |
| 5m | 8 | 42.6 | 52.8 | 88% |
| 10m | 8 | -60.7 | -16.7 | 38% |
| 15m | 8 | -70.1 | -45.2 | 25% |
| 30m | 8 | -55.7 | -48.4 | 0% |
| 1h | 8 | -86.6 | -83.8 | 0% |
| 2h | 7 | -90.6 | -87.2 | 0% |
| 4h | 8 | -91.9 | -90.8 | 0% |
| 8h | 8 | -90.5 | -89.9 | 0% |
| 12h | 7 | -92.1 | -92.0 | 0% |

### 5+ wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 22 | 36.8 | 36.8 | 100% |
| 2m | 22 | 28.6 | 28.6 | 100% |
| 5m | 22 | 175.9 | 175.9 | 100% |
| 10m | 22 | 16.4 | 16.4 | 100% |
| 15m | 22 | -24.9 | -24.9 | 0% |
| 30m | 22 | -33.6 | -33.6 | 0% |
| 1h | 22 | -80.6 | -80.6 | 0% |
| 2h | 22 | -69.4 | -69.4 | 0% |
| 4h | 22 | -88.2 | -88.2 | 0% |
| 8h | 22 | -92.0 | -92.0 | 0% |
| 12h | 22 | -93.7 | -93.7 | 0% |

## Replay backtest

_Not yet run — execute `npx tsx src/backtest/cli.ts replay` once the candle fetch has finished, then re-run `report`._
