import type { Statement } from "better-sqlite3";
import type { AppDatabase } from "../storage/database.js";
import { logger } from "../utils/logger.js";

interface UsageRecord {
  endpoint: string;
  method: string;
  status: string;
  durationMs: number;
  error: string | null;
}

type BufferedRecord = UsageRecord & { ts: number };

const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER = 1000;

/**
 * Batched writer for the `rpc_usage` SQLite table. Buffers in-memory and
 * flushes every 30s (or when the buffer hits 1000 records) to avoid one
 * INSERT per RPC call. Survives the synchronous hot path with zero cost.
 */
export class RpcUsageLogger {
  private buffer: BufferedRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly insertStmt: Statement<[number, string, string, string, number, string | null]>;
  private readonly insertMany: (rows: BufferedRecord[]) => void;

  constructor(private db: AppDatabase) {
    this.insertStmt = db.prepare(
      "INSERT INTO rpc_usage (ts, endpoint, method, status, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?)"
    );
    this.insertMany = db.transaction((rows: BufferedRecord[]) => {
      for (const row of rows) {
        this.insertStmt.run(row.ts, row.endpoint, row.method, row.status, row.durationMs, row.error);
      }
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.flush();
  }

  record(record: UsageRecord): void {
    this.buffer.push({ ...record, ts: Date.now() });
    if (this.buffer.length >= MAX_BUFFER) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      this.insertMany(rows);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err : new Error(String(err)), n: rows.length }, "rpc_usage flush failed");
    }
  }

  /**
   * 24h summary: count per (endpoint, status). Used by the audit-mode dry run
   * and the /health endpoint.
   */
  summary(windowMs = 24 * 60 * 60 * 1000): Array<{ endpoint: string; status: string; count: number; avg_duration_ms: number }> {
    const since = Date.now() - windowMs;
    const rows = this.db
      .prepare(
        `SELECT endpoint, status, COUNT(*) AS count, AVG(duration_ms) AS avg_duration_ms
         FROM rpc_usage WHERE ts >= ? GROUP BY endpoint, status ORDER BY count DESC`
      )
      .all(since) as Array<{ endpoint: string; status: string; count: number; avg_duration_ms: number }>;
    return rows;
  }
}
