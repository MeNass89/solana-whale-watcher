# Convergence-data long-strategy audit — 2026-08-05

## Verdict

**(c) Nothing survives honest statistics. Do not deploy a long strategy from this dataset.**

The headline NOTABLE / exactly 2 wallets / pump.fun result is not an edge. At 24h its observed-exit mean is +4.8%, but its conservative expectancy is **-$10.56 per $100** before costs and **-$12.35 after a 2% proceeds haircut**. At 7d it is **-$28.31 after costs**. Its only positive base horizon, 1h (+$3.45 net), changes from **+$11.65 in H1 to -$5.99 in H2** and becomes -$18.47 when only the first signal per token is traded.

The database contains profitable arithmetic, not a validated strategy: one malformed price, extreme right-tail returns, repeated alerts on the same tokens, and a short May regime create the apparent gains.

## Snapshot and definitions

- SQLite opened with `mode=ro`, `immutable=1`, and `PRAGMA query_only=ON`. SHA-256 before/after the final analysis pass was identical: `7777e61596e266d2f4779e9c9f964255316021cfaa49e4bcf0e8731512b257f1`.
- 18,517 rows total; 18,509 resolved: `DEAD` 9,691, `LOSS` 5,816, `FLAT` 1,545, `WIN` 1,457. The other 8 have NULL outcome; there is no `PENDING` row.
- `detected_at` does not exist. I used `last_trade_at`, the Nth trade and first instant the convergence is knowable. The median split is **2026-05-13 16:34:48 UTC**.
- Valid entry price is required to model a purchase: 17,625 resolved rows qualify; 884 cannot be priced and are excluded. A missing exit with valid entry is **-100%** in conservative returns.
- `is_pump = token_mint.endswith("pump")`. A “2% haircut” means realized exit proceeds ×0.98; a NULL exit remains a total loss.
- Raw quantiles and raw win rates use only valid entries with observed exits. Conservative quantiles, win rates, and EV include valid entries with NULL exits set to -100%.

## Fatal data limitations

1. **Non-independent rows.** The 18,517 rows represent only **1,441 tokens**. Eligible buckets average roughly 8–11 rows per mint; one token appears 1,456 times. Equal-weighting rows secretly overweights alert storms.
2. **Entry-time leakage.** The convergence is tradable at `last_trade_at`, yet the candle backfill resolver anchors `price_at_detection` at `first_trade_at`. The gap averages **3,494 s (58.2 min)** and reaches **7,197 s (120.0 min)**. Stored returns can therefore credit the strategy with price movement before the Nth-wallet signal existed.
3. **One corrupt 24h price.** Row 4748 (`RCSC`, outcome `DEAD`) moves from $0.0000590655 to $134.1202: **+227,070,065%**. It creates essentially all of the NOTABLE/2/non-pump 24h profit. Removing that row changes conservative EV from +171,586% to **-46.85%**.
4. **The temporal split leaks tokens.** 47.6% of resolved rows fall on 13 May. `WORLDCUP` (1,456 rows) and `RKC` (670 rows) straddle the cutoff, so H1/H2 are not independent regimes. Token-level checks are therefore mandatory.

## 1. Distribution honesty check

The compact `q` field is `p10 / p25 / median / p75 / p90`, in percent. `NULL` counts all resolved rows in the bucket, including rows with invalid entry; `raw n` is the actual raw-return denominator.

### 1h returns

