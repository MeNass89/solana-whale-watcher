import type { AppDatabase } from "../storage/database.js";
import type { TradeRow } from "../storage/models/trades.js";
import type { WalletModel } from "../storage/models/wallets.js";
import { logger } from "../utils/logger.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Circuit breaker: enrollment gates can't catch a wallet that changes regime
// after enrollment (observed live 2026-07-12: 8aKGXJkq went from ~1 buy/day
// to 200+/day and bled -55k paper before manual intervention). Either trip
// marks the wallet DORMANT until a human revives it.
const BREAKER_MAX_ENTRIES_24H = 12;
const BREAKER_MAX_CONSECUTIVE_STOPS = 8;

type FollowerAlerter = {
  send(payload: Record<string, unknown>, tier: "CRITICAL" | "NOTABLE" | "WATCH"): Promise<boolean>;
};

type FollowerSwapClient = {
  executeSwap(params: {
    inputMint: string;
    outputMint: string;
    amountLamports: bigint;
    slippageBps: number;
  }): Promise<{ txSignature: string; outputAmount: number; priceImpactPct: number; executedAt: number }>;
  getExitPriceUsd(mint: string, amountToken: number): Promise<number | null>;
};

type RecipeRow = {
  id: string;
  wallet_address: string;
  take_profit_pct: number;
  stop_loss_pct: number;
  max_hold_seconds: number;
  notional_usd: number;
};

type FollowerPositionRow = {
  id: number;
  signal_id: number;
  recipe_id: string;
  wallet_address: string;
  token_mint: string;
  amount_token: number;
  entry_price_usd: number;
  current_price_usd: number | null;
  peak_price_usd: number | null;
  trough_price_usd: number | null;
  take_profit_price: number;
  stop_loss_price: number;
  max_hold_at: number;
  opened_at: number;
  exit_check_failed_at: number | null;
};

export class FollowerEngine {
  private readonly db: AppDatabase;
  private readonly wallets: WalletModel;
  private readonly swaps: FollowerSwapClient;
  private readonly alerts?: FollowerAlerter;
  private readonly entriesInFlight = new Set<string>();
  private checksInFlight = false;

  constructor(input: { db: AppDatabase; wallets: WalletModel; swaps: FollowerSwapClient; alerts?: FollowerAlerter }) {
    this.db = input.db;
    this.wallets = input.wallets;
    this.swaps = input.swaps;
    this.alerts = input.alerts;
  }

  async onTrade(trade: TradeRow, webhookReceivedAt = Math.floor(Date.now() / 1000)): Promise<void> {
    if (trade.trade_type !== "BUY") return;
    const wallet = this.wallets.find(trade.wallet_address);
    if (!wallet || wallet.monitor_policy !== "pinned" || wallet.state === "DORMANT") return;
    const recipe = this.recipeForWallet(trade.wallet_address);
    if (!recipe) {
      logger.warn({ wallet: trade.wallet_address }, "follower: pinned wallet has no frozen recipe");
      return;
    }
    const tripped = this.circuitBreakerReason(trade.wallet_address, webhookReceivedAt);
    if (tripped) {
      this.tripCircuitBreaker(trade, recipe, webhookReceivedAt, tripped);
      return;
    }
    if (this.hasOpenPosition(trade.wallet_address, trade.token_mint)) {
      logger.info({ wallet: trade.wallet_address, mint: trade.token_mint }, "follower: duplicate open wallet/mint skipped");
      return;
    }
    if (this.openPositionCount(trade.wallet_address) >= 3) {
      this.createSkippedSignal(trade, recipe, webhookReceivedAt, "CONCURRENCY_CAP");
      return;
    }

    const key = `${trade.wallet_address}\0${trade.token_mint}`;
    if (this.entriesInFlight.has(key)) return;
    this.entriesInFlight.add(key);
    try {
      await this.executeEntry(trade, recipe, webhookReceivedAt);
    } finally {
      this.entriesInFlight.delete(key);
    }
  }

