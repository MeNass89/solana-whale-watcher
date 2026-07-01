# Whale-convergence alpha report

Generated 2026-07-01T21:53:15.576Z by `src/backtest` harness (branch alpha-harness).
Modeling assumptions (slippage, SOL/USD approximation, candle tolerances, no shorting) are documented in src/backtest/README.md.

## Signal study — forward returns by wallet_count × pump × tier

Resolved convergences with a positive detection price: **37**.
Returns in %, relative to price_at_detection. "wmean" = winsorized mean (1%/99%). Win rate = share of returns > 0 at that horizon.

| wallets | pump | tier | n | med 24h | mean 24h | wmean 24h | wr 24h | med 7d | mean 7d | wmean 7d | wr 7d | WIN/LOSS/FLAT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 | pump | NOTABLE | 14 | -23.44 | -27.54 | -27.38 | 0.0% | -45.92 | -27.78 | -28.85 | 7.1% | 1/9/4 |
| 3 | pump | CRITICAL | 21 | -30.85 | -39.21 | -39.22 | 4.8% | -47.40 | -48.26 | -48.27 | 9.5% | 0/17/4 |
| 4 | pump | CRITICAL | 2 | -54.57 | -54.57 | -54.57 | 0.0% | -57.21 | -57.21 | -57.21 | 0.0% | 0/2/0 |

### Early-finding check (2-wallet pump ≈ +9%/24h vs 3+ wallets ≈ −20…−66%)

- 2-wallet pump: mean 24h = **-27.54%** (wmean -27.38%, n=14)
- 3+ wallets (all): mean 24h = **-40.54%** (wmean -40.56%, n=23)
- Interpretation: no shorting is possible on these pools, so a negative heavy-convergence signal is a **filter/avoid** rule, not a tradeable fade.

## Replay backtest

_Not yet run — execute `npx tsx src/backtest/cli.ts replay` once the candle fetch has finished, then re-run `report`._
