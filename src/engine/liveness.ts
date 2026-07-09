const DAY_SECONDS = 24 * 60 * 60;

export type CandidateBuy = { signature: string; blockTime: number };

export type LivenessResult = {
  allowed: boolean;
  reason: string | null;
  metrics: {
    buys72h: number;
    buys7d: number;
    buys14d: number;
    projectedClosedTrades28d: number;
  };
};

export async function evaluateFollowerCandidate(input: {
  address: string;
  now?: number;
  minBuys7d?: number;
  minBuys14d?: number;
  minProjectedClosedTrades28d?: number;
  fetchBuys(address: string, sinceBlockTime: number): Promise<CandidateBuy[]>;
}): Promise<LivenessResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const minBuys7d = input.minBuys7d ?? 4;
  const minBuys14d = input.minBuys14d ?? 8;
  const minProjected = input.minProjectedClosedTrades28d ?? 30;
  const buys = await input.fetchBuys(input.address, now - 14 * DAY_SECONDS);
  const buys72h = buys.filter((buy) => buy.blockTime >= now - 3 * DAY_SECONDS).length;
  const buys7d = buys.filter((buy) => buy.blockTime >= now - 7 * DAY_SECONDS).length;
  const buys14d = buys.filter((buy) => buy.blockTime >= now - 14 * DAY_SECONDS).length;
  const previous7d = buys14d - buys7d;
  const projectedClosedTrades28d = buys7d * 4;
  const metrics = { buys72h, buys7d, buys14d, projectedClosedTrades28d };

  if (buys72h === 0) return { allowed: false, reason: "No qualifying BUY in the last 72h", metrics };
  if (buys7d < minBuys7d) return { allowed: false, reason: `BUY cadence too low over 7d (${buys7d} < ${minBuys7d})`, metrics };
  if (buys14d < minBuys14d) return { allowed: false, reason: `BUY cadence too low over 14d (${buys14d} < ${minBuys14d})`, metrics };
  if (projectedClosedTrades28d < minProjected) {
    return { allowed: false, reason: `Projected signal volume below decision gate (${projectedClosedTrades28d} < ${minProjected})`, metrics };
  }
  if (previous7d >= minBuys7d && buys7d < previous7d * 0.35) {
    return { allowed: false, reason: "Brutal recent cadence break detected", metrics };
  }
  return { allowed: true, reason: null, metrics };
}
