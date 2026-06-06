CREATE TABLE IF NOT EXISTS rpc_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_rpc_usage_ts ON rpc_usage(ts DESC);
CREATE INDEX IF NOT EXISTS idx_rpc_usage_endpoint_ts ON rpc_usage(endpoint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_rpc_usage_status_ts ON rpc_usage(status, ts DESC);
