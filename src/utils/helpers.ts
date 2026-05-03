export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export function formatUsd(value?: number | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "unknown";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2
  }).format(value);
}

export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}
