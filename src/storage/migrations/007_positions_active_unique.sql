-- Ensure at most one OPEN/PARTIAL position per token_mint.
-- Eliminates the SELECT -> openPosition race window that lets two concurrent
-- convergences open duplicate positions on the same mint.
--
-- Defensive cleanup: if any pre-existing duplicates exist (from before this
-- migration), keep the highest-id row OPEN/PARTIAL and mark the rest CLOSED
-- with an audit reason. Without this, the unique-index creation fails on
-- legacy data.
UPDATE positions
   SET status = 'CLOSED',
       exit_reason = COALESCE(exit_reason, '') || ' | AUDIT_DEDUPE: superseded by newer open position',
       closed_at = COALESCE(closed_at, unixepoch())
 WHERE id IN (
   SELECT p.id FROM positions p
   WHERE p.status IN ('OPEN', 'PARTIAL')
     AND p.id < (
       SELECT MAX(p2.id) FROM positions p2
       WHERE p2.token_mint = p.token_mint AND p2.status IN ('OPEN', 'PARTIAL')
     )
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_active_mint
  ON positions(token_mint)
  WHERE status IN ('OPEN', 'PARTIAL');
