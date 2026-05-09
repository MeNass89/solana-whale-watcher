-- Composite index for the co-buyer scanner SELECT DISTINCT wallet_address
-- WHERE token_mint = ? AND trade_type = 'BUY' AND block_time BETWEEN ? AND ?.
-- Without this, the scan falls back to a per-token-mint range scan that
-- re-reads every trade row in the window.
CREATE INDEX IF NOT EXISTS idx_trades_token_type_time
  ON trades(token_mint, trade_type, block_time);
