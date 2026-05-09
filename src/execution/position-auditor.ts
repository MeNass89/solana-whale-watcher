import type { AppDatabase } from "../storage/database.js";
import { logger } from "../utils/logger.js";
import { isSanePrice } from "./jupiter-client.js";

interface AuditResult {
  total: number;
  valid: number;
  quarantined: number;
  reasons: string[];
}

export function auditOpenPositions(db: AppDatabase): AuditResult {
  const positions = db
    .prepare("SELECT p.*, c.wallet_count, c.tier as conv_tier FROM positions p LEFT JOIN convergences c ON p.convergence_id = c.id WHERE p.status IN ('OPEN','PARTIAL')")
    .all() as any[];

  const result: AuditResult = { total: positions.length, valid: 0, quarantined: 0, reasons: [] };

  for (const pos of positions) {
    const violations: string[] = [];

    if (pos.tier === "WATCH") violations.push("WATCH tier position");
    if (!isSanePrice(pos.entry_price_usd)) violations.push(`invalid entry price: ${pos.entry_price_usd}`);
    if (pos.current_price_usd !== null && !isSanePrice(pos.current_price_usd)) violations.push(`invalid current price: ${pos.current_price_usd}`);
    if (pos.amount_token <= 0 || pos.amount_token > 1e30 || !Number.isFinite(pos.amount_token)) violations.push(`invalid amount: ${pos.amount_token}`);
    if (pos.wallet_count !== null && pos.wallet_count < 2) violations.push(`convergence had only ${pos.wallet_count} wallet(s)`);
    // LEFT JOIN can leave convergence fields null when the backing row was
    // deleted or never linked. Treat that as no convergence backing.
    if (pos.conv_tier === null || pos.wallet_count === null) violations.push("no convergence backing (orphaned position)");

    if (violations.length > 0) {
      db.prepare("UPDATE positions SET status = 'CLOSED', exit_reason = ?, closed_at = unixepoch() WHERE id = ?")
        .run(`AUDIT_QUARANTINE: ${violations.join("; ")}`, pos.id);
      logger.warn({ positionId: pos.id, token: pos.token_symbol, violations }, "startup audit: quarantined position");
      result.quarantined++;
      result.reasons.push(...violations);
    } else {
      result.valid++;
    }
  }

  if (result.quarantined > 0) {
    logger.warn({ total: result.total, quarantined: result.quarantined }, "startup audit complete — positions quarantined");
  } else {
    logger.info({ total: result.total }, "startup audit complete — all positions valid");
  }

  return result;
}
