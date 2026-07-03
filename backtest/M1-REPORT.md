# m=1 study — first whale buy per token

Signal = first tracked-wallet BUY per token, anchored at the buy's block_time (detectable in seconds via webhook). Universe: 8684 tokens; deterministic sample: 2000; with candles: 1778; with baseline+returns: 1567. Walk-forward split at 2026-05-15 (train 602 / valid 965).

## Horizon curves (candle returns, no execution costs)

### All signals (n=1567)

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 1235 | -2.4 | -5.6 | 30% |
| 2m | 1176 | -4.6 | -7.0 | 31% |
| 5m | 1119 | -10.1 | -13.0 | 28% |
| 10m | 1006 | -19.7 | -19.4 | 24% |
| 15m | 900 | -20.7 | -19.0 | 24% |
| 30m | 834 | -27.6 | -22.0 | 26% |
| 1h | 796 | -27.9 | -24.3 | 25% |
| 2h | 545 | -32.1 | -25.2 | 24% |
| 4h | 824 | -34.2 | -31.8 | 22% |
| 8h | 707 | -38.8 | -34.0 | 21% |
| 12h | 741 | -40.0 | -35.9 | 20% |

### Pump tokens

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 1031 | -2.4 | -5.9 | 30% |
| 2m | 978 | -4.9 | -7.5 | 31% |
| 5m | 936 | -11.0 | -14.1 | 27% |
| 10m | 850 | -20.7 | -20.5 | 23% |
| 15m | 771 | -21.4 | -20.7 | 23% |
| 30m | 712 | -28.8 | -24.4 | 25% |
| 1h | 684 | -29.5 | -24.6 | 25% |
| 2h | 468 | -33.9 | -24.7 | 24% |
| 4h | 711 | -36.2 | -31.3 | 21% |
| 8h | 609 | -40.7 | -35.0 | 21% |
| 12h | 642 | -41.9 | -36.6 | 19% |

### Non-pump tokens

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 204 | -2.3 | -3.8 | 31% |
| 2m | 198 | -3.3 | -3.3 | 31% |
| 5m | 183 | -8.1 | -8.2 | 31% |
| 10m | 156 | -13.2 | -14.6 | 26% |
| 15m | 129 | -13.1 | -11.2 | 30% |
| 30m | 122 | -15.9 | 22143.3 | 34% |
| 1h | 112 | -23.5 | -22.1 | 28% |
| 2h | 77 | -25.1 | -27.3 | 27% |
| 4h | 113 | -24.2 | -29.5 | 27% |
| 8h | 98 | -25.7 | -26.9 | 24% |
| 12h | 99 | -34.9 | -31.0 | 24% |

_No buy-size bucket: amount_usd is NULL on ~87% of first buys (webhook enrichment gap), so USD-size filters are not measurable on this data._

## Walk-forward wallet selection

Wallets ranked on TRAIN half only (median 15m return, ≥5 signals): 12 rankable, top quartile = 3 elite wallets. Their VALID-half signals vs the rest:

### Elite wallets, valid half (n=2)

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 1 | 0.2 | 0.2 | 100% |
| 2m | 1 | -0.7 | -0.7 | 0% |
| 5m | 1 | -1.2 | -1.2 | 0% |
| 10m | 1 | -6.6 | -6.6 | 0% |
| 15m | 1 | 4.0 | 4.0 | 100% |
| 30m | 1 | 2.0 | 2.0 | 100% |
| 1h | 1 | 20.7 | 20.7 | 100% |
| 2h | 1 | 7.0 | 7.0 | 100% |
| 4h | 2 | 5.3 | 5.3 | 100% |
| 8h | 1 | -51.6 | -51.6 | 0% |
| 12h | 2 | 0.0 | 0.0 | 50% |

### Non-elite wallets, valid half (n=963)

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 865 | -3.5 | -5.7 | 29% |
| 2m | 816 | -7.6 | -7.6 | 29% |
| 5m | 760 | -16.6 | -14.5 | 25% |
| 10m | 666 | -29.5 | -22.4 | 19% |
| 15m | 593 | -32.9 | -23.0 | 20% |
| 30m | 533 | -41.6 | -27.6 | 21% |
| 1h | 480 | -43.7 | -28.8 | 21% |
| 2h | 319 | -51.8 | -31.1 | 19% |
| 4h | 449 | -60.6 | -41.2 | 14% |
| 8h | 374 | -67.0 | -47.3 | 13% |
| 12h | 395 | -67.2 | -46.3 | 14% |

