import fs from "node:fs";
import path from "node:path";
import DatabaseConstructor, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

export type AppDatabase = BetterSqliteDatabase;

export function openDatabase(databasePath = config.databasePath): AppDatabase {
  const absolutePath = path.resolve(process.cwd(), databasePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const db = new DatabaseConstructor(absolutePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

export function runMigrations(db: AppDatabase): void {
  const migrationsPath = path.resolve(process.cwd(), "src/storage/migrations");
  const migrationFiles = fs
    .readdirSync(migrationsPath)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    if (file === "004_wallet_pnl_tracking.sql") {
      runWalletPnlTrackingMigration(db);
      continue;
    }
    if (file === "012_data_epoch.sql") {
      runDataEpochMigration(db);
      continue;
    }
    if (file === "014_follower_validation.sql") {
      runFollowerValidationMigration(db);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsPath, file), "utf8");
    db.exec(sql);
  }
  logger.info("SQLite migrations applied");
}

function runFollowerValidationMigration(db: AppDatabase): void {
  const tx = db.transaction(() => {
    rebuildWalletsSourceCheckIfNeeded(db);
    const walletColumns = new Set(
      (db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!walletColumns.has("monitor_policy")) {
      db.exec("ALTER TABLE wallets ADD COLUMN monitor_policy TEXT NOT NULL DEFAULT 'pool' CHECK(monitor_policy IN ('pool','pinned'))");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_wallets_monitor_policy ON wallets(monitor_policy, active)");

    db.exec(`
      CREATE TABLE IF NOT EXISTS follower_recipes (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        take_profit_pct REAL NOT NULL,
        stop_loss_pct REAL NOT NULL,
        max_hold_seconds INTEGER NOT NULL,
        notional_usd REAL NOT NULL,
        frozen INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS follower_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id INTEGER NOT NULL REFERENCES trades(id),
        source_tx_signature TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        token_mint TEXT NOT NULL,
        recipe_id TEXT NOT NULL REFERENCES follower_recipes(id),
        block_time INTEGER NOT NULL,
        webhook_received_at INTEGER NOT NULL,
        detected_at INTEGER NOT NULL DEFAULT (unixepoch()),
        status TEXT CHECK(status IN ('PENDING','FILLED','SKIPPED')) NOT NULL DEFAULT 'PENDING',
        skip_reason TEXT,
        quote_requested_at INTEGER,
        quote_responded_at INTEGER,
        quoted_route TEXT,
        quoted_price_usd REAL,
        fill_price_usd REAL,
        mark_price_usd REAL,
        entry_latency_seconds INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(wallet_address, token_mint, source_tx_signature)
      );

      CREATE TABLE IF NOT EXISTS follower_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL REFERENCES follower_signals(id),
        direction TEXT CHECK(direction IN ('BUY','SELL')) NOT NULL,
        token_mint TEXT NOT NULL,
        amount_token REAL,
        amount_usd REAL NOT NULL,
        price_usd REAL,
        tx_signature TEXT,
        status TEXT CHECK(status IN ('PENDING','FILLED','FAILED','SKIPPED')) NOT NULL DEFAULT 'PENDING',
        reason TEXT,
        quote_requested_at INTEGER,
        quote_responded_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        closed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS follower_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL REFERENCES follower_signals(id),
        recipe_id TEXT NOT NULL REFERENCES follower_recipes(id),
        wallet_address TEXT NOT NULL,
        token_mint TEXT NOT NULL,
        amount_token REAL NOT NULL,
        entry_price_usd REAL NOT NULL,
        current_price_usd REAL,
        peak_price_usd REAL,
        trough_price_usd REAL,
        mae_pct REAL,
        mfe_pct REAL,
        take_profit_price REAL NOT NULL,
        stop_loss_price REAL NOT NULL,
        max_hold_at INTEGER NOT NULL,
        status TEXT CHECK(status IN ('OPEN','CLOSED')) NOT NULL DEFAULT 'OPEN',
        exit_reason TEXT,
        exit_price_usd REAL,
        exit_degraded INTEGER NOT NULL DEFAULT 0,
        exit_check_failed_at INTEGER,
        pnl_usd REAL,
        pnl_pct REAL,
        opened_at INTEGER DEFAULT (unixepoch()),
        closed_at INTEGER
      );
    `);
    const positionColumns = new Set(
      (db.prepare("PRAGMA table_info(follower_positions)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!positionColumns.has("exit_check_failed_at")) {
      db.exec("ALTER TABLE follower_positions ADD COLUMN exit_check_failed_at INTEGER");
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_open_wallet_mint ON follower_positions(wallet_address, token_mint) WHERE status = 'OPEN'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_follower_positions_status ON follower_positions(status, max_hold_at)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_recipes_frozen_wallet ON follower_recipes(wallet_address) WHERE frozen = 1");
    db.exec(`
      INSERT OR IGNORE INTO follower_recipes
        (id, wallet_address, take_profit_pct, stop_loss_pct, max_hold_seconds, notional_usd, frozen)
      VALUES
        ('survivor-a-tp100-sl30-1h-1000', 'CAKWWigQ8tTrgSPRfYtLacirhHE4Zg2EY1Zp8tF1j2Qg', 100, -30, 3600, 1000, 1),
        ('survivor-b-tp100-sl15-1h-1000', 'Dzio1f19rh4gQeo3PvikCHnNCrt6FW7oUv5tog69dE2U', 100, -15, 3600, 1000, 1)
    `);
  });
  tx.immediate();
}

function rebuildWalletsSourceCheckIfNeeded(db: AppDatabase): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wallets'").get() as { sql: string } | undefined;
  if (!row?.sql || row.sql.includes("'solanatracker'")) return;
  db.exec(`
    ALTER TABLE wallets RENAME TO wallets_old_source_check;
    CREATE TABLE wallets (
      address TEXT PRIMARY KEY,
      label TEXT,
      source TEXT CHECK(source IN ('manual','axiom','nansen','dune','discovered','co-buyer','solanatracker')),
      score REAL DEFAULT 50.0,
      state TEXT CHECK(state IN ('NEW','PROBATION','ACTIVE','DORMANT','DEMOTED','PRUNED','ARCHIVED')) DEFAULT 'NEW',
      win_rate REAL,
      avg_roi REAL,
      total_trades INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      added_at INTEGER DEFAULT (unixepoch()),
      last_trade_at INTEGER,
      last_scored_at INTEGER,
      realized_sol_30d REAL DEFAULT 0,
      n_closed_30d INTEGER DEFAULT 0,
      wallet_class TEXT DEFAULT 'incomplete'
    );
    INSERT INTO wallets
      (address, label, source, score, state, win_rate, avg_roi, total_trades, active,
       added_at, last_trade_at, last_scored_at, realized_sol_30d, n_closed_30d, wallet_class)
    SELECT
      address, label, source, score, state, win_rate, avg_roi, total_trades, active,
      added_at, last_trade_at, last_scored_at,
      COALESCE(realized_sol_30d, 0), COALESCE(n_closed_30d, 0), COALESCE(wallet_class, 'incomplete')
    FROM wallets_old_source_check;
    DROP TABLE wallets_old_source_check;
    CREATE INDEX IF NOT EXISTS idx_wallets_class ON wallets(wallet_class);
    CREATE INDEX IF NOT EXISTS idx_wallets_realized_sol ON wallets(realized_sol_30d DESC);
  `);
}

function runDataEpochMigration(db: AppDatabase): void {
  const tx = db.transaction(() => {
    for (const table of ["positions", "executions"] as const) {
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (!columns.has("data_epoch")) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN data_epoch INTEGER DEFAULT 1`);
      }
    }
  });
  // Same locking rationale as runWalletPnlTrackingMigration.
  tx.immediate();
}

function runWalletPnlTrackingMigration(db: AppDatabase): void {
  const tx = db.transaction(() => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>).map((column) => column.name)
    );

    if (!columns.has("realized_sol_30d")) {
      db.exec("ALTER TABLE wallets ADD COLUMN realized_sol_30d REAL DEFAULT 0");
    }
    if (!columns.has("n_closed_30d")) {
      db.exec("ALTER TABLE wallets ADD COLUMN n_closed_30d INTEGER DEFAULT 0");
    }
    if (!columns.has("wallet_class")) {
      db.exec("ALTER TABLE wallets ADD COLUMN wallet_class TEXT DEFAULT 'unknown'");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_wallets_class ON wallets(wallet_class)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_wallets_realized_sol ON wallets(realized_sol_30d DESC)");
  });
  // Acquire RESERVED lock up-front so two concurrent startups can't both
  // observe the pre-migration schema.
  tx.immediate();
}
