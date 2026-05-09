ALTER TABLE wallets ADD COLUMN realized_sol_30d REAL DEFAULT 0;
ALTER TABLE wallets ADD COLUMN n_closed_30d INTEGER DEFAULT 0;
ALTER TABLE wallets ADD COLUMN wallet_class TEXT DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_wallets_class ON wallets(wallet_class);
CREATE INDEX IF NOT EXISTS idx_wallets_realized_sol ON wallets(realized_sol_30d DESC);
