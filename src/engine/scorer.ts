import type { TradeRow } from "../storage/models/trades.js";
import type { HeliusTransaction } from "../blockchain/helius-client.js";
import type { WalletState } from "../blockchain/types.js";
import type { ManipulationSignals } from "./manipulation-detector.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1e9;

export interface WalletMetrics {
  score: number;
  winRate: number | null;
  avgRoi: number | null;
  totalTrades: number;
  realizedPnlSol: number;
  state: WalletState;
}

interface TokenPosition {
  mint: string;
  buyCostSol: number;
  buyAmount: number;
  sellRevenueSol: number;
  sellAmount: number;
  closed: boolean;
}

export function computeWalletMetrics(
  trades: TradeRow[],
  heliusTxs: HeliusTransaction[],
  walletAddress: string,
  currentState: WalletState
): WalletMetrics {
  const positions = buildPositions(trades, heliusTxs, walletAddress);
  const closed = positions.filter((p) => p.closed || p.sellAmount > 0);
  const swapCount = heliusTxs.filter((tx) => tx.type === "SWAP").length;
  const totalTrades = Math.max(trades.length, swapCount);

  if (closed.length === 0) {
    const activityScore = swapCount > 5 ? 45 : swapCount > 0 ? 38 : heliusTxs.length > 0 ? 28 : 15;
    return { score: activityScore, winRate: null, avgRoi: null, totalTrades, realizedPnlSol: 0, state: deriveState(activityScore, currentState) };
  }

  let wins = 0;
  let totalRoi = 0;
  let totalPnl = 0;

  for (const pos of closed) {
    const pnl = pos.sellRevenueSol - pos.buyCostSol;
    totalPnl += pnl;
    const roi = pos.buyCostSol > 0 ? pnl / pos.buyCostSol : 0;
    totalRoi += roi;
    if (pnl > 0) wins++;
  }

  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const avgRoi = closed.length > 0 ? (totalRoi / closed.length) * 100 : 0;

  const pnlScore = clamp(normalize(totalPnl, -10, 100), 0, 100) * 0.35;
  const wrScore = clamp(winRate, 0, 100) * 0.25;
  const roiScore = clamp(normalize(avgRoi, -20, 200), 0, 100) * 0.2;
  const recencyScore = computeRecency(trades, heliusTxs) * 0.1;
  const volumeScore = clamp(normalize(closed.length, 0, 20), 0, 100) * 0.1;

  const score = clamp(Math.round(pnlScore + wrScore + roiScore + recencyScore + volumeScore), 0, 100);
  const state = deriveState(score, currentState);

  return { score, winRate: round2(winRate), avgRoi: round2(avgRoi), totalTrades, realizedPnlSol: round2(totalPnl), state };
}

function buildPositions(trades: TradeRow[], heliusTxs: HeliusTransaction[], walletAddress: string): TokenPosition[] {
  const posMap = new Map<string, TokenPosition>();

  const getPos = (mint: string): TokenPosition => {
    let pos = posMap.get(mint);
    if (!pos) { pos = { mint, buyCostSol: 0, buyAmount: 0, sellRevenueSol: 0, sellAmount: 0, closed: false }; posMap.set(mint, pos); }
    return pos;
  };

  for (const trade of trades) {
    if (trade.token_mint === SOL_MINT) continue;
    const pos = getPos(trade.token_mint);
    const sol = Math.abs(trade.amount_sol ?? 0);
    const tokens = Math.abs(trade.amount_token ?? 0);
    if (trade.trade_type === "BUY") {
      pos.buyCostSol += sol;
      pos.buyAmount += tokens;
    } else {
      pos.sellRevenueSol += sol;
      pos.sellAmount += tokens;
      if (pos.sellAmount >= pos.buyAmount * 0.95) pos.closed = true;
    }
  }

  for (const tx of heliusTxs) {
    if (tx.type !== "SWAP") continue;
    const solTransfer = tx.nativeTransfers?.find(
      (t) => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress
    );
    const tokenTransfer = tx.tokenTransfers?.find(
      (t) => t.mint !== SOL_MINT && (t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress)
    );
    if (!tokenTransfer) continue;

    const mint = tokenTransfer.mint;
    const pos = getPos(mint);
    const solAmount = solTransfer ? Math.abs(solTransfer.amount) / LAMPORTS : 0;
    const tokenAmount = Math.abs(tokenTransfer.tokenAmount);
    const isBuy = tokenTransfer.toUserAccount === walletAddress;

    if (isBuy) {
      pos.buyCostSol += solAmount;
      pos.buyAmount += tokenAmount;
    } else {
      pos.sellRevenueSol += solAmount;
      pos.sellAmount += tokenAmount;
      if (pos.sellAmount >= pos.buyAmount * 0.95) pos.closed = true;
    }
  }

  return [...posMap.values()];
}

