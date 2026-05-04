export function getThreshold(coreWallets: number, _totalWallets?: number): number {
  return Math.max(2, Math.floor(Math.log2(Math.max(1, coreWallets)) + 1));
}
