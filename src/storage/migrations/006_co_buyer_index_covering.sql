-- Cover wallet_address so SELECT DISTINCT wallet_address can be served
-- entirely from the index.
--
-- Rename: the migration runner re-runs every .sql on every startup, so
-- DROP+CREATE the same name would rebuild the index every restart.
-- Using a distinct name lets `CREATE INDEX IF NOT EXISTS` short-circuit
-- after the first run. We also drop the original narrow index (one-time
-- DROP IF EXISTS is cheap once it's gone).
DROP INDEX IF EXISTS idx_trades_token_type_time;
CREATE INDEX IF NOT EXISTS idx_trades_token_type_wallet_time
  ON trades(token_mint, trade_type, block_time, wallet_address);
