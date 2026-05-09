import type { AlertTier } from "../blockchain/types.js";
import { config } from "../config/index.js";
import type { AppDatabase } from "../storage/database.js";
import type { WalletModel } from "../storage/models/wallets.js";
import { logger } from "../utils/logger.js";
import { unixNow } from "../utils/helpers.js";
import type { JupiterClient } from "./jupiter-client.js";
import { isSanePrice, isSanePriceChange, jupiterClient } from "./jupiter-client.js";
import { auditOpenPositions } from "./position-auditor.js";

export interface PositionRow {
  id: number;
  token_mint: string;
  token_symbol: string | null;
  entry_execution_id: number | null;
  convergence_id: number | null;
  amount_token: number;
  entry_price_usd: number;
  current_price_usd: number | null;
  stop_loss_price: number | null;
  take_profit_prices: string | null;
  trailing_stop_pct: number | null;
  trailing_stop_active: number;
  peak_price_usd: number | null;
  time_stop_at: number | null;
  tier: AlertTier;
  status: "OPEN" | "PARTIAL" | "CLOSED";
  exit_reason: string | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  opened_at: number;
  closed_at: number | null;
}

export interface OpenPositionInput {
  tokenMint: string;
  tokenSymbol?: string | null;
  entryExecutionId: number;
  convergenceId: number;
  amountToken: number;
  entryPriceUsd: number;
  tier: AlertTier;
}

interface TakeProfitLevel {
  targetPct: number;
  sellPct: number;
  executed: boolean;
}

type ExitHandler = (position: PositionRow, reason: string, sellPct: number, panicExit?: boolean) => Promise<void>;

const FIRST_30_MIN_STOP_PCT = -8;
const HARD_STOP_FLOOR_PCT = -15;
const MAX_DOLLAR_LOSS_PORTFOLIO_PCT = 3;
const HARD_STOP_CEILING_PCT = -45;
const RUG_DROP_PCT = -60;
const LIQUIDITY_DROP_PCT = -40;
const TRAILING_ACTIVATION_PCT = 50;
const TRAIL_DEFAULT_PCT = 20;
const TRAIL_TIGHT_PCT = 15;
const TRAIL_TIGHTEN_PROFIT_PCT = 200;
const FLAT_MOVE_PCT = 5;
const MAX_CONSECUTIVE_NULL_PRICES = 5;

export class PositionManager {
  private db: AppDatabase | null = null;
  private wallets: WalletModel | null = null;
  private priceClient: JupiterClient = jupiterClient;
  private exitHandler: ExitHandler | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private nullPriceCounts = new Map<number, number>();

  configure(input: { db: AppDatabase; wallets?: WalletModel; priceClient?: JupiterClient; exitHandler?: ExitHandler }): void {
    this.db = input.db;
    this.wallets = input.wallets ?? null;
    this.priceClient = input.priceClient ?? jupiterClient;
    this.exitHandler = input.exitHandler ?? null;
  }

