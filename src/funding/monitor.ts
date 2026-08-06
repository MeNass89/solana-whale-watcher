import { pathToFileURL } from "node:url";
import { ASSETS, evaluateCarryPoll, type PairSpread, type Venue } from "./carry-engine.js";
import { FundingStore } from "./store.js";
import { fetchAllFundingSnapshots } from "./venues.js";

const DEFAULT_POLL_MS = 5 * 60 * 1_000;
const VENUE_LABEL: Record<Venue, string> = {
  hyperliquid: "HL",
  binance: "BIN",
  bybit: "BYB"
};

export async function pollOnce(store: FundingStore): Promise<string> {
  const previousTs = store.getLatestSnapshotTs();
  const snapshots = await fetchAllFundingSnapshots();
  const pollTs = snapshots[0]?.ts;
  if (pollTs === undefined) throw new Error("Funding poll returned no snapshots");

  const decision = evaluateCarryPoll(
    snapshots,
    store.getOpenPositions(),
    store.getConfig(),
    previousTs === undefined ? 0 : Math.max(0, pollTs - previousTs)
  );
  store.applyPoll(snapshots, decision);
  return formatPollLine(pollTs, decision.spreads, store.getOpenPositions().length, store.getCumulativeNetPnl());
}

export function formatPollLine(
  ts: number,
  spreads: readonly PairSpread[],
  openPositions: number,
  cumulativeNetPnl: number
): string {
  const spreadText = ASSETS.map((asset) => {
    const pairs = spreads
      .filter((spread) => spread.asset === asset)
      .map(
        (spread) =>
          `${VENUE_LABEL[spread.venueA]}-${VENUE_LABEL[spread.venueB]}=${signedPercent(spread.spreadAnnualized)}`
      )
      .join(" ");
    return pairs ? `${asset} ${pairs}` : "";
  })
    .filter(Boolean)
    .join(" ");
  return `${new Date(ts).toISOString()} ${spreadText} open=${openPositions} net=$${cumulativeNetPnl.toFixed(2)}`;
}

export async function runMonitor(pollMs = pollIntervalFromEnvironment()): Promise<void> {
  const store = new FundingStore();
  let stopped = false;
  let releaseWait: (() => void) | undefined;
  const stop = (): void => {
    stopped = true;
    releaseWait?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!stopped) {
      try {
        process.stdout.write(`${await pollOnce(store)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${new Date().toISOString()} funding poll failed: ${message}\n`);
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        releaseWait = resolve;
        const timer = setTimeout(resolve, pollMs);
        releaseWait = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      releaseWait = undefined;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    store.close();
  }
}

function pollIntervalFromEnvironment(): number {
  const raw = process.env.FUNDING_POLL_MS;
  if (raw === undefined) return DEFAULT_POLL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`FUNDING_POLL_MS must be a positive integer, received ${raw}`);
  }
  return value;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  await runMonitor();
}
