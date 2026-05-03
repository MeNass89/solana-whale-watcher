PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS trades_dedup_migration;
CREATE TABLE trades_dedup_migration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  tx_signature TEXT NOT NULL,
  amount_token REAL,
  amount_sol REAL,
  amount_usd REAL,
  dex_source TEXT,
  trade_type TEXT CHECK(trade_type IN ('BUY','SELL')) NOT NULL,
  block_time INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(tx_signature, wallet_address, token_mint)
);

INSERT OR IGNORE INTO trades_dedup_migration (
  id, wallet_address, token_mint, tx_signature, amount_token, amount_sol,
  amount_usd, dex_source, trade_type, block_time, created_at
)
SELECT
  id, wallet_address, token_mint, tx_signature, amount_token, amount_sol,
  amount_usd, dex_source, trade_type, block_time, created_at
FROM trades;

DROP TABLE trades;
ALTER TABLE trades_dedup_migration RENAME TO trades;

CREATE INDEX IF NOT EXISTS idx_trades_token_time ON trades(token_mint, block_time);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_time ON trades(wallet_address, block_time);
CREATE INDEX IF NOT EXISTS idx_trades_type_time ON trades(trade_type, block_time);
DROP INDEX IF EXISTS idx_trades_dedup;
CREATE UNIQUE INDEX idx_trades_dedup ON trades(tx_signature, wallet_address, token_mint);

PRAGMA foreign_keys = ON;