  start(): void {
    if (this.timer) return;
    if (this.db) {
      const audit = auditOpenPositions(this.db);
      if (audit.quarantined > 0) {
        logger.warn({ quarantined: audit.quarantined, reasons: audit.reasons }, "startup audit quarantined positions");
      }
    }
    this.timer = setInterval(() => {
      this.checkOpenPositions().catch((error) =>
        logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "position manager tick failed")
      );
    }, 30_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  openPosition(input: OpenPositionInput): PositionRow {
    const stopLossPrice = input.entryPriceUsd * 0.85;
    let result: { lastInsertRowid: number | bigint };
    try {
      result = this.requireDb()
        .prepare(
          `INSERT INTO positions
            (token_mint, token_symbol, entry_execution_id, convergence_id, amount_token, entry_price_usd,
             current_price_usd, stop_loss_price, take_profit_prices, trailing_stop_pct, peak_price_usd,
             time_stop_at, tier, status)
           VALUES
            (@tokenMint, @tokenSymbol, @entryExecutionId, @convergenceId, @amountToken, @entryPriceUsd,
             @entryPriceUsd, @stopLossPrice, @takeProfitPrices, @trailingStopPct, @entryPriceUsd,
             @timeStopAt, @tier, 'OPEN')`
        )
        .run({
          tokenMint: input.tokenMint,
          tokenSymbol: input.tokenSymbol ?? null,
          entryExecutionId: input.entryExecutionId,
          convergenceId: input.convergenceId,
          amountToken: input.amountToken,
          entryPriceUsd: input.entryPriceUsd,
          stopLossPrice,
          takeProfitPrices: JSON.stringify(takeProfitLadder()),
          trailingStopPct: TRAIL_DEFAULT_PCT,
          timeStopAt: unixNow() + timeStopSeconds(input.tier),
          tier: input.tier
        });
    } catch (error) {
      if (isSqliteConstraint(error)) {
        const existing = this.findOpenByMint(input.tokenMint);
        if (existing) {
          logger.info({ mint: input.tokenMint, positionId: existing.id }, "open position skipped; active position already exists for this token");
          return existing;
        }
      }
      throw error;
    }

    return this.findById(Number(result.lastInsertRowid))!;
  }

  async checkOpenPositions(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const positions = this.listOpen();
      for (const position of positions) {
        const price = await this.priceClient.getPriceUsd(position.token_mint);
        if (price === null) {
          const count = (this.nullPriceCounts.get(position.id) ?? 0) + 1;
          this.nullPriceCounts.set(position.id, count);
          if (count >= MAX_CONSECUTIVE_NULL_PRICES) {
            logger.error({ positionId: position.id, token: position.token_symbol, nullCount: count },
              "price feed dead — forced emergency exit");
            await this.exit(position, "PRICE_FEED_DEAD", 100, true);
            this.nullPriceCounts.delete(position.id);
          }
          continue;
        }
        // Insane prices and >100x ticks count toward the dead-feed counter
        // for the same reason nulls do: a feed stuck producing garbage leaves
        // the position unmanaged forever otherwise.
        if (!isSanePrice(price) || (position.current_price_usd && !isSanePriceChange(position.current_price_usd, price))) {
          const count = (this.nullPriceCounts.get(position.id) ?? 0) + 1;
          this.nullPriceCounts.set(position.id, count);
          logger.warn({ mint: position.token_mint, currentPrice: price, old: position.current_price_usd, badTickCount: count }, "price update rejected: insane value or >100x change");
          if (count >= MAX_CONSECUTIVE_NULL_PRICES) {
            logger.error({ positionId: position.id, token: position.token_symbol, badTickCount: count },
              "price feed dead (consecutive bad ticks) — forced emergency exit");
            await this.exit(position, "PRICE_FEED_DEAD", 100, true);
            this.nullPriceCounts.delete(position.id);
          }
          continue;
        }
        this.nullPriceCounts.delete(position.id);
        await this.onPriceUpdate(position, price);
      }
    } finally {
      this.checking = false;
    }
  }

  async onWhaleSell(walletAddress: string, tokenMint: string, sellPct: number): Promise<void> {
    if (sellPct < 20) return;
    const positions = this.listOpen().filter((position) => position.token_mint === tokenMint);
    if (positions.length === 0) return;
    if (this.wallets) {
      const quality = this.wallets.qualityFor([walletAddress]).get(walletAddress);
      if (quality && (quality.wallet_class === "loser" || quality.wallet_class === "accumulation_bot")) {
        logger.info({ wallet: walletAddress, mint: tokenMint, class: quality.wallet_class }, "whale sell ignored: untrusted wallet class");
        return;
      }
    }
    for (const position of positions) {
      const count = this.recordBehavioralSell(position.id, walletAddress);
      if (count >= 2) {
        await this.exit(position, "BEHAVIORAL_2_WHALES_SELLING", 100, false);
        this.deleteConfig(`position:${position.id}:pending_behavioral_exit_at`);
      } else {
        await this.exit(position, "BEHAVIORAL_WHALE_SELL_20_PCT", 50, false);
        this.setConfig(`position:${position.id}:pending_behavioral_exit_at`, String(unixNow() + 5 * 60));
      }
    }
  }

  findById(id: number): PositionRow | null {
    return (this.requireDb().prepare("SELECT * FROM positions WHERE id = ?").get(id) as PositionRow | undefined) ?? null;
  }

  findOpenByMint(tokenMint: string): PositionRow | null {
    return (
      this.requireDb()
        .prepare("SELECT * FROM positions WHERE token_mint = ? AND status IN ('OPEN','PARTIAL') ORDER BY opened_at ASC LIMIT 1")
        .get(tokenMint) as PositionRow | undefined
    ) ?? null;
  }

  markExit(position: PositionRow, remainingAmount: number, priceUsd: number, reason: string): void {
    const status = remainingAmount > 0 ? "PARTIAL" : "CLOSED";
    const pnlUsd = remainingAmount > 0 ? null : position.amount_token * (priceUsd - position.entry_price_usd);
    const pnlPct = remainingAmount > 0 ? null : ((priceUsd - position.entry_price_usd) / position.entry_price_usd) * 100;
    this.requireDb()
      .prepare(
        `UPDATE positions
         SET amount_token = ?, current_price_usd = ?, status = ?, exit_reason = ?,
             pnl_usd = COALESCE(?, pnl_usd), pnl_pct = COALESCE(?, pnl_pct),
             closed_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE closed_at END
         WHERE id = ?`
      )
      .run(remainingAmount, priceUsd, status, reason, pnlUsd, pnlPct, status, unixNow(), position.id);
  }

