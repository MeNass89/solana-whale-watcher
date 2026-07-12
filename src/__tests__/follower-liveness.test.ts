import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateFollowerCandidate } from "../engine/liveness.js";
import { checkFollowerWalletDeaths } from "../jobs/follower-death-detector.js";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import { WalletModel } from "../storage/models/wallets.js";

function dbWithWallet(): { db: AppDatabase; wallets: WalletModel } {
  const db = new Database(":memory:") as AppDatabase;
  runMigrations(db);
  const wallets = new WalletModel(db);
  wallets.upsert({ address: "wallet-a", source: "discovered", state: "ACTIVE", monitorPolicy: "pinned" });
  return { db, wallets };
}

describe("follower liveness gate", () => {
  it("refuses dormant wallets without a qualifying BUY in the last 72h", async () => {
    const now = 2_000_000;
    const result = await evaluateFollowerCandidate({
      address: "wallet-a",
      now,
      fetchBuys: async () => [{ signature: "old", blockTime: now - 5 * 24 * 60 * 60 }]
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/72h/i);
  });

  it("refuses bot-regime wallets whose 7d cadence exceeds the follow ceiling", async () => {
    const now = 2_000_000;
    // 91 buys over the last 7 days → 13/day, above the 12/day ceiling.
    const buys = Array.from({ length: 91 }, (_, index) => ({
      signature: `sig-${index}`,
      blockTime: now - (index % 7) * 24 * 60 * 60 - 60
    }));

    const result = await evaluateFollowerCandidate({ address: "wallet-a", now, fetchBuys: async () => buys });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/cadence too high/i);
  });

  it("accepts wallets with recent cadence and projected validation volume", async () => {
    const now = 2_000_000;
    const buys = Array.from({ length: 16 }, (_, index) => ({
      signature: `sig-${index}`,
      blockTime: now - index * 20 * 60 * 60
    }));

    const result = await evaluateFollowerCandidate({ address: "wallet-a", now, fetchBuys: async () => buys });

    expect(result.allowed).toBe(true);
    expect(result.metrics.projectedClosedTrades28d).toBeGreaterThanOrEqual(30);
  });
});

describe("follower wallet death detector", () => {
  it("marks pinned wallets DORMANT when no BUY arrived within the death window", () => {
    const { db, wallets } = dbWithWallet();
    const now = 2_000_000;
    db.prepare(
      `INSERT INTO trades (wallet_address, token_mint, tx_signature, trade_type, block_time)
       VALUES ('wallet-a', 'mint-a', 'sig-old', 'BUY', ?)`
    ).run(now - 5 * 24 * 60 * 60);

    const result = checkFollowerWalletDeaths(db, wallets, { now, dormantAfterDays: 4 });

    expect(result.dormant).toEqual(["wallet-a"]);
    expect(wallets.find("wallet-a")?.state).toBe("DORMANT");
  });
});

describe("add-wallet liveness buy fetch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("merges local BUY rows with on-chain Helius qualifying SWAP receives", async () => {
    vi.stubEnv("HELIUS_API_KEY", "test-helius");
    const { fetchCandidateBuys } = await import("../../scripts/add-wallet.js");
    const { db } = dbWithWallet();
    db.prepare(
      `INSERT INTO trades (wallet_address, token_mint, tx_signature, trade_type, block_time)
       VALUES ('wallet-a', 'mint-local', 'sig-local', 'BUY', 1900)`
    ).run();
    const helius = {
      getWalletTransactionsSince: vi.fn().mockResolvedValue([
        {
          signature: "sig-chain",
          type: "SWAP",
          timestamp: 1950,
          tokenTransfers: [{ toUserAccount: "wallet-a", mint: "mint-chain", tokenAmount: 5 }],
          nativeTransfers: []
        },
        {
          signature: "sig-usdc",
          type: "SWAP",
          timestamp: 1960,
          tokenTransfers: [{ toUserAccount: "wallet-a", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: 5 }],
          nativeTransfers: []
        }
      ])
    };

    const buys = await fetchCandidateBuys({ db, address: "wallet-a", sinceBlockTime: 1800, helius: helius as any });

    expect(buys.map((buy) => buy.signature)).toEqual(["sig-chain", "sig-local"]);
  });

  it("requires Helius API key for pinned candidate buy fetches", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    const { fetchCandidateBuys } = await import("../../scripts/add-wallet.js");
    const { db } = dbWithWallet();

    await expect(fetchCandidateBuys({ db, address: "wallet-a", sinceBlockTime: 1800, helius: {} as any })).rejects.toThrow(/HELIUS_API_KEY/);
  });
});

describe("add-wallet frozen recipe enrollment", () => {
  it("creates one frozen recipe per pinned wallet and never replaces it", async () => {
    const { ensureFrozenRecipe } = await import("../../scripts/add-wallet.js");
    const { db } = dbWithWallet();

    const first = ensureFrozenRecipe(db, { address: "wallet-a", takeProfitPct: 100, stopLossPct: -30, maxHoldSeconds: 3600, notionalUsd: 1000 });
    const second = ensureFrozenRecipe(db, { address: "wallet-a", takeProfitPct: 50, stopLossPct: -15, maxHoldSeconds: 900, notionalUsd: 500 });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const row = db.prepare("SELECT take_profit_pct, stop_loss_pct FROM follower_recipes WHERE wallet_address = 'wallet-a' AND frozen = 1").get() as { take_profit_pct: number; stop_loss_pct: number };
    expect(row).toEqual({ take_profit_pct: 100, stop_loss_pct: -30 });
  });
});