| bucket | resolved / valid entry / unique mint | NULL / raw n | raw q (%) | raw win | conservative q (%) | cons win | cons EV |
|---|---:|---:|---|---:|---|---:|---:|
| CRITICAL / 3 / non-pump | 360 / 342 / 45 | 51 / 309 | -34.7 / 0 / 0 / 0 / 32.9 | 14.9% | -93.2 / -16.7 / 0 / 0 / 7.2 | 13.5% | -9.0% |
| CRITICAL / 3 / pump | 2,957 / 2,842 / 285 | 589 / 2,360 | -56.6 / 0 / 0 / 0 / 17.9 | 15.3% | -100 / -58.6 / 0 / 0 / 16.0 | 12.7% | -12.5% |
| CRITICAL / 4 / pump | 927 / 871 / 97 | 213 / 714 | -39.1 / 0 / 0 / 0 / 0 | 8.0% | -100 / -63.9 / 0 / 0 / 0 | 6.5% | -15.2% |
| CRITICAL / 5 / pump | 393 / 383 / 35 | 71 / 322 | 0 / 0 / 0 / 0 / 210.8 | 16.5% | -100 / 0 / 0 / 0 / 210.8 | 13.8% | +10.9% |
| NOTABLE / 2 / non-pump | 1,376 / 1,323 / 175 | 342 / 1,034 | -61.4 / -2.9 / 0 / 0 / 6.9 | 11.0% | -100 / -87.2 / 0 / 0 / 0 | 8.6% | -18.1% |
| NOTABLE / 2 / pump | 11,920 / 11,328 / 1,230 | 1,741 / 10,165 | -61.0 / 0 / 0 / 0 / 26.9 | 12.9% | -100 / -17.6 / 0 / 0 / 14.3 | 11.6% | +5.6% |

### 24h returns

| bucket | resolved / valid entry / unique mint | NULL / raw n | raw q (%) | raw win | conservative q (%) | cons win | cons EV |
|---|---:|---:|---|---:|---|---:|---:|
| CRITICAL / 3 / non-pump | 360 / 342 / 45 | 62 / 298 | -91.8 / -79.6 / -29.5 / 0 / 0.0 | 10.4% | -100 / -91.8 / -41.5 / 0 / 0 | 9.1% | -39.9% |
| CRITICAL / 3 / pump | 2,957 / 2,842 / 285 | 554 / 2,389 | -94.6 / -83.2 / -30.1 / 0 / 0 | 9.0% | -100 / -94.0 / -40.9 / 0 / 0 | 7.5% | -29.2% |
| CRITICAL / 4 / pump | 927 / 871 / 97 | 212 / 715 | -89.1 / -71.1 / -5.0 / 0 / 99.0 | 20.7% | -100 / -89.1 / -39.2 / 0 / 28.7 | 17.0% | -27.4% |
| CRITICAL / 5 / pump | 393 / 383 / 35 | 64 / 329 | -88.5 / -79.9 / -53.7 / 0 / 0 | 3.3% | -100 / -86.8 / -63.6 / -13.8 / 0 | 2.9% | -52.1% |
| NOTABLE / 2 / non-pump | 1,376 / 1,323 / 175 | 346 / 1,029 | -91.4 / -77.9 / -26.2 / 0 / 0 | 4.9% | -100 / -95.3 / -56.7 / -6.0 / 0 | 3.8% | +171,586%* |
| NOTABLE / 2 / pump | 11,920 / 11,328 / 1,230 | 2,222 / 9,669 | -94.2 / -80.4 / -26.7 / 0 / 3.9 | 11.0% | -100 / -93.2 / -40.4 / 0 / 0 | 9.4% | **-10.6%** |

`*` The RCSC corruption. Excluding it: conservative median -56.7%, EV -46.85%.

### 7d returns

| bucket | resolved / valid entry / unique mint | NULL / raw n | raw q (%) | raw win | conservative q (%) | cons win | cons EV |
|---|---:|---:|---|---:|---|---:|---:|
| CRITICAL / 3 / non-pump | 360 / 342 / 45 | 254 / 106 | -94.0 / -82.6 / -70.2 / -48.9 / -11.3 | 2.8% | -100 / -100 / -100 / -91.0 / -65.9 | 0.9% | -88.1% |
| CRITICAL / 3 / pump | 2,957 / 2,842 / 285 | 1,235 / 1,722 | -94.2 / -86.0 / -30.2 / 16.3 / 71.4 | 31.1% | -100 / -100 / -92.5 / -13.4 / 45.5 | 18.8% | -51.1% |
| CRITICAL / 4 / pump | 927 / 871 / 97 | 413 / 514 | -92.6 / -89.1 / -72.4 / -11.6 / 3.7 | 15.8% | -100 / -100 / -90.5 / -52.5 / -0.5 | 9.3% | -63.4% |
| CRITICAL / 5 / pump | 393 / 383 / 35 | 214 / 179 | -93.8 / -91.7 / -61.5 / -35.7 / 5.0 | 12.3% | -100 / -100 / -100 / -67.9 / -30.2 | 5.7% | -76.1% |
| NOTABLE / 2 / non-pump | 1,376 / 1,323 / 175 | 738 / 637 | -94.3 / -92.4 / -82.5 / -60.5 / -2.3 | 6.4% | -100 / -100 / -100 / -82.6 / -23.1 | 3.1% | -68.7% |
| NOTABLE / 2 / pump | 11,920 / 11,328 / 1,230 | 6,537 / 5,357 | -96.1 / -86.9 / -32.1 / 18.9 / 103.0 | 31.5% | -100 / -100 / -100 / -40.6 / 38.8 | 14.9% | **-26.9%** |

