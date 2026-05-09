-- Backfill any wallets still marked 'unknown' (the migration-004 default) to
-- 'incomplete' so the convergence quality gate (convergences.ts) treats them
-- as uncomputed instead of bypassing the gate. Idempotent - re-running on
-- already-classified wallets is a no-op.
UPDATE wallets SET wallet_class = 'incomplete' WHERE wallet_class = 'unknown' OR wallet_class IS NULL;