function computeRecency(trades: TradeRow[], heliusTxs: HeliusTransaction[] = []): number {
  const tradeTimestamps = trades.map((t) => t.block_time);
  const heliusTimestamps = heliusTxs.map((t) => t.timestamp);
  const all = [...tradeTimestamps, ...heliusTimestamps];
  if (all.length === 0) return 0;
  const latest = Math.max(...all);
  const daysSince = (Date.now() / 1000 - latest) / 86400;
  if (daysSince <= 7) return 100;
  if (daysSince <= 14) return 80;
  if (daysSince <= 30) return 60;
  if (daysSince <= 60) return 35;
  if (daysSince <= 90) return 15;
  return 0;
}

function deriveState(score: number, current: WalletState): WalletState {
  if (score >= 50) return "ACTIVE";
  if (score >= 35) return "PROBATION";
  if (score >= 15) return "DORMANT";
  return "DEMOTED";
}

function normalize(value: number, min: number, max: number): number {
  return ((value - min) / (max - min)) * 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeMvpScore(buys: TradeRow[], walletScores: Map<string, number>): number {
  const wallets = [...new Set(buys.map((buy) => buy.wallet_address))];
  const walletCount = wallets.length;
  const avgWalletScore = walletCount > 0
    ? wallets.reduce((sum, wallet) => sum + (walletScores.get(wallet) ?? 0), 0) / walletCount
    : 0;
  const totalUsd = buys.reduce((sum, buy) => sum + (buy.amount_usd ?? 0), 0);
  const volumeScore = clamp(normalize(totalUsd, 1_000, 100_000), 0, 100);
  const first = Math.min(...buys.map((buy) => buy.block_time));
  const last = Math.max(...buys.map((buy) => buy.block_time));
  const velocityScore = velocity(last - first);

  return clamp(Math.round(walletCount * 15 + avgWalletScore * 0.3 + volumeScore + velocityScore), 0, 100);
}

function velocity(spanSeconds: number): number {
  if (spanSeconds <= 30 * 60) return 20;
  if (spanSeconds <= 60 * 60) return 10;
  if (spanSeconds <= 2 * 60 * 60) return 5;
  return 0;
}

export function applyManipulationPenalty(rawScore: number, signals: ManipulationSignals): number {
  let multiplier = 1.0;
  if (signals.timeClusteringScore > 0.7) multiplier *= 0.4;
  else if (signals.timeClusteringScore > 0.4) multiplier *= 0.7;
  if (signals.sellPressureRatio > 0.4) multiplier *= 0.3;
  else if (signals.sellPressureRatio > 0.2) multiplier *= 0.6;
  if (signals.freshWalletFraction > 0.5) multiplier *= 0.3;
  else if (signals.freshWalletFraction > 0.3) multiplier *= 0.6;
  if (signals.coOccurrenceScore > 0.5) multiplier *= 0.3;
  else if (signals.coOccurrenceScore > 0.25) multiplier *= 0.6;
  return Math.max(0, Math.round(rawScore * multiplier));
}
