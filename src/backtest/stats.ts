/** Small stats helpers — memecoin returns are heavy-tailed, raw means lie. */

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Winsorized mean: clamps values below the p-th / above the (1−p)-th quantile. */
export function winsorizedMean(xs: number[], p = 0.01): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const lo = quantileSorted(sorted, p);
  const hi = quantileSorted(sorted, 1 - p);
  return mean(sorted.map((x) => Math.min(hi, Math.max(lo, x))));
}

export function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

export function winRate(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.filter((x) => x > 0).length / xs.length;
}

/** Max drawdown of a cumulative-PnL curve built from per-trade PnLs in order. */
export function maxDrawdown(pnls: number[]): number {
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}