The prior +54.7% 7d mean is the mean among surviving price feeds. Once 5,971 NULL exits among valid entries are counted as total losses, the sign reverses to -26.9%.

## 2. Equal-weight $100 portfolio simulations

Signals are ordered by `last_trade_at`; max drawdown is peak-to-trough cumulative P&L. Only the superficially best buckets/horizons are shown.

| strategy | n | gross P&L | EV / $100 | max DD | P&L after 2% | net EV | net max DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| NOTABLE / 2 / pump, 1h | 11,328 | +$63,028 | +$5.56 | $70,156 | +$39,112 | +$3.45 | $72,499 |
| NOTABLE / 2 / pump, 24h | 11,328 | -$119,642 | -$10.56 | $250,434 | -$139,905 | -$12.35 | $259,515 |
| NOTABLE / 2 / pump, 7d | 11,328 | -$304,178 | -$26.85 | $357,574 | -$320,750 | -$28.31 | $364,514 |
| CRITICAL / 5 / pump, 1h | 383 | +$4,156 | +$10.85 | $6,323 | +$3,307 | +$8.64 | $6,339 |
| NOTABLE / 2 / non-pump, 24h | 1,323 | +$227.0m | +$171,586 | $58,157 | +$222.5m | +$168,152 | $59,204 |

The final row is the single corrupt RCSC price. CRITICAL/5/pump 1h fails costs in H1 and has only 35 mints. NOTABLE/2/pump 1h is a row-weighted illusion: trading only the first signal per mint gives **n=1,153, net EV -$18.47, median -$3.73, max DD $21,339**.

## 3. Filter search and temporal validation

Filters were pre-trade-only: exactly 2 vs 3+ wallets, pump vs non-pump, UTC hour, weekday, and token-age proxy. A cell needed at least 100 valid-entry rows in each half. Token age is `last_trade_at - first trade observed for mint in trades`; it is left-censored tracker age, not on-chain age.

### Base strategies by half

| strategy | H1 n / gross EV / net EV / median | H2 n / gross EV / net EV / median |
|---|---|---|
| N2 pump, 1h | 6,065 / +13.93% / +11.65% / 0% | 5,263 / -4.08% / **-5.99%** / -27.99% |
| N2 pump, 24h | 6,065 / +12.12% / +9.87% / -12.98% | 5,263 / -36.70% / **-37.96%** / -85.97% |
| N2 pump, 7d | 6,065 / -1.56% / -3.53% / -100% | 5,263 / -56.00% / -56.88% / -96.39% |
| C5 pump, 1h | 220 / +0.44% / **-1.57%** / 0% | 163 / +24.91% / +22.41% / 0% |

- **UTC hour and weekday:** no cell has positive conservative mean in both halves at 24h or 7d. Nominal 1h survivors fail the 2% cost in H1 or collapse when gains are capped at +100%.
- **Wallet count and pump status:** no unfiltered base bucket remains positive net in both halves.
- **Token age:** the only slow-horizon row-level survivor is NOTABLE/2/pump with observed age 1–7d. It is not a token-level survivor:

| horizon | row H1 n / net EV / median / 1%-winsor mean | row H2 n / net EV / median / 1%-winsor mean | first signal per token, +100% cap H1 / H2 |
|---|---|---|---|
| 24h | 999 / +90.62% / -2.52% / -11.95% | 539 / +11.54% / -5.54% / +5.46% | **-5.91% / -22.33%** |
| 7d | 999 / +165.67% / -0.71% / +5.21% | 539 / +75.70% / +43.25% / +55.04% | **-16.74% / -43.49%** |