  private async onPriceUpdate(position: PositionRow, priceUsd: number): Promise<void> {
    const now = unixNow();

    if (await this.checkDollarStop(position, priceUsd)) return;

    const peak = Math.max(position.peak_price_usd ?? position.entry_price_usd, priceUsd);
    const profitPct = ((priceUsd - position.entry_price_usd) / position.entry_price_usd) * 100;
    const trailingActive = position.trailing_stop_active === 1 || profitPct >= TRAILING_ACTIVATION_PCT;
    const trailingPct = profitPct >= TRAIL_TIGHTEN_PROFIT_PCT ? TRAIL_TIGHT_PCT : TRAIL_DEFAULT_PCT;
    this.updatePriceState(position.id, priceUsd, peak, trailingActive, trailingPct);

    const pendingBehavioralExitAt = this.numberConfig(`position:${position.id}:pending_behavioral_exit_at`);
    if (pendingBehavioralExitAt && pendingBehavioralExitAt <= now) {
      await this.exit({ ...position, current_price_usd: priceUsd }, "BEHAVIORAL_REMAINING_EXIT", 100, false);
      this.deleteConfig(`position:${position.id}:pending_behavioral_exit_at`);
      return;
    }

    if (this.isRugEmergency(position, priceUsd, now)) {
      await this.exit(position, "RUG_EMERGENCY", 100, true);
      return;
    }
    if (this.isHardStop(position, priceUsd, now)) {
      await this.exit(position, "HARD_STOP_LOSS", 100, false);
      return;
    }
    if (trailingActive && priceUsd <= peak * (1 - trailingPct / 100)) {
      await this.exit(position, "TRAILING_STOP", 100, false);
      return;
    }
    const tp = this.nextTakeProfit(position, profitPct);
    if (tp) {
      await this.exit(position, `TAKE_PROFIT_${tp.targetPct}`, tp.sellPct, false);
      this.markTakeProfitExecuted(position.id, tp.targetPct);
      return;
    }
    if (position.time_stop_at && now >= position.time_stop_at && !this.isUptrend(position, peak, priceUsd)) {
      await this.exit(position, "TIME_STOP", 100, false);
      return;
    }
    if (now - position.opened_at >= 6 * 60 * 60 && Math.abs(profitPct) < FLAT_MOVE_PCT) {
      const sellPct = now - position.opened_at >= 24 * 60 * 60 ? 100 : 50;
      await this.exit(position, sellPct === 100 ? "FLAT_24H_EXIT" : "FLAT_6H_EXIT", sellPct, false);
    }
  }

  private isRugEmergency(position: PositionRow, priceUsd: number, _now: number): boolean {
    const profitPct = ((priceUsd - position.entry_price_usd) / position.entry_price_usd) * 100;
    if (profitPct <= RUG_DROP_PCT) return true;
    const liquidityDrop = this.numberConfig(`token:${position.token_mint}:liquidity_drop_pct`);
    return liquidityDrop !== null && liquidityDrop <= LIQUIDITY_DROP_PCT;
  }

  private isHardStop(position: PositionRow, priceUsd: number, now: number): boolean {
    const profitPct = ((priceUsd - position.entry_price_usd) / position.entry_price_usd) * 100;
    if (now - position.opened_at < 30 * 60) return profitPct <= FIRST_30_MIN_STOP_PCT;
    const atrStopPct = this.numberConfig(`token:${position.token_mint}:atr_stop_pct`) ?? HARD_STOP_FLOOR_PCT;
    const boundedStopPct = Math.max(HARD_STOP_CEILING_PCT, Math.min(HARD_STOP_FLOOR_PCT, atrStopPct));
    return profitPct <= boundedStopPct;
  }

  private nextTakeProfit(position: PositionRow, profitPct: number): TakeProfitLevel | null {
    const levels = parseTakeProfit(position.take_profit_prices);
    return levels.find((level) => !level.executed && profitPct >= level.targetPct) ?? null;
  }

  private markTakeProfitExecuted(positionId: number, targetPct: number): void {
    const position = this.findById(positionId);
    if (!position) return;
    const levels = parseTakeProfit(position.take_profit_prices).map((level) =>
      level.targetPct === targetPct ? { ...level, executed: true } : level
    );
    this.requireDb().prepare("UPDATE positions SET take_profit_prices = ? WHERE id = ?").run(JSON.stringify(levels), positionId);
  }

