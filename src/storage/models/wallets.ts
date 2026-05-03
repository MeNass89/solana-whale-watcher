import type { AppDatabase } from "../database.js";
import type { WalletSource, WalletState } from "../../blockchain/types.js";

export interface WalletRow {
  address: string;
  label: string | null;
  source: WalletSource | null;
  score: number;
  state: WalletState;
  win_rate: number | null;
  avg_roi: number | null;
  total_trades: number;
  active: number;
  added_at: number;
  last_trade_at: number | null;
  last_scored_at: number | null;
}

export class WalletModel {
  constructor(private readonly db: AppDatabase) {}

  listActive(): WalletRow[] {
    return this.db.prepare("SELECT * FROM wallets WHERE active = 1 ORDER BY added_at ASC").all() as WalletRow[];
  }

  listAll(): WalletRow[] {
    return this.db.prepare("SELECT * FROM wallets ORDER BY active DESC, added_at DESC").all() as WalletRow[];
  }

  countActive(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM wallets WHERE active = 1").get() as { count: number };
    return Number(row.count);
  }

  countByState(state: WalletState): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM wallets WHERE state = ?").get(state) as { count: number };
    return Number(row.count);
  }

  promoteTopN(n: number): number {
    const result = this.db.prepare(
      `UPDATE wallets SET state = 'ACTIVE'
       WHERE address IN (
         SELECT address FROM wallets
         WHERE active = 1 AND state IN ('PROBATION', 'DORMANT', 'DEMOTED')
         ORDER BY score DESC
         LIMIT ?
       )`
    ).run(n);
    return result.changes;
  }

  upsert(input: { address: string; label?: string; source?: WalletSource; state?: WalletState; active?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO wallets (address, label, source, state, active)
         VALUES (@address, @label, @source, @state, @active)
         ON CONFLICT(address) DO UPDATE SET
           label = excluded.label,
           source = excluded.source,
           state = excluded.state,
           active = excluded.active`
      )
      .run({
        address: input.address,
        label: input.label ?? null,
        source: input.source ?? "manual",
        state: input.state ?? "NEW",
        active: input.active === false ? 0 : 1
      });
  }

  update(address: string, input: Partial<{ label: string; source: WalletSource; state: WalletState; active: boolean }>): void {
    const current = this.find(address);
    if (!current) throw new Error("Wallet not found");
    this.upsert({
      address,
      label: input.label ?? current.label ?? undefined,
      source: input.source ?? current.source ?? "manual",
      state: input.state ?? current.state,
      active: input.active ?? (current.active === 1)
    });
  }

  deactivate(address: string): void {
    this.db.prepare("UPDATE wallets SET active = 0 WHERE address = ?").run(address);
  }

  find(address: string): WalletRow | null {
    return (this.db.prepare("SELECT * FROM wallets WHERE address = ?").get(address) as WalletRow | undefined) ?? null;
  }

  scoresFor(addresses: string[]): Map<string, number> {
    if (addresses.length === 0) return new Map();
    const rows = this.db
      .prepare(`SELECT address, score FROM wallets WHERE address IN (${addresses.map(() => "?").join(",")})`)
      .all(...addresses) as Array<{ address: string; score: number }>;
    return new Map(rows.map((row) => [row.address, row.score]));
  }

  markTrade(address: string, blockTime: number): void {
    this.db
      .prepare("UPDATE wallets SET total_trades = total_trades + 1, last_trade_at = ? WHERE address = ?")
      .run(blockTime, address);
  }

  findScoringQueue(limit = 50): WalletRow[] {
    return this.db
      .prepare(
        `SELECT * FROM wallets
         WHERE active = 1 AND state IN ('NEW', 'PROBATION', 'ACTIVE', 'DORMANT', 'DEMOTED')
         ORDER BY
           CASE state WHEN 'NEW' THEN 0 WHEN 'ACTIVE' THEN 1 WHEN 'PROBATION' THEN 2 ELSE 3 END,
           last_scored_at ASC NULLS FIRST,
           added_at ASC
         LIMIT ?`
      )
      .all(limit) as WalletRow[];
  }

  updateScore(address: string, metrics: {
    score: number;
    winRate: number | null;
    avgRoi: number | null;
    totalTrades: number;
    state: WalletState;
  }): void {
    const active = metrics.state === "PRUNED" ? 0 : 1;
    this.db
      .prepare(
        `UPDATE wallets
         SET score = ?, win_rate = ?, avg_roi = ?, total_trades = ?,
             state = ?, active = ?, last_scored_at = ?
         WHERE address = ?`
      )
      .run(
        metrics.score,
        metrics.winRate,
        metrics.avgRoi,
        metrics.totalTrades,
        metrics.state,
        active,
        Math.floor(Date.now() / 1000),
        address
      );
  }
}
