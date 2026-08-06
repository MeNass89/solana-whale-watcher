import fs from "node:fs";
import path from "node:path";
import DatabaseConstructor, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import type {
  CarryConfig,
  CarryDecision,
  EnginePosition,
  FundingSnapshot
} from "./carry-engine.js";

export const DEFAULT_FUNDING_DATABASE_PATH = "data/funding-live.sqlite";

export class FundingStore {
  public readonly database: BetterSqliteDatabase;

  public constructor(databasePath = DEFAULT_FUNDING_DATABASE_PATH) {
    const resolvedPath = databasePath === ":memory:" ? databasePath : path.resolve(process.cwd(), databasePath);
    if (resolvedPath !== ":memory:") fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.database = new DatabaseConstructor(resolvedPath);
    this.database.pragma("journal_mode = WAL");
    this.createSchema();
  }

  public close(): void {
    this.database.close();
  }

  public getConfig(): CarryConfig {
    const row = this.database.prepare(`
      SELECT entry_threshold_annualized, exit_threshold_annualized, notional_usd, enabled
      FROM carry_config WHERE id = 1
    `).get() as {
      entry_threshold_annualized: number;
      exit_threshold_annualized: number;
      notional_usd: number;
      enabled: number;
    };
    return {
      entryThresholdAnnualized: row.entry_threshold_annualized,
      exitThresholdAnnualized: row.exit_threshold_annualized,
      notionalUsd: row.notional_usd,
      enabled: row.enabled === 1
    };
  }

  public getLatestSnapshotTs(): number | undefined {
    const row = this.database.prepare("SELECT MAX(ts) AS ts FROM funding_snapshots").get() as { ts: number | null };
    return row.ts ?? undefined;
  }

  public getSnapshotCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM funding_snapshots").get() as { count: number };
    return row.count;
  }

  public getOpenPositions(): EnginePosition[] {
    const rows = this.database.prepare(`
      SELECT id, asset, long_venue, short_venue, entry_ts, entry_spread_annualized,
             entry_threshold, notional_usd, entry_cost_usd, funding_accrued_usd
      FROM carry_positions WHERE status = 'open' ORDER BY id
    `).all() as Array<{
      id: number;
      asset: EnginePosition["asset"];
      long_venue: EnginePosition["longVenue"];
      short_venue: EnginePosition["shortVenue"];
      entry_ts: number;
      entry_spread_annualized: number;
      entry_threshold: number;
      notional_usd: number;
      entry_cost_usd: number;
      funding_accrued_usd: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      asset: row.asset,
      longVenue: row.long_venue,
      shortVenue: row.short_venue,
      entryTs: row.entry_ts,
      entrySpreadAnnualized: row.entry_spread_annualized,
      entryThreshold: row.entry_threshold,
      notionalUsd: row.notional_usd,
      entryCostUsd: row.entry_cost_usd,
      fundingAccruedUsd: row.funding_accrued_usd
    }));
  }

  public getCumulativeNetPnl(): number {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(net_pnl_usd), 0) AS total FROM carry_positions WHERE status = 'closed'
    `).get() as { total: number };
    return row.total;
  }

  public applyPoll(snapshots: readonly FundingSnapshot[], decision: CarryDecision): void {
    const apply = this.database.transaction(() => {
      const insertSnapshot = this.database.prepare(`
        INSERT INTO funding_snapshots (ts, asset, venue, rate_raw, rate_annualized, mark_price)
        VALUES (@ts, @asset, @venue, @rateRaw, @rateAnnualized, @markPrice)
      `);
      for (const snapshot of snapshots) insertSnapshot.run(snapshot);

      const accrue = this.database.prepare(`
        UPDATE carry_positions
        SET funding_accrued_usd = funding_accrued_usd + ?
        WHERE id = ? AND status = 'open'
      `);
      for (const item of decision.accruals) accrue.run(item.amountUsd, item.positionId);

      const closePosition = this.database.prepare(`
        UPDATE carry_positions
        SET status = 'closed', exit_ts = @exitTs, exit_spread = @exitSpread,
            exit_reason = @exitReason, funding_accrued_usd = @fundingAccruedUsd,
            exit_cost_usd = @exitCostUsd, net_pnl_usd = @netPnlUsd
        WHERE id = @positionId AND status = 'open'
      `);
      for (const exit of decision.exits) closePosition.run(exit);

      const openPosition = this.database.prepare(`
        INSERT INTO carry_positions
          (asset, long_venue, short_venue, entry_ts, entry_spread_annualized,
           entry_threshold, notional_usd, entry_cost_usd, status, funding_accrued_usd)
        VALUES
          (@asset, @longVenue, @shortVenue, @entryTs, @entrySpreadAnnualized,
           @entryThreshold, @notionalUsd, @entryCostUsd, 'open', 0)
      `);
      for (const entry of decision.entries) openPosition.run(entry);
    });
    apply.immediate();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS funding_snapshots (
        ts INTEGER NOT NULL,
        asset TEXT NOT NULL CHECK(asset IN ('SOL','BTC','ETH')),
        venue TEXT NOT NULL CHECK(venue IN ('binance','bybit','hyperliquid')),
        rate_raw REAL NOT NULL,
        rate_annualized REAL NOT NULL,
        mark_price REAL NOT NULL,
        UNIQUE(ts, asset, venue)
      );

      CREATE TABLE IF NOT EXISTS carry_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset TEXT NOT NULL CHECK(asset IN ('SOL','BTC','ETH')),
        long_venue TEXT NOT NULL CHECK(long_venue IN ('binance','bybit','hyperliquid')),
        short_venue TEXT NOT NULL CHECK(short_venue IN ('binance','bybit','hyperliquid')),
        entry_ts INTEGER NOT NULL,
        entry_spread_annualized REAL NOT NULL,
        entry_threshold REAL NOT NULL,
        notional_usd REAL NOT NULL,
        entry_cost_usd REAL NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','closed')),
        exit_ts INTEGER,
        exit_spread REAL,
        exit_reason TEXT,
        funding_accrued_usd REAL NOT NULL DEFAULT 0,
        exit_cost_usd REAL,
        net_pnl_usd REAL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_carry_positions_open_pair
      ON carry_positions(asset, min(long_venue, short_venue), max(long_venue, short_venue))
      WHERE status = 'open';

      CREATE TABLE IF NOT EXISTS carry_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        entry_threshold_annualized REAL NOT NULL,
        exit_threshold_annualized REAL NOT NULL,
        notional_usd REAL NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
      );

      INSERT OR IGNORE INTO carry_config
        (id, entry_threshold_annualized, exit_threshold_annualized, notional_usd, enabled)
      VALUES (1, 10, 5, 1000, 1);
    `);
  }
}
