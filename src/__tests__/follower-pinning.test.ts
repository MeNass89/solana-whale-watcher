import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import { WalletModel } from "../storage/models/wallets.js";
import { WalletMonitor } from "../blockchain/wallet-monitor.js";
import { applyPoolRefresh, assertPinnedWebhookInvariant } from "../../scripts/refresh-pool.js";

function memoryDb(): AppDatabase {
  const db = new Database(":memory:") as AppDatabase;
  runMigrations(db);
  return db;
}

describe("survivor follower pinning", () => {
  it("keeps pinned discovered wallets active through a pool refresh", () => {
    const db = memoryDb();
    const wallets = new WalletModel(db);
    wallets.upsert({
      address: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      label: "survivor",
      source: "discovered",
      state: "ACTIVE",
      active: true,
      monitorPolicy: "pinned"
    });

    applyPoolRefresh(db, wallets, [
      {
        wallet: "4Nd1m4A9xAf7g3pjRy1B7vKf6F4WJqX4gR5dG32sX1aQ",
        summary: { realized: 1000, totalWins: 10, totalLosses: 2, winPercentage: 83.3, averageBuyAmount: 500 }
      }
    ]);

    const pinned = wallets.find("CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg");
    const pool = wallets.find("4Nd1m4A9xAf7g3pjRy1B7vKf6F4WJqX4gR5dG32sX1aQ");
    expect(pinned).toMatchObject({ active: 1, source: "discovered", monitor_policy: "pinned" });
    expect(pool).toMatchObject({ active: 1, source: "solanatracker", monitor_policy: "pool" });
  });

  it("syncs the webhook with active pool wallets plus pinned wallets", async () => {
    const db = memoryDb();
    const wallets = new WalletModel(db);
    wallets.upsert({ address: "4Nd1m4A9xAf7g3pjRy1B7vKf6F4WJqX4gR5dG32sX1aQ", source: "solanatracker", active: true });
    wallets.upsert({
      address: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      source: "discovered",
      active: false,
      monitorPolicy: "pinned"
    });
    const helius = { updateWebhook: vi.fn(), registerWebhook: vi.fn() };
    const monitor = new WalletMonitor(wallets, helius as any);

    await monitor.syncWebhook();

    const addresses = helius.registerWebhook.mock.calls[0][0] as string[];
    expect(addresses).toEqual(expect.arrayContaining([
      "4Nd1m4A9xAf7g3pjRy1B7vKf6F4WJqX4gR5dG32sX1aQ",
      "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg"
    ]));
  });

  it("reports a webhook invariant violation when a pinned wallet is missing", () => {
    const db = memoryDb();
    const wallets = new WalletModel(db);
    wallets.upsert({
      address: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      source: "discovered",
      monitorPolicy: "pinned"
    });

    expect(() => assertPinnedWebhookInvariant(wallets, [])).toThrow(/pinned wallet missing/i);
  });

  it("preserves pinned monitor policy when upsert omits monitorPolicy", () => {
    const db = memoryDb();
    const wallets = new WalletModel(db);
    wallets.upsert({
      address: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      source: "discovered",
      monitorPolicy: "pinned"
    });

    wallets.upsert({
      address: "CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg",
      label: "renamed",
      source: "manual"
    });

    expect(wallets.find("CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg")).toMatchObject({
      label: "renamed",
      monitor_policy: "pinned"
    });
  });

  it("excludes pinned wallets from scorer queue and promotion", () => {
    const db = memoryDb();
    const wallets = new WalletModel(db);
    wallets.upsert({ address: "pinned-a", source: "discovered", state: "DORMANT", active: true, monitorPolicy: "pinned" });
    wallets.upsert({ address: "pool-a", source: "manual", state: "DORMANT", active: true, monitorPolicy: "pool" });

    expect(wallets.findScoringQueue().map((wallet) => wallet.address)).not.toContain("pinned-a");
    expect(wallets.promoteTopN(10)).toBe(1);
    expect(wallets.find("pinned-a")?.state).toBe("DORMANT");
    expect(wallets.find("pool-a")?.state).toBe("ACTIVE");
  });

  it("webhook ingest accepts pinned inactive monitored wallets", async () => {
    vi.resetModules();
    vi.doMock("../execution/jupiter-client.js", () => ({
      SOL_MINT: "So11111111111111111111111111111111111111112",
      jupiterClient: { getPriceUsd: vi.fn().mockResolvedValue(100) }
    }));
    const { registerWebhookRoutes } = await import("../api/routes/webhooks.js");
    const db = memoryDb();
    const wallets = new WalletModel(db);
    wallets.upsert({ address: "wallet-pinned", source: "discovered", active: false, monitorPolicy: "pinned", state: "DORMANT" });
    const trades = { insert: vi.fn((trade) => ({ id: 1, wallet_address: trade.walletAddress, token_mint: trade.tokenMint, trade_type: trade.tradeType, block_time: trade.blockTime, tx_signature: trade.txSignature })) };
    const app = Fastify();
    await registerWebhookRoutes(app, {
      db,
      wallets,
      trades: trades as any,
      convergences: { tradesForConvergence: vi.fn() } as any,
      engine: { checkConvergence: vi.fn().mockResolvedValue(null) } as any,
      follower: { onTrade: vi.fn() } as any,
      alerts: { dispatch: vi.fn() } as any
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/helius",
      headers: { authorization: "dev-webhook-secret" },
      payload: [{
        signature: "sig-pinned-inactive",
        type: "SWAP",
        timestamp: 1000,
        tokenTransfers: [{ toUserAccount: "wallet-pinned", mint: "mint-a", tokenAmount: 2 }],
        nativeTransfers: [{ fromUserAccount: "wallet-pinned", amount: 1_000_000_000 }]
      }]
    });

    expect(response.statusCode).toBe(200);
    expect(trades.insert).toHaveBeenCalledWith(expect.objectContaining({ walletAddress: "wallet-pinned", tradeType: "BUY" }));
    await app.close();
    vi.doUnmock("../execution/jupiter-client.js");
  });
});
