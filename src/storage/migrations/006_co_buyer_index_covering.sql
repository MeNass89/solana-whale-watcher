-- Cover wallet_address so SELECT DISTINCT wallet_address can be served
-- entirely from the index.
DROP INDEX IF EXISTS idx_trades_token_type_time;
CREATE INDEX IF NOT EXISTS idx_trades_token_type_time
  ON trades(token_mint, trade_type, block_time, wallet_address);