  async checkOpenPositions(now = Math.floor(Date.now() / 1000)): Promise<void> {
    if (this.checksInFlight) return;
    this.checksInFlight = true;
    try {
      const positions = this.db
        .prepare("SELECT * FROM follower_positions WHERE status = 'OPEN' ORDER BY opened_at ASC")
        .all() as FollowerPositionRow[];
      for (const position of positions) {
        const price = await this.swaps.getExitPriceUsd(position.token_mint, position.amount_token).catch(() => null);
        if (!price || !Number.isFinite(price) || price <= 0) {
          this.markExitCheckFailed(position.id, now);
          continue;
        }
        this.updateMark(position, price);
        if (price >= position.take_profit_price) {
          this.closePosition(position, price, "TAKE_PROFIT", now, position.exit_check_failed_at !== null);
        } else if (price <= position.stop_loss_price) {
          this.closePosition(position, price, "STOP_LOSS", now, position.exit_check_failed_at !== null);
        } else if (now >= position.max_hold_at) {
          this.closePosition(position, price, "TIME_STOP", now, position.exit_check_failed_at !== null || now > position.max_hold_at + 90);
        } else {
          this.clearExitCheckFailed(position.id);
        }
      }
    } finally {
      this.checksInFlight = false;
    }
  }

  private async executeEntry(trade: TradeRow, recipe: RecipeRow, webhookReceivedAt: number): Promise<void> {
    const signalId = this.createSignal(trade, recipe, webhookReceivedAt);
    const requestedAt = Math.floor(Date.now() / 1000);
    const executionId = this.createExecution(signalId, "BUY", trade.token_mint, recipe.notional_usd, requestedAt);
    try {
      const result = await this.swaps.executeSwap({
        inputMint: USDC_MINT,
        outputMint: trade.token_mint,
        amountLamports: BigInt(Math.round(recipe.notional_usd * 1_000_000)),
        slippageBps: 300
      });
      if (!Number.isFinite(result.outputAmount) || result.outputAmount <= 0) {
        throw new Error(`follower entry returned non-positive outputAmount: ${result.outputAmount}`);
      }
      const fillPrice = recipe.notional_usd / result.outputAmount;
      const respondedAt = Math.floor(Date.now() / 1000);
      const applyFill = this.db.transaction(() => {
        // Re-checked at fill time: the swap is async, so the breaker can trip
        // (or a concurrent fill can cross the cadence cap) while this entry is
        // in flight. The transaction is synchronous on a single connection,
        // which makes this check atomic with the position insert.
        const walletNow = this.wallets.find(trade.wallet_address);
        if (walletNow?.state === "DORMANT" || this.circuitBreakerReason(trade.wallet_address, respondedAt)) {
          this.markSkipped(signalId, executionId, "CIRCUIT_BREAKER", requestedAt, respondedAt);
          return;
        }
        if (this.openPositionCount(trade.wallet_address) >= 3) {
          this.markSkipped(signalId, executionId, "CONCURRENCY_CAP", requestedAt, respondedAt);
          return;
        }
        this.db
          .prepare(
            `UPDATE follower_executions
             SET amount_token = ?, price_usd = ?, tx_signature = ?, status = 'FILLED',
                 quote_responded_at = ?, closed_at = ?
             WHERE id = ?`
          )
          .run(result.outputAmount, fillPrice, result.txSignature, respondedAt, respondedAt, executionId);
        this.db
          .prepare(
            `UPDATE follower_signals
             SET status = 'FILLED', quote_requested_at = ?, quote_responded_at = ?,
                 quoted_route = ?, quoted_price_usd = ?, fill_price_usd = ?,
                 mark_price_usd = ?, entry_latency_seconds = ?
             WHERE id = ?`
          )
          .run(
            requestedAt,
            respondedAt,
            JSON.stringify({ input: USDC_MINT, output: trade.token_mint, priceImpactPct: result.priceImpactPct }),
            fillPrice,
            fillPrice,
            fillPrice,
            Math.max(0, result.executedAt - trade.block_time),
            signalId
          );
        this.db
          .prepare(
            `INSERT INTO follower_positions
              (signal_id, recipe_id, wallet_address, token_mint, amount_token, entry_price_usd,
               current_price_usd, peak_price_usd, trough_price_usd, mae_pct, mfe_pct,
               take_profit_price, stop_loss_price, max_hold_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
          )
          .run(
            signalId,
            recipe.id,
            trade.wallet_address,
            trade.token_mint,
            result.outputAmount,
            fillPrice,
            fillPrice,
            fillPrice,
            fillPrice,
            fillPrice * (1 + recipe.take_profit_pct / 100),
            fillPrice * (1 + recipe.stop_loss_pct / 100),
            result.executedAt + recipe.max_hold_seconds
          );
      });
      applyFill();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const respondedAt = Math.floor(Date.now() / 1000);
      const markSkip = this.db.transaction(() => {
        this.db
          .prepare("UPDATE follower_executions SET status = 'SKIPPED', reason = ?, quote_responded_at = ?, closed_at = ? WHERE id = ?")
          .run(reason, respondedAt, respondedAt, executionId);
        this.db
          .prepare("UPDATE follower_signals SET status = 'SKIPPED', skip_reason = ?, quote_requested_at = ?, quote_responded_at = ? WHERE id = ?")
          .run(reason, requestedAt, respondedAt, signalId);
      });
      markSkip();
      logger.warn({ wallet: trade.wallet_address, mint: trade.token_mint, reason }, "follower: entry skipped");
    }
  }

  private circuitBreakerReason(walletAddress: string, now: number): string | null {
    const entries = this.db
      .prepare("SELECT COUNT(*) AS count FROM follower_positions WHERE wallet_address = ? AND opened_at > ?")
      .get(walletAddress, now - 86_400) as { count: number };
    if (entries.count >= BREAKER_MAX_ENTRIES_24H) {
      return `${entries.count} entries in 24h (max ${BREAKER_MAX_ENTRIES_24H})`;
    }
    const recent = this.db
      .prepare(
        `SELECT exit_reason FROM follower_positions
         WHERE wallet_address = ? AND status = 'CLOSED'
         ORDER BY closed_at DESC, id DESC LIMIT ?`
      )
      .all(walletAddress, BREAKER_MAX_CONSECUTIVE_STOPS) as { exit_reason: string }[];
    if (recent.length === BREAKER_MAX_CONSECUTIVE_STOPS && recent.every((row) => row.exit_reason === "STOP_LOSS")) {
      return `${BREAKER_MAX_CONSECUTIVE_STOPS} consecutive stop-losses`;
    }
    return null;
  }

  private markSkipped(signalId: number, executionId: number, reason: string, requestedAt: number, respondedAt: number): void {
    this.db
      .prepare("UPDATE follower_executions SET status = 'SKIPPED', reason = ?, quote_responded_at = ?, closed_at = ? WHERE id = ?")
      .run(reason, respondedAt, respondedAt, executionId);
    this.db
      .prepare("UPDATE follower_signals SET status = 'SKIPPED', skip_reason = ?, quote_requested_at = ?, quote_responded_at = ? WHERE id = ?")
      .run(reason, requestedAt, respondedAt, signalId);
  }

  private tripCircuitBreaker(trade: TradeRow, recipe: RecipeRow, webhookReceivedAt: number, reason: string): void {
    this.wallets.update(trade.wallet_address, { state: "DORMANT", active: false });
    this.createSkippedSignal(trade, recipe, webhookReceivedAt, "CIRCUIT_BREAKER");
    logger.warn({ wallet: trade.wallet_address, reason }, "follower: circuit breaker tripped — wallet marked DORMANT");
    void this.alerts?.send({
      embeds: [{
        title: "⛔ Follower Circuit Breaker",
        description: `Wallet \`${trade.wallet_address.substring(0, 8)}…\` marked DORMANT: ${reason}. Manual revive required.`,
        color: 0xff3366,
        timestamp: new Date().toISOString()
      }]
    }, "CRITICAL").catch(() => {});
  }

