import type { AlertTier } from "../blockchain/types.js";

export function getThreshold(coreWallets: number, _totalWallets?: number): number {
  return Math.max(2, Math.floor(Math.log2(Math.max(1, coreWallets)) + 1));
}

export function getMinWalletsForTier(tier: AlertTier): number {
  switch (tier) {
    case "CRITICAL": return 3;
    case "NOTABLE": return 2;
    case "WATCH": return 1;
    default: return 2;
  }
}
