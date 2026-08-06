export const ASSETS = ["SOL", "BTC", "ETH"] as const;
export const VENUES = ["hyperliquid", "binance", "bybit"] as const;

export type Asset = (typeof ASSETS)[number];
export type Venue = (typeof VENUES)[number];

export interface FundingSnapshot {
  ts: number;
  asset: Asset;
  venue: Venue;
  rateRaw: number;
  rateAnnualized: number;
  markPrice: number;
}

export interface CarryConfig {
  entryThresholdAnnualized: number;
  exitThresholdAnnualized: number;
  notionalUsd: number;
  enabled: boolean;
}

export interface EnginePosition {
  id: number;
  asset: Asset;
  longVenue: Venue;
  shortVenue: Venue;
  entryTs: number;
  entrySpreadAnnualized: number;
  entryThreshold: number;
  notionalUsd: number;
  entryCostUsd: number;
  fundingAccruedUsd: number;
}

export interface PairSpread {
  asset: Asset;
  venueA: Venue;
  venueB: Venue;
  spreadAnnualized: number;
}

export interface CarryEntry {
  asset: Asset;
  longVenue: Venue;
  shortVenue: Venue;
  entryTs: number;
  entrySpreadAnnualized: number;
  entryThreshold: number;
  notionalUsd: number;
  entryCostUsd: number;
  longMarkPrice: number;
  shortMarkPrice: number;
}

export interface CarryAccrual {
  positionId: number;
  amountUsd: number;
}

export interface CarryExit {
  positionId: number;
  exitTs: number;
  exitSpread: number;
  exitReason: "sign_flip" | "hysteresis";
  fundingAccruedUsd: number;
  exitCostUsd: number;
  netPnlUsd: number;
}

export interface CarryDecision {
  spreads: PairSpread[];
  entries: CarryEntry[];
  accruals: CarryAccrual[];
  exits: CarryExit[];
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;
const SLIPPAGE_RATE = 0.0002;
const TAKER_FEE_RATE: Record<Venue, number> = {
  binance: 0.0005,
  bybit: 0.00055,
  hyperliquid: 0.00045
};

export function calculateExecutionCost(venueA: Venue, venueB: Venue, notionalUsd: number): number {
  return Number(
    (notionalUsd * (TAKER_FEE_RATE[venueA] + SLIPPAGE_RATE + TAKER_FEE_RATE[venueB] + SLIPPAGE_RATE)).toFixed(12)
  );
}

export function computePairwiseSpreads(snapshots: readonly FundingSnapshot[]): PairSpread[] {
  const byAssetVenue = snapshotMap(snapshots);
  const spreads: PairSpread[] = [];

  for (const asset of ASSETS) {
    for (let first = 0; first < VENUES.length - 1; first += 1) {
      for (let second = first + 1; second < VENUES.length; second += 1) {
        const venueA = VENUES[first];
        const venueB = VENUES[second];
        const snapshotA = byAssetVenue.get(snapshotKey(asset, venueA));
        const snapshotB = byAssetVenue.get(snapshotKey(asset, venueB));
        if (!snapshotA || !snapshotB) continue;
        spreads.push({
          asset,
          venueA,
          venueB,
          spreadAnnualized: snapshotA.rateAnnualized - snapshotB.rateAnnualized
        });
      }
    }
  }

  return spreads;
}

export function evaluateCarryPoll(
  snapshots: readonly FundingSnapshot[],
  openPositions: readonly EnginePosition[],
  config: CarryConfig,
  elapsedMs: number
): CarryDecision {
  const byAssetVenue = snapshotMap(snapshots);
  const spreads = computePairwiseSpreads(snapshots);
  const accruals: CarryAccrual[] = [];
  const exits: CarryExit[] = [];
  const positionsRemainingOpen = new Set(openPositions.map(positionPairKey));

  for (const position of openPositions) {
    const longSnapshot = byAssetVenue.get(snapshotKey(position.asset, position.longVenue));
    const shortSnapshot = byAssetVenue.get(snapshotKey(position.asset, position.shortVenue));
    if (!longSnapshot || !shortSnapshot) continue;

    const currentSpread = shortSnapshot.rateAnnualized - longSnapshot.rateAnnualized;
    const amountUsd =
      position.notionalUsd * (currentSpread / 100) * (Math.max(0, elapsedMs) / YEAR_MS);
    accruals.push({ positionId: position.id, amountUsd });

    let exitReason: CarryExit["exitReason"] | undefined;
    if (currentSpread < 0) exitReason = "sign_flip";
    else if (Math.abs(currentSpread) < config.exitThresholdAnnualized) exitReason = "hysteresis";

    if (exitReason) {
      const fundingAccruedUsd = position.fundingAccruedUsd + amountUsd;
      const exitCostUsd = calculateExecutionCost(position.longVenue, position.shortVenue, position.notionalUsd);
      exits.push({
        positionId: position.id,
        exitTs: Math.max(longSnapshot.ts, shortSnapshot.ts),
        exitSpread: currentSpread,
        exitReason,
        fundingAccruedUsd,
        exitCostUsd,
        netPnlUsd: fundingAccruedUsd - position.entryCostUsd - exitCostUsd
      });
      positionsRemainingOpen.delete(positionPairKey(position));
    }
  }

  const entries: CarryEntry[] = [];
  if (config.enabled) {
    for (const spread of spreads) {
      const pairKey = unorderedPairKey(spread.asset, spread.venueA, spread.venueB);
      if (positionsRemainingOpen.has(pairKey) || Math.abs(spread.spreadAnnualized) <= config.entryThresholdAnnualized) {
        continue;
      }

      const snapshotA = byAssetVenue.get(snapshotKey(spread.asset, spread.venueA))!;
      const snapshotB = byAssetVenue.get(snapshotKey(spread.asset, spread.venueB))!;
      const shortSnapshot = spread.spreadAnnualized > 0 ? snapshotA : snapshotB;
      const longSnapshot = spread.spreadAnnualized > 0 ? snapshotB : snapshotA;
      // The requested position schema has no leg-price columns. The two marks remain
      // in the immutable poll snapshots; equal USD notionals imply quantity = notional / mark.
      // Net P&L intentionally stays funding-minus-costs, matching the audit methodology.
      entries.push({
        asset: spread.asset,
        longVenue: longSnapshot.venue,
        shortVenue: shortSnapshot.venue,
        entryTs: Math.max(longSnapshot.ts, shortSnapshot.ts),
        entrySpreadAnnualized: Math.abs(spread.spreadAnnualized),
        entryThreshold: config.entryThresholdAnnualized,
        notionalUsd: config.notionalUsd,
        entryCostUsd: calculateExecutionCost(longSnapshot.venue, shortSnapshot.venue, config.notionalUsd),
        longMarkPrice: longSnapshot.markPrice,
        shortMarkPrice: shortSnapshot.markPrice
      });
      positionsRemainingOpen.add(pairKey);
    }
  }

  return { spreads, entries, accruals, exits };
}

function snapshotMap(snapshots: readonly FundingSnapshot[]): Map<string, FundingSnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshotKey(snapshot.asset, snapshot.venue), snapshot]));
}

function snapshotKey(asset: Asset, venue: Venue): string {
  return `${asset}:${venue}`;
}

function positionPairKey(position: Pick<EnginePosition, "asset" | "longVenue" | "shortVenue">): string {
  return unorderedPairKey(position.asset, position.longVenue, position.shortVenue);
}

function unorderedPairKey(asset: Asset, venueA: Venue, venueB: Venue): string {
  return `${asset}:${[venueA, venueB].sort().join(":")}`;
}
