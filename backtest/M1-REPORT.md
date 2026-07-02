# m=1 study — first whale buy per token

Signal = first tracked-wallet BUY per token, anchored at the buy's block_time (detectable in seconds via webhook). Universe: 7914 tokens; deterministic sample: 2000; with candles: 254; with baseline+returns: 200. Walk-forward split at 2026-05-28 (train 87 / valid 113).

## Horizon curves (candle returns, no execution costs)

### All signals (n=200)

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 170 | -3.6 | -4.6 | 35% |
| 2m | 167 | -9.0 | -3.5 | 40% |
| 5m | 172 | -15.8 | -9.3 | 37% |
| 10m | 174 | -27.3 | -18.2 | 29% |
| 15m | 173 | -25.9 | -7.1 | 31% |
| 30m | 164 | -38.6 | -16.7 | 27% |
| 1h | 151 | -49.5 | -24.1 | 28% |
| 2h | 122 | -60.2 | -30.6 | 19% |
| 4h | 148 | -68.9 | -45.5 | 18% |
| 8h | 128 | -77.0 | -51.3 | 16% |
| 12h | 137 | -79.3 | -53.5 | 16% |

### Pump tokens

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 144 | -3.2 | -4.6 | 36% |
| 2m | 142 | -4.3 | -2.6 | 42% |
| 5m | 147 | -9.3 | -8.3 | 38% |
| 10m | 150 | -25.5 | -14.9 | 31% |
| 15m | 150 | -23.1 | -7.4 | 31% |
| 30m | 142 | -39.2 | -16.7 | 26% |
| 1h | 133 | -50.5 | -24.4 | 27% |
| 2h | 106 | -60.2 | -27.8 | 20% |
| 4h | 130 | -69.5 | -43.5 | 18% |
| 8h | 112 | -78.7 | -52.0 | 15% |
| 12h | 120 | -82.0 | -53.5 | 16% |

### Non-pump tokens

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 26 | -7.6 | -5.2 | 27% |
| 2m | 25 | -19.6 | -7.4 | 28% |
| 5m | 25 | -38.1 | -15.6 | 28% |
| 10m | 24 | -52.3 | -32.1 | 21% |
| 15m | 23 | -51.3 | -6.6 | 30% |
| 30m | 22 | -38.1 | -13.7 | 36% |
| 1h | 18 | -34.4 | -19.0 | 33% |
| 2h | 16 | -58.7 | -47.7 | 13% |
| 4h | 18 | -67.0 | -59.9 | 11% |
| 8h | 16 | -68.4 | -44.9 | 19% |
| 12h | 17 | -69.2 | -54.0 | 18% |

### Buy size ≥ $500

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|

## Walk-forward wallet selection

Wallets ranked on TRAIN half only (median 15m return, ≥5 signals): 5 rankable, top quartile = 1 elite wallets. Their VALID-half signals vs the rest:

### Elite wallets, valid half (n=0)

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|

### Non-elite wallets, valid half (n=113)

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 98 | -2.4 | 0.8 | 40% |
| 2m | 95 | -6.2 | 2.3 | 41% |
| 5m | 99 | -14.2 | -6.7 | 37% |
| 10m | 99 | -25.4 | -18.9 | 31% |
| 15m | 96 | -28.7 | -10.5 | 28% |
| 30m | 94 | -38.4 | -11.6 | 31% |
| 1h | 83 | -38.3 | -12.9 | 31% |
| 2h | 72 | -55.0 | -18.6 | 24% |
| 4h | 85 | -67.1 | -41.4 | 20% |
| 8h | 72 | -74.7 | -49.4 | 17% |
| 12h | 82 | -77.0 | -50.5 | 18% |

## Simulated trades ($1000/trade, entry +60s, slippage both legs)

| cohort | exit | n | med % | wm % | wr | PnL $ |
|---|---|---|---|---|---|---|
| all/train | TP+100%/SL-30%/15m | 83 | -32.1 | -5.6 | 22% | -4632 |
| all/train | TP+100%/SL-15%/15m | 83 | -17.5 | -5.7 | 11% | -4738 |
| all/train | TP+100%/SL-15%/30m | 85 | -17.5 | -5.9 | 13% | -5032 |
| all/valid | TP+100%/SL-15%/15m | 107 | -17.5 | 5.4 | 22% | 5103 |
| all/valid | TP+100%/SL-15%/30m | 111 | -17.5 | 3.9 | 22% | 4067 |
| all/valid | TP+100%/SL-15%/2h | 111 | -17.5 | 3.7 | 21% | 3846 |
| elite/valid | TP+20%/SL-15%/5m | 0 | — | — | — | 0 |
| elite/valid | TP+20%/SL-15%/15m | 0 | — | — | — | 0 |
| elite/valid | TP+20%/SL-15%/30m | 0 | — | — | — | 0 |

_Top-3 exits per cohort by total PnL. Anything positive on all/train must reappear on all/valid (and ideally sharpen on elite/valid) to count as signal rather than fit._
