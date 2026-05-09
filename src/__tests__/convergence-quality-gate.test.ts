import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { TokenResolver } from "../blockchain/token-resolver.js";
import type { ITradeEvent } from "../blockchain/types.js";
import { ConvergenceEngine } from "../engine/convergence.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import { ConvergenceModel } from "../storage/models/convergences.js";
import { TokenModel } from "../storage/models/tokens.js";
import { TradeModel } from "../storage/models/trades.js";
import { WalletModel } from "../storage/models/wallets.js";

const databases: AppDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("convergence wallet quality gate", () => {
  it("returns null when all triggers are losers", async () => {
    const ctx = setup();
    insertWallet(ctx.db, "loser-1", { walletClass: "loser", realizedSol: -10, nClosed: 4 });
    insertWallet(ctx.db, "loser-2", { walletClass: "loser", realizedSol: -20, nClosed: 6 });
    insertBuy(ctx.trades, "loser-1", "token-losers", 1);
    const newTrade = insertBuy(ctx.trades, "loser-2", "token-losers", 2);

    const convergence = await ctx.engine.checkConvergence(newTrade);

    expect(convergence).toBeNull();
  });

  it("boosts WATCH to NOTABLE when one trigger is a top alpha", async () => {
    const ctx = setup();
    insertWallet(ctx.db, "alpha-1", { walletClass: "alpha", realizedSol: 200, nClosed: 10 });
    insertWallet(ctx.db, "neutral-1", { walletClass: "unknown", realizedSol: 0, nClosed: 0 });
    insertBuy(ctx.trades, "alpha-1", "token-alpha", 1);
    const newTrade = insertBuy(ctx.trades, "neutral-1", "token-alpha", 2);

    const convergence = await ctx.engine.checkConvergence(newTrade);

    expect(convergence?.tier).toBe("NOTABLE");
  });

  it("boosts mixed alpha, incomplete, and unknown triggers without rejection", async () => {
    const ctx = setup();
    insertWallet(ctx.db, "alpha-1", { walletClass: "alpha", realizedSol: 200, nClosed: 10 });
    insertWallet(ctx.db, "incomplete-1", { walletClass: "incomplete", realizedSol: 0, nClosed: 0 });
    insertWallet(ctx.db, "unknown-1", { walletClass: "unknown", realizedSol: 0, nClosed: 0 });
    insertBuy(ctx.trades, "alpha-1", "token-mixed", 1);
    insertBuy(ctx.trades, "incomplete-1", "token-mixed", 2);
    const newTrade = insertBuy(ctx.trades, "unknown-1", "token-mixed", 3);

    const convergence = await ctx.engine.checkConvergence(newTrade);

    expect(convergence).not.toBeNull();
    expect(convergence?.tier).toBe("CRITICAL");
  });
});

function setup(): {
  db: AppDatabase;
  trades: TradeModel;
  engine: ConvergenceEngine;
} {
  const db = new Database(":memory:") as AppDatabase;
  databases.push(db);
  runMigrations(db);
  const trades = new TradeModel(db);
  const wallets = new WalletModel(db);
  const convergences = new ConvergenceModel(db);
  const tokens = new TokenModel(db);
  const resolver = { resolve: async (mint: string) => ({ mint }) } as TokenResolver;
  return {
    db,
    trades,
    engine: new ConvergenceEngine(trades, convergences, wallets, tokens, resolver, db)
  };
}

function insertWallet(
  db: AppDatabase,
  address: string,
  input: { walletClass: string; realizedSol: number; nClosed: number }
): void {
  // Mature wallet defaults so the manipulation-penalty (fresh-wallet) signal
  // doesn't artificially crush scores in tier-boost tests; freshness is
  // exercised in dedicated manipulation-detector tests.
  const matureAddedAt = Math.floor(Date.now() / 1000) - 30 * 86400;
  db.prepare(
    `INSERT INTO wallets (address, score, state, active, realized_sol_30d, n_closed_30d, wallet_class, added_at, total_trades)
     VALUES (?, 0, 'ACTIVE', 1, ?, ?, ?, ?, 50)`
  ).run(address, input.realizedSol, input.nClosed, input.walletClass, matureAddedAt);
  const insertHistoricalTrade = db.prepare(
    `INSERT INTO trades (wallet_address, token_mint, tx_signature, amount_token, amount_sol, amount_usd, trade_type, block_time)
     VALUES (?, ?, ?, 1, 1, 1, 'BUY', ?)`
  );
  for (let i = 0; i < 15; i++) {
    insertHistoricalTrade.run(address, `history-${i}`, `${address}-history-${i}`, matureAddedAt + i);
  }
}

// Anchor every trade inside the CRITICAL 30-min narrow window without making
// them so tightly clustered that the manipulation penalty dominates this test.
const TRADE_OFFSETS_SEC = [1200, 600, 60];

function insertBuy(trades: TradeModel, walletAddress: string, tokenMint: string, sequence: number): ITradeEvent {
  const now = Math.floor(Date.now() / 1000);
  const trade: ITradeEvent = {
    chain: "solana",
    walletAddress,
    tokenMint,
    txSignature: `${tokenMint}-${walletAddress}-${sequence}`,
    amountToken: 1000,
    amountSol: 1,
    amountUsd: 500,
    dexSource: "Jupiter",
    tradeType: "BUY",
    blockTime: now - (TRADE_OFFSETS_SEC[sequence - 1] ?? 60)
  };
  const inserted = trades.insert(trade);
  if (!inserted) throw new Error("test trade insert failed");
  return trade;
}
