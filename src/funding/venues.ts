import { ASSETS, type Asset, type FundingSnapshot } from "./carry-engine.js";

const BINANCE_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";
const BYBIT_URL = "https://api.bybit.com/v5/market/tickers";
const HYPERLIQUID_URL = "https://api.hyperliquid.xyz/info";
const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchAllFundingSnapshots(ts = Date.now()): Promise<FundingSnapshot[]> {
  const [binance, bybit, hyperliquid] = await Promise.all([
    Promise.all(ASSETS.map((asset) => fetchBinanceFunding(asset, ts))),
    Promise.all(ASSETS.map((asset) => fetchBybitFunding(asset, ts))),
    fetchHyperliquidFunding(ts)
  ]);
  return [...binance, ...bybit, ...hyperliquid];
}

export async function fetchBinanceFunding(asset: Asset, ts = Date.now()): Promise<FundingSnapshot> {
  const response = await fetch(`${BINANCE_URL}?symbol=${asset}USDT`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Binance ${asset} funding request failed: HTTP ${response.status}`);
  return parseBinancePayload(asset, await response.json(), ts);
}

export async function fetchBybitFunding(asset: Asset, ts = Date.now()): Promise<FundingSnapshot> {
  const response = await fetch(`${BYBIT_URL}?category=linear&symbol=${asset}USDT`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Bybit ${asset} funding request failed: HTTP ${response.status}`);
  return parseBybitPayload(asset, await response.json(), ts);
}

export async function fetchHyperliquidFunding(ts = Date.now()): Promise<FundingSnapshot[]> {
  const response = await fetch(HYPERLIQUID_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Hyperliquid funding request failed: HTTP ${response.status}`);
  return parseHyperliquidPayload(await response.json(), ts);
}

export function parseBinancePayload(asset: Asset, payload: unknown, ts: number): FundingSnapshot {
  const row = objectValue(payload, `Binance ${asset} payload`);
  const rateRaw = finiteNumber(row.lastFundingRate, `Binance ${asset} lastFundingRate`);
  return {
    ts,
    asset,
    venue: "binance",
    rateRaw,
    rateAnnualized: annualizedPercent(rateRaw, 3),
    markPrice: positiveNumber(row.markPrice, `Binance ${asset} markPrice`)
  };
}

export function parseBybitPayload(asset: Asset, payload: unknown, ts: number): FundingSnapshot {
  const root = objectValue(payload, `Bybit ${asset} payload`);
  if (root.retCode !== 0) throw new Error(`Bybit ${asset} API error: ${String(root.retMsg ?? root.retCode)}`);
  const result = objectValue(root.result, `Bybit ${asset} result`);
  if (!Array.isArray(result.list) || result.list.length === 0) {
    throw new Error(`Bybit ${asset} payload contains no ticker`);
  }
  const row = objectValue(result.list[0], `Bybit ${asset} ticker`);
  const rateRaw = finiteNumber(row.fundingRate, `Bybit ${asset} fundingRate`);
  return {
    ts,
    asset,
    venue: "bybit",
    rateRaw,
    rateAnnualized: annualizedPercent(rateRaw, 3),
    markPrice: positiveNumber(row.markPrice, `Bybit ${asset} markPrice`)
  };
}

export function parseHyperliquidPayload(payload: unknown, ts: number): FundingSnapshot[] {
  if (!Array.isArray(payload) || payload.length < 2 || !Array.isArray(payload[1])) {
    throw new Error("Hyperliquid payload has an invalid metaAndAssetCtxs shape");
  }
  const meta = objectValue(payload[0], "Hyperliquid metadata");
  const universe = meta.universe;
  if (!Array.isArray(universe)) throw new Error("Hyperliquid metadata contains no universe");

  return ASSETS.map((asset) => {
    const index = universe.findIndex((item) => objectValue(item, "Hyperliquid universe item").name === asset);
    if (index < 0) throw new Error(`Hyperliquid universe contains no ${asset}`);
    const context = objectValue(payload[1][index], `Hyperliquid ${asset} context`);
    const rateRaw = finiteNumber(context.funding, `Hyperliquid ${asset} funding`);
    return {
      ts,
      asset,
      venue: "hyperliquid" as const,
      rateRaw,
      rateAnnualized: annualizedPercent(rateRaw, 24),
      markPrice: positiveNumber(context.markPx, `Hyperliquid ${asset} markPx`)
    };
  });
}

function annualizedPercent(rateRaw: number, periodsPerDay: number): number {
  return Number((rateRaw * periodsPerDay * 365 * 100).toFixed(12));
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a finite number`);
  return parsed;
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}