  private createSignal(trade: TradeRow, recipe: RecipeRow, webhookReceivedAt: number): number {
    const result = this.db
      .prepare(
        `INSERT INTO follower_signals
          (trade_id, source_tx_signature, wallet_address, token_mint, recipe_id, block_time, webhook_received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(trade.id, trade.tx_signature, trade.wallet_address, trade.token_mint, recipe.id, trade.block_time, webhookReceivedAt);
    return Number(result.lastInsertRowid);
  }

  private createSkippedSignal(trade: TradeRow, recipe: RecipeRow, webhookReceivedAt: number, reason: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO follower_signals
          (trade_id, source_tx_signature, wallet_address, token_mint, recipe_id, block_time, webhook_received_at, status, skip_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'SKIPPED', ?)`
      )
      .run(trade.id, trade.tx_signature, trade.wallet_address, trade.token_mint, recipe.id, trade.block_time, webhookReceivedAt, reason);
    return Number(result.lastInsertRowid);
  }

  private createExecution(signalId: number, direction: "BUY" | "SELL", tokenMint: string, amountUsd: number, requestedAt: number): number {
    const result = this.db
      .prepare(
        `INSERT INTO follower_executions
          (signal_id, direction, token_mint, amount_usd, status, quote_requested_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?)`
      )
      .run(signalId, direction, tokenMint, amountUsd, requestedAt);
    return Number(result.lastInsertRowid);
  }

