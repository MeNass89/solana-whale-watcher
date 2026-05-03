export function getThreshold(totalWallets: number): number {
  return Math.max(2, Math.floor(Math.log2(Math.max(1, totalWallets)) + 1));
}