## Walk-forward wallet selection — realized SOL flow

Wallets ranked on TRAIN-half realized flow across ALL their trades (sum SELL sol / sum BUY sol, ≥20 SOL bought): 37 rankable, top quartile = 9 elite. Top-5 train ratios: 2h7s…(1.54), Hwz4…(1.05), Hq3G…(0.94), DNfu…(0.89), BfLg…(0.76). Their VALID-half m=1 signals vs the rest:

### Realized-elite wallets, valid half (n=2)

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 2 | 9.1 | 9.1 | 100% |
| 2m | 2 | 11.5 | 11.5 | 50% |
| 5m | 2 | 15.5 | 15.5 | 50% |
| 10m | 2 | 35.6 | 35.6 | 50% |
| 15m | 2 | 25.3 | 25.3 | 50% |
| 30m | 2 | 18.5 | 18.5 | 50% |
| 1h | 2 | 18.3 | 18.3 | 50% |
| 2h | 2 | 47.2 | 47.2 | 50% |
| 4h | 2 | 124.2 | 124.2 | 100% |
| 8h | 2 | 39.2 | 39.2 | 100% |
| 12h | 2 | 61.4 | 61.4 | 100% |

### Realized-non-elite wallets, valid half (n=963)

| horizon | n | med % | wm % | wr |
|---|---|---|---|---|
| 1m | 864 | -3.6 | -5.7 | 29% |
| 2m | 815 | -7.6 | -7.7 | 29% |
| 5m | 759 | -16.6 | -14.5 | 25% |
| 10m | 665 | -29.8 | -22.6 | 19% |
| 15m | 592 | -33.1 | -23.1 | 20% |
| 30m | 532 | -41.6 | -27.7 | 21% |
| 1h | 479 | -43.8 | -28.9 | 21% |
| 2h | 318 | -52.1 | -31.5 | 19% |
| 4h | 449 | -60.6 | -41.7 | 14% |
| 8h | 373 | -67.3 | -47.7 | 13% |
| 12h | 395 | -67.2 | -46.6 | 13% |

## Simulated trades ($1000/trade, entry +60s, slippage both legs)

| cohort | exit | n | med % | wm % | wr | PnL $ |
|---|---|---|---|---|---|---|
| all/train | TP+100%/SL-15%/5m | 424 | -8.7 | -6.4 | 12% | -27119 |
| all/train | TP+100%/SL-15%/1h | 532 | -10.3 | -5.1 | 12% | -27604 |
| all/train | TP+100%/SL-15%/30m | 513 | -9.2 | -5.3 | 12% | -27829 |
| all/valid | TP+100%/SL-15%/2h | 921 | -17.5 | -4.5 | 11% | -42780 |
| all/valid | TP+100%/SL-15%/30m | 915 | -17.5 | -4.6 | 11% | -43581 |
| all/valid | TP+100%/SL-15%/15m | 899 | -17.5 | -4.8 | 11% | -43971 |
| elite/valid | TP+20%/SL-15%/1h | 1 | 12.3 | 12.3 | 100% | 123 |
| elite/valid | TP+20%/SL-30%/1h | 1 | 12.3 | 12.3 | 100% | 123 |
| elite/valid | TP+50%/SL-15%/1h | 1 | 12.3 | 12.3 | 100% | 123 |
| realized-elite/valid | TP+100%/SL-15%/2h | 2 | 38.2 | 38.2 | 50% | 764 |
| realized-elite/valid | TP+100%/SL-30%/2h | 2 | 30.9 | 30.9 | 50% | 619 |
| realized-elite/valid | TP+50%/SL-30%/30m | 2 | 16.9 | 16.9 | 50% | 339 |

_Top-3 exits per cohort by total PnL. Anything positive on all/train must reappear on all/valid (and ideally sharpen on elite/valid) to count as signal rather than fit._
