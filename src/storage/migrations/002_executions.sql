CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  convergence_id INTEGER REFERENCES convergences(id),
  token_mint TEXT NOT NULL,
  token_symbol TEXT,
  direction TEXT CHECK(direction IN ('BUY','SELL')) NOT NULL,
  amount_token REAL,
  amount_sol REAL,
  amount_usd REAL,
  entry_price_usd REAL,
  exit_price_usd REAL,
  pnl_usd REAL,
  pnl_pct REAL,
  tx_signature TEXT,
  status TEXT CHECK(status IN ('PENDING','FILLED','FAILED','CANCELLED')) DEFAULT 'PENDING',
  exit_reason TEXT,
  tier TEXT,
  position_size_pct REAL,
  created_at INTEGER DEFAULT (unixepoch()),
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_mint TEXT NOT NULL,
  token_symbol TEXT,
  entry_execution_id INTEGER REFERENCES executions(id),
  convergence_id INTEGER REFERENCES convergences(id),
  amount_token REAL NOT NULL,
  entry_price_usd REAL NOT NULL,
  current_price_usd REAL,
  stop_loss_price REAL,
  take_profit_prices TEXT,
  trailing_stop_pct REAL,
  trailing_stop_active INTEGER DEFAULT 0,
  peak_price_usd REAL,
  time_stop_at INTEGER,
  tier TEXT NOT NULL,
  status TEXT CHECK(status IN ('OPEN','PARTIAL','CLOSED')) DEFAULT 'OPEN',
  exit_reason TEXT,
  pnl_usd REAL,
  pnl_pct REAL,
  opened_at INTEGER DEFAULT (unixepoch()),
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS execution_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(token_mint);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
