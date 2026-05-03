-- Trades individuels detectes
CREATE TABLE IF NOT EXISTS trades (
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
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_trades_token_time ON trades(token_mint, block_time);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_time ON trades(wallet_address, block_time);
CREATE INDEX IF NOT EXISTS idx_trades_type_time ON trades(trade_type, block_time);

-- Wallets suivis
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  label TEXT,
  source TEXT CHECK(source IN ('manual','axiom','nansen','dune','discovered','co-buyer')),
  score REAL DEFAULT 50.0,
  state TEXT CHECK(state IN ('NEW','PROBATION','ACTIVE','DORMANT','DEMOTED','PRUNED','ARCHIVED')) DEFAULT 'NEW',
  win_rate REAL,
  avg_roi REAL,
  total_trades INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  added_at INTEGER DEFAULT (unixepoch()),
  last_trade_at INTEGER,
  last_scored_at INTEGER
);

-- Evenements de convergence
CREATE TABLE IF NOT EXISTS convergences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_mint TEXT NOT NULL,
  token_symbol TEXT,
  score REAL NOT NULL,
  tier TEXT CHECK(tier IN ('CRITICAL','NOTABLE','WATCH')) NOT NULL,
  wallet_count INTEGER NOT NULL,
  total_usd REAL,
  first_trade_at INTEGER NOT NULL,
  last_trade_at INTEGER NOT NULL,
  window_minutes INTEGER,
  alerted_at INTEGER,
  price_at_detection REAL,
  price_1h REAL,
  price_24h REAL,
  price_7d REAL,
  outcome TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_conv_token ON convergences(token_mint);
CREATE INDEX IF NOT EXISTS idx_conv_tier ON convergences(tier, created_at);

-- Junction convergence <-> trades
CREATE TABLE IF NOT EXISTS convergence_trades (
  convergence_id INTEGER REFERENCES convergences(id),
  trade_id INTEGER REFERENCES trades(id),
  PRIMARY KEY (convergence_id, trade_id)
);

-- Cache metadata token
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  decimals INTEGER,
  image_url TEXT,
  liquidity_usd REAL,
  is_verified INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Snapshots de prix pour backtesting
CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_mint TEXT NOT NULL,
  price_usd REAL NOT NULL,
  liquidity_usd REAL,
  source TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_token_time ON price_snapshots(token_mint, timestamp);

-- Blacklist tokens (stablecoins, wrapped SOL, etc.)
CREATE TABLE IF NOT EXISTS token_blacklist (
  mint TEXT PRIMARY KEY,
  reason TEXT,
  added_at INTEGER DEFAULT (unixepoch())
);

-- Blacklist wallets (MEV bots, exchanges)
CREATE TABLE IF NOT EXISTS wallet_blacklist (
  address TEXT PRIMARY KEY,
  reason TEXT,
  added_at INTEGER DEFAULT (unixepoch())
);
