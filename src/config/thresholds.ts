import type { AlertTier } from "../blockchain/types.js";

export function getThreshold(_coreWallets: number, _totalWallets?: number): number {
  return 2;
}

export function getMinWalletsForTier(tier: AlertTier): number {
  switch (tier) {
    case "CRITICAL": return 3;
    case "NOTABLE": return 2;
    case "WATCH": return 1;
    default: {
      // Forces a compile error if a new AlertTier variant is added without
      // updating this switch. Runtime fallthrough throws to surface the bug.
      const _exhaustive: never = tier;
      throw new Error(`unhandled AlertTier: ${_exhaustive as string}`);
    }
  }
}
