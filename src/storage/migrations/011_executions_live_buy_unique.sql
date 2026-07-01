-- Ensure at most one in-flight (PENDING) BUY per token_mint.
-- DB-level backstop for entry idempotency: retry paths (webhook convergence,
-- pendingExecutionRetries) that interleave across network awaits can no longer
-- record duplicate BUY executions for the same token during the race window.
--
-- Deliberately PENDING-only: FILLED BUY rows persist after their position
-- closes, so including FILLED would block re-entry on a token forever. The
-- open-position check in TradeExecutor covers the post-fill dedup case.
--
-- Defensive cleanup: if pre-existing duplicate PENDING BUYs exist, keep the
-- highest-id one per mint and cancel the rest with an audit reason. Without
-- this, the unique-index creation fails on legacy data.
UPDATE executions
   SET status = 'CANCELLED',
       exit_reason = COALESCE(exit_reason, '') || ' | AUDIT_DEDUPE: superseded by newer live BUY',
       closed_at = COALESCE(closed_at, unixepoch())
 WHERE id IN (
   SELECT e.id FROM executions e
   WHERE e.direction = 'BUY'
     AND e.status = 'PENDING'
     AND e.id < (
       SELECT MAX(e2.id) FROM executions e2
       WHERE e2.token_mint = e.token_mint
         AND e2.direction = 'BUY'
         AND e2.status = 'PENDING'
     )
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_live_buy_mint
  ON executions(token_mint)
  WHERE direction = 'BUY' AND status = 'PENDING';
