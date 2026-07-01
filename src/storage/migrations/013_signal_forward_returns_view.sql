-- Aggregated forward returns per signal bucket, straight off convergences.
-- Answers "which signal tiers/wallet-counts actually predict returns" without
-- ad-hoc queries. Returns are computed only where a positive detection price
-- and the corresponding snapshot exist.
CREATE VIEW IF NOT EXISTS signal_forward_returns AS
SELECT
  tier,
  wallet_count,
  CASE WHEN token_mint LIKE '%pump' THEN 1 ELSE 0 END AS is_pump,
  COUNT(*) AS signals,
  SUM(CASE WHEN outcome NOT IN ('PENDING') THEN 1 ELSE 0 END) AS resolved,
  SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
  AVG(CASE WHEN price_at_detection > 0 AND price_1h IS NOT NULL
           THEN (price_1h - price_at_detection) / price_at_detection * 100 END) AS avg_return_1h_pct,
  AVG(CASE WHEN price_at_detection > 0 AND price_24h IS NOT NULL
           THEN (price_24h - price_at_detection) / price_at_detection * 100 END) AS avg_return_24h_pct,
  AVG(CASE WHEN price_at_detection > 0 AND price_7d IS NOT NULL
           THEN (price_7d - price_at_detection) / price_at_detection * 100 END) AS avg_return_7d_pct
FROM convergences
GROUP BY tier, wallet_count, is_pump;
