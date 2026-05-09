-- Ensure at most one OPEN/PARTIAL position per token_mint.
-- Eliminates the SELECT -> openPosition race window that lets two concurrent
-- convergences open duplicate positions on the same mint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_active_mint
  ON positions(token_mint)
  WHERE status IN ('OPEN', 'PARTIAL');
