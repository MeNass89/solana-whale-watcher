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
    const sql = fs.readFileSync(path.join(migrationsPath, file), "utf8");
    db.exec(sql);
  }
  logger.info("SQLite migrations applied");
}
