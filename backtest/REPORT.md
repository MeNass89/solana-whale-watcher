# Whale-convergence alpha report

Generated 2026-07-01T22:03:36.994Z by `src/backtest` harness (branch alpha-harness).
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

## Horizon curve — candle-based forward returns, 5m → 7d

Baseline = candle close at detection time (stored price_at_detection is NOT used — it was stamped late for backlogged rows). **548** of 16759 convergences have candle coverage. med = median %, wm = winsorized mean % (1/99), wr = share > 0.

### 2 wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 5m | 120 | 28.0 | 12.9 | 76% |
| 15m | 104 | 110.9 | 79.6 | 79% |
| 30m | 106 | 71.4 | 133.9 | 77% |
| 1h | 108 | 59.3 | 97.0 | 59% |
| 2h | 108 | 9.6 | 125.4 | 56% |
| 4h | 108 | -40.6 | -21.3 | 42% |
| 8h | 103 | -28.2 | -16.6 | 43% |
| 12h | 103 | -38.0 | -38.1 | 0% |
| 24h | 103 | -55.1 | -53.9 | 0% |
| 48h | 88 | -89.1 | -89.7 | 0% |
| 7d | 84 | -91.6 | -89.6 | 4% |

### 2 wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 5m | 251 | 12.9 | 25.0 | 63% |
| 15m | 266 | -5.7 | 0.2 | 36% |
| 30m | 266 | -22.6 | 23.9 | 43% |
| 1h | 240 | -13.1 | 132.1 | 48% |
| 2h | 221 | -24.1 | -26.5 | 30% |
| 4h | 233 | -51.0 | 112.9 | 23% |
| 8h | 240 | -71.4 | 18.0 | 22% |
| 12h | 227 | -67.3 | 5.8 | 30% |
| 24h | 227 | -64.2 | 21.4 | 35% |
| 48h | 210 | -83.3 | -39.2 | 18% |
| 7d | 209 | -85.4 | -76.6 | 4% |

### 3 wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 5m | 27 | -13.3 | -32.0 | 48% |
| 15m | 27 | -18.4 | -25.0 | 41% |
| 30m | 47 | -37.4 | -24.9 | 19% |
| 1h | 47 | -27.9 | -30.4 | 17% |
| 2h | 47 | -90.9 | -69.2 | 9% |
| 4h | 47 | -91.3 | -81.5 | 0% |
| 8h | 36 | -95.7 | -76.1 | 0% |
| 12h | 36 | -95.1 | -85.6 | 0% |
| 24h | 36 | -96.6 | -90.0 | 0% |
| 48h | 36 | -97.7 | -96.1 | 0% |
| 7d | 16 | -96.0 | -96.3 | 0% |

### 3 wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 5m | 65 | 49.3 | 60.9 | 95% |
| 15m | 65 | -0.4 | -2.8 | 37% |
| 30m | 65 | -2.3 | -12.0 | 5% |
| 1h | 65 | 3.2 | -29.3 | 55% |
| 2h | 63 | 14.8 | -24.7 | 59% |
| 4h | 65 | 6.7 | -32.0 | 54% |
| 8h | 65 | 9.6 | -31.8 | 55% |
| 12h | 63 | -27.3 | -51.8 | 3% |
| 24h | 63 | -19.4 | -49.6 | 3% |
| 48h | 62 | -33.8 | -57.3 | 3% |
| 7d | 61 | -55.9 | -67.0 | 3% |

### 4 wallets, non-pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 30m | 3 | -37.4 | -37.4 | 0% |
| 1h | 3 | -27.9 | -27.9 | 0% |
| 2h | 3 | -90.9 | -90.9 | 0% |
| 4h | 3 | -94.4 | -94.4 | 0% |
| 8h | 3 | -95.7 | -95.7 | 0% |
| 12h | 3 | -95.1 | -95.1 | 0% |
| 24h | 3 | -96.6 | -96.6 | 0% |
| 48h | 3 | -97.7 | -97.7 | 0% |

### 4 wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 5m | 4 | 74.7 | 63.1 | 75% |
| 15m | 4 | -8.6 | -20.0 | 50% |
| 30m | 4 | -29.0 | -41.2 | 0% |
| 1h | 4 | -77.9 | -78.8 | 0% |
| 2h | 3 | -88.6 | -82.4 | 0% |
| 4h | 4 | -89.6 | -88.9 | 0% |
| 8h | 4 | -89.7 | -89.3 | 0% |
| 12h | 3 | -91.1 | -92.0 | 0% |
| 24h | 3 | -92.9 | -93.6 | 0% |
| 48h | 3 | -93.4 | -93.9 | 0% |
| 7d | 3 | -94.3 | -94.7 | 0% |

### 5+ wallets, pump

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 5m | 22 | 175.9 | 175.9 | 100% |
| 15m | 22 | -24.9 | -24.9 | 0% |
| 30m | 22 | -33.6 | -33.6 | 0% |
| 1h | 22 | -80.6 | -80.6 | 0% |
| 2h | 22 | -69.4 | -69.4 | 0% |
| 4h | 22 | -88.2 | -88.2 | 0% |
| 8h | 22 | -92.0 | -92.0 | 0% |
| 12h | 22 | -93.7 | -93.7 | 0% |
| 24h | 22 | -94.8 | -94.8 | 0% |
| 48h | 22 | -95.0 | -95.0 | 0% |
| 7d | 22 | -95.6 | -95.6 | 0% |

## Replay backtest

_Not yet run — execute `npx tsx src/backtest/cli.ts replay` once the candle fetch has finished, then re-run `report`._