  private isUptrend(position: PositionRow, peak: number, priceUsd: number): boolean {
    return peak > (position.peak_price_usd ?? position.entry_price_usd) && priceUsd >= peak * 0.9;
  }

  private async exit(position: PositionRow, reason: string, sellPct: number, panicExit: boolean): Promise<void> {
    if (!this.exitHandler) {
      logger.warn({ positionId: position.id, reason }, "position exit requested before trade executor configured");
      return;
    }
    await this.exitHandler(position, reason, sellPct, panicExit);
  }

  private updatePriceState(positionId: number, priceUsd: number, peakPriceUsd: number, trailingActive: boolean, trailingPct: number): void {
    this.requireDb()
      .prepare(
        `UPDATE positions
         SET current_price_usd = ?, peak_price_usd = ?, trailing_stop_active = ?, trailing_stop_pct = ?
         WHERE id = ?`
      )
      .run(priceUsd, peakPriceUsd, trailingActive ? 1 : 0, trailingPct, positionId);
  }

  private async checkDollarStop(position: PositionRow, priceUsd: number): Promise<boolean> {
    const unrealizedLoss = position.amount_token * (position.entry_price_usd - priceUsd);
    if (unrealizedLoss <= 0) return false;
    const portfolioValue = this.portfolioValueUsd();
    if (portfolioValue <= 0) return false;
    if ((unrealizedLoss / portfolioValue) * 100 >= MAX_DOLLAR_LOSS_PORTFOLIO_PCT) {
      await this.exit(position, "DOLLAR_LOSS_CAP", 100, true);
      return true;
    }
    return false;
  }

  private portfolioValueUsd(): number {
    const db = this.requireDb();
    const openValue = (db.prepare(
      `SELECT COALESCE(SUM(amount_token * COALESCE(current_price_usd, entry_price_usd)), 0) AS value
       FROM positions WHERE status IN ('OPEN','PARTIAL')`
    ).get() as { value: number }).value ?? 0;
    const cashRow = db.prepare("SELECT value FROM execution_config WHERE key = 'paper_balance_usd'").get() as { value: string } | undefined;
    const cash = cashRow ? Number(cashRow.value) : config.execution.paperInitialBalance;
    return cash + openValue;
  }

  private listOpen(): PositionRow[] {
    return this.requireDb()
      .prepare("SELECT * FROM positions WHERE status IN ('OPEN','PARTIAL') ORDER BY opened_at ASC")
      .all() as PositionRow[];
  }

  private recordBehavioralSell(positionId: number, walletAddress: string): number {
    const key = `position:${positionId}:behavioral_sellers`;
    const existing = JSON.parse(this.stringConfig(key) ?? "[]") as string[];
    const sellers = [...new Set([...existing, walletAddress])];
    this.setConfig(key, JSON.stringify(sellers));
    return sellers.length;
  }

  private numberConfig(key: string): number | null {
    const value = this.stringConfig(key);
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private stringConfig(key: string): string | null {
    const row = this.requireDb().prepare("SELECT value FROM execution_config WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setConfig(key: string, value: string): void {
    this.requireDb()
      .prepare(
        `INSERT INTO execution_config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, unixNow());
  }

  private deleteConfig(key: string): void {
    this.requireDb().prepare("DELETE FROM execution_config WHERE key = ?").run(key);
  }

  private requireDb(): AppDatabase {
    if (!this.db) throw new Error("PositionManager is not configured");
    return this.db;
  }
}

function takeProfitLadder(): TakeProfitLevel[] {
  return [
    { targetPct: 50, sellPct: 25, executed: false },
    { targetPct: 150, sellPct: 30, executed: false },
    { targetPct: 400, sellPct: 25, executed: false },
    { targetPct: 800, sellPct: 15, executed: false }
  ];
}

function parseTakeProfit(raw: string | null): TakeProfitLevel[] {
  if (!raw) return takeProfitLadder();
  try {
    return JSON.parse(raw) as TakeProfitLevel[];
  } catch {
    return takeProfitLadder();
  }
}

function timeStopSeconds(tier: AlertTier): number {
  if (tier === "WATCH") return 24 * 60 * 60;
  if (tier === "NOTABLE") return 72 * 60 * 60;
  return 7 * 24 * 60 * 60;
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    ((error as { code: string }).code === "SQLITE_CONSTRAINT" ||
      (error as { code: string }).code.startsWith("SQLITE_CONSTRAINT_"))
  );
}

export const positionManager = new PositionManager();
