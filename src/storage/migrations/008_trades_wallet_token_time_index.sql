-- Idempotent: re-runs on every startup. The existing migrations also lack a tracking
-- table, so guard with IF NOT EXISTS to avoid no-op work and rebuild cost.
CREATE INDEX IF NOT EXISTS idx_trades_wallet_token_time
  ON trades(wallet_address, token_mint, block_time);