  private closePosition(position: FollowerPositionRow, price: number, reason: string, now: number, degraded: boolean): boolean {
    const pnlUsd = position.amount_token * (price - position.entry_price_usd);
    const pnlPct = ((price - position.entry_price_usd) / position.entry_price_usd) * 100;
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE follower_positions
           SET status = 'CLOSED', exit_reason = ?, exit_price_usd = ?, exit_degraded = ?,
               pnl_usd = ?, pnl_pct = ?, current_price_usd = ?, closed_at = ?
           WHERE id = ? AND status = 'OPEN'`
        )
        .run(reason, price, degraded ? 1 : 0, pnlUsd, pnlPct, price, now, position.id);
      if (result.changes !== 1) return false;
      this.db
        .prepare(
          `INSERT INTO follower_executions
            (signal_id, direction, token_mint, amount_token, amount_usd, price_usd, status, reason, closed_at)
           VALUES (?, 'SELL', ?, ?, ?, ?, 'FILLED', ?, ?)`
        )
        .run(position.signal_id, position.token_mint, position.amount_token, position.amount_token * price, price, reason, now);
      return true;
    });
    return tx();
  }

  private updateMark(position: FollowerPositionRow, price: number): void {
    const peak = Math.max(position.peak_price_usd ?? position.entry_price_usd, price);
    const trough = Math.min(position.trough_price_usd ?? position.entry_price_usd, price);
    const mfePct = ((peak - position.entry_price_usd) / position.entry_price_usd) * 100;
    const maePct = ((trough - position.entry_price_usd) / position.entry_price_usd) * 100;
    this.db
      .prepare("UPDATE follower_positions SET current_price_usd = ?, peak_price_usd = ?, trough_price_usd = ?, mfe_pct = ?, mae_pct = ?, exit_check_failed_at = NULL WHERE id = ?")
      .run(price, peak, trough, mfePct, maePct, position.id);
  }

  private markExitCheckFailed(positionId: number, now: number): void {
    this.db.prepare("UPDATE follower_positions SET exit_check_failed_at = COALESCE(exit_check_failed_at, ?) WHERE id = ? AND status = 'OPEN'").run(now, positionId);
  }

  private clearExitCheckFailed(positionId: number): void {
    this.db.prepare("UPDATE follower_positions SET exit_check_failed_at = NULL WHERE id = ? AND status = 'OPEN'").run(positionId);
  }

  private hasOpenPosition(walletAddress: string, tokenMint: string): boolean {
    const row = this.db
      .prepare("SELECT id FROM follower_positions WHERE wallet_address = ? AND token_mint = ? AND status = 'OPEN'")
      .get(walletAddress, tokenMint) as { id: number } | undefined;
    return Boolean(row);
  }

  private openPositionCount(walletAddress: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM follower_positions WHERE wallet_address = ? AND status = 'OPEN'")
      .get(walletAddress) as { count: number };
    return Number(row.count);
  }

  private recipeForWallet(walletAddress: string): RecipeRow | null {
    return (this.db.prepare("SELECT * FROM follower_recipes WHERE wallet_address = ? AND frozen = 1").get(walletAddress) as RecipeRow | undefined) ?? null;
  }
}