Those 1,538 rows are only **27 H1 and 62 H2 tokens**. The first-signal token medians at 7d are -16.78% and -63.14%. WORLDCUP and RKC appear in both halves, so the apparent row-level replication is the same winners voting hundreds of times.

### Calendar decay: NOTABLE / 2 / pump, conservative 24h

| month | valid-entry n | conservative mean | conservative median | win rate |
|---|---:|---:|---:|---:|
| 2026-05 | 7,815 | +6.37% | -20.89% | 7.38% |
| 2026-06 | 2,969 | -42.61% | -88.51% | 15.26% |
| 2026-07 | 544 | -78.93% | -100.00% | 6.99% |

Monthly median loss plot (one block ≈ 5 percentage points):

```text
May  -20.9%  ████
Jun  -88.5%  ██████████████████
Jul -100.0%  ████████████████████
```

The 30-day half-life recency-weighted conservative mean is **-20.90%**, or roughly **-22.90% after costs**. The edge did not merely weaken; it disappeared.

## 4. Fade check

If every CRITICAL signal could be shorted at the stored entry and a missing 24h price meant the token went to zero, 4,938 hypothetical $100 shorts produce **+$173,991**, +$35.24 expectancy, +$49.39 median, 70.3% wins, and $34,960 max drawdown; after a 2-point shorting cost, expectancy is +$33.24. The worst single short loses **$3,285 on $100**. There is no credible borrow, liquidity, or bounded-loss execution on these microcaps, so this is descriptive only—not an implementable strategy.

## 5. Wallet-level angle

Method: exact `convergence_trades` membership; require a BUY; deduplicate to the first convergence per wallet-token; compute conservative 24h convergence return; require at least 20 distinct tokens. This avoids counting thousands of repeated alerts as independent wallet calls.

| rank | wallet | tokens | median 24h | mean 24h | win rate |
|---:|---|---:|---:|---:|---:|
| 1 | `35dszeQQQzkMvjcmyrPWPnN5ZyK9ZjYkNp9kKXZWMvji` | 237 | 0.00% | +958,090%* | 10.5% |
| 2 | `54Pz1e35z9uoFdnxtzjp7xZQoFiofqhdayQWBMN7dsuy` | 319 | 0.00% | +711,805%* | 9.1% |
| 3 | `suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK` | 165 | -4.10% | -27.32% | 6.1% |
| 4 | `99i9uVA7Q56bY22ajKKUfTZTgTeP5yCtVGsrG9J4pDYQ` | 51 | -4.35% | -7.12% | 7.8% |
| 5 | `9oKgawE4czK9B7AowqkKe2mBek8xFM4QiAge4YFCbuT5` | 20 | -28.09% | -40.34% | 25.0% |
| 6 | `4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh` | 27 | -34.81% | -14.09% | 3.7% |
| 7 | `9FNz4MjPUmnJqTf6yEDbL1D4SsHVh7uA8zRHhR5K138r` | 45 | -59.75% | -34.30% | 6.7% |
| 8 | `73LnJ7G9ffBDjEBGgJDdgvLUhD5APLonKrNiHsKDCw5B` | 84 | -74.18% | -56.18% | 2.4% |
| 9 | `4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk` | 59 | -77.33% | -49.76% | 6.8% |
| 10 | `86AEJExyjeNNgcp7GrAvCXTDicf5aGWgoERbXFiG1EdD` | 203 | -78.10% | -53.20% | 7.4% |

`*` Both astronomical means inherit the same RCSC corrupt price; neither wallet has a positive median. No wallet with ≥20 distinct tokens has positive median 24h return.

## Final decision

**No long strategy is supported.** The exact prior candidate—NOTABLE, exactly 2 wallets, pump.fun, 24h—loses **$12.35 per $100 after costs**, with +$9.87 in H1 and **-$37.96 in H2**. At 7d it loses $28.31 per $100. The only row-level filtered survivor is destroyed by token-level weighting and reasonable outlier caps. A false positive here would be financed by a malformed candle and a handful of repeated May winners; that is not alpha.
