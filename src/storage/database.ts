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
    const sql = fs.readFileSync(path.join(migrationsPath, file), "utf8");
    db.exec(sql);
  }
  logger.info("SQLite migrations applied");
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
