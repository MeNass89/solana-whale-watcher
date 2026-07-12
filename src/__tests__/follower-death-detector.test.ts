import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { AppDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/database.js";
import { WalletModel } from "../storage/models/wallets.js";
import { checkFollowerWalletDeaths } from "../jobs/follower-death-detector.js";

const DAY = 24 * 60 * 60;
const ADDR = "8aKGXJkqr5JS3R6SvXy1BgxGT6KWn2SApkEvucCT5Z3i";

function setup(): { db: AppDatabase; wallets: WalletModel } {
  const db = new Database(":memory:") as unknown as AppDatabase;
  runMigrations(db);
  return { db, wallets: new WalletModel(db) };
}

function insertBuy(db: AppDatabase, address: string, blockTime: number): void {
  db.prepare(
    `INSERT INTO trades (wallet_address, token_mint, tx_signature, amount_token, dex_source, trade_type, block_time)
     VALUES (?, 'mint', 'sig-' || ?, 1, 'JUPITER', 'BUY', ?)`
  ).run(address, blockTime, blockTime);
}

describe("checkFollowerWalletDeaths", () => {
  it("grace-periods a freshly enrolled wallet with no local trade history", () => {
    const { db, wallets } = setup();
    const now = Math.floor(Date.now() / 1000);
    wallets.upsert({ address: ADDR, source: "manual", state: "ACTIVE", active: true, monitorPolicy: "pinned" });

    const result = checkFollowerWalletDeaths(db, wallets, { now });

    expect(result.dormant).toEqual([]);
    expect(wallets.find(ADDR)?.state).toBe("ACTIVE");
  });

  it("marks a wallet DORMANT once its enrollment grace period lapses with no BUY", () => {
    const { db, wallets } = setup();
    const now = Math.floor(Date.now() / 1000);
    wallets.upsert({ address: ADDR, source: "manual", state: "ACTIVE", active: true, monitorPolicy: "pinned" });

    const result = checkFollowerWalletDeaths(db, wallets, { now: now + 5 * DAY });

    expect(result.dormant).toEqual([ADDR]);
    expect(wallets.find(ADDR)?.state).toBe("DORMANT");
  });

  it("keeps a wallet ACTIVE while its last BUY is within the window", () => {
    const { db, wallets } = setup();
    const now = Math.floor(Date.now() / 1000);
    wallets.upsert({ address: ADDR, source: "manual", state: "ACTIVE", active: true, monitorPolicy: "pinned" });
    insertBuy(db, ADDR, now + 4 * DAY);

    const result = checkFollowerWalletDeaths(db, wallets, { now: now + 5 * DAY });

    expect(result.dormant).toEqual([]);
    expect(wallets.find(ADDR)?.state).toBe("ACTIVE");
  });

  it("marks a wallet DORMANT when its last BUY is older than the window", () => {
    const { db, wallets } = setup();
    const now = Math.floor(Date.now() / 1000);
    wallets.upsert({ address: ADDR, source: "manual", state: "ACTIVE", active: true, monitorPolicy: "pinned" });
    insertBuy(db, ADDR, now);

    const result = checkFollowerWalletDeaths(db, wallets, { now: now + 5 * DAY });

    expect(result.dormant).toEqual([ADDR]);
    expect(wallets.find(ADDR)?.state).toBe("DORMANT");
  });
});
