import { config } from "../config/index.js";
import { DiscordAlerter } from "../alerts/discord.js";
import type { AppDatabase } from "../storage/database.js";
import type { ConvergenceRow } from "../storage/models/convergences.js";
import type { TradeRow } from "../storage/models/trades.js";
import { formatUsd, truncateAddress, unixNow } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import type { PositionManager, PositionRow } from "./position-manager.js";
import { positionManager } from "./position-manager.js";
import type { JupiterClient } from "./jupiter-client.js";
import { jupiterClient, USDC_MINT } from "./jupiter-client.js";
import { riskEngine, type RiskEngine } from "./risk-engine.js";
import type { TokenDecimalsResolver } from "../blockchain/token-decimals.js";
import { tokenDecimalsResolver } from "../blockchain/token-decimals.js";

const NOTABLE_ENTRY_DELAY_MS = 12_000;
const CRITICAL_MAX_SIGNAL_AGE_SECONDS = 45 * 60;
const NOTABLE_MAX_SIGNAL_AGE_SECONDS = 90 * 60;
const NOTABLE_MAX_ADVERSE_MOVE_PCT = 3;
const STALE_PENDING_MAX_AGE_MINUTES = 15;

function isUniqueViolation(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException & { code?: string })?.code;
  const msg = error instanceof Error ? error.message : "";
  return code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(msg);
}

// Pump.fun mints share a "...pump" suffix. We do not trade them: timing is
// sub-second-sensitive and our pipeline (Helius webhook → 12s NOTABLE delay →
// Jupiter swap) is too slow to compete with snipers on these tokens.
function isPumpFunMint(mint: string): boolean {
  return mint.endsWith("pump");
}

export class TradeExecutor {
  private db: AppDatabase | null = null;
  private swaps: JupiterClient = jupiterClient;
  private risk: RiskEngine = riskEngine;
  private positions: PositionManager = positionManager;
  private decimals: TokenDecimalsResolver = tokenDecimalsResolver;
  private discord = new DiscordAlerter();
  // In-flight guards. The entry pipeline awaits network calls between its DB
  // dedup checks and its DB writes, so two convergences on the same token can
  // interleave and both pass the checks; same story for concurrent exits
  // (whale-sell webhook vs 30s tick) on one position.
  private entriesInFlight = new Set<string>();
  private exitsInFlight = new Set<number>();

  configure(input: {
    db: AppDatabase;
    swaps?: JupiterClient;
    risk?: RiskEngine;
    positions?: PositionManager;
    decimals?: TokenDecimalsResolver;
    discord?: DiscordAlerter;
  }): void {
    this.db = input.db;
    this.swaps = input.swaps ?? jupiterClient;
    this.risk = input.risk ?? riskEngine;
    this.positions = input.positions ?? positionManager;
    this.decimals = input.decimals ?? tokenDecimalsResolver;
    this.discord = input.discord ?? new DiscordAlerter();
  }

  async onConvergence(convergence: ConvergenceRow, trades: TradeRow[]): Promise<void> {
    if (!config.execution.enabled) return;
    if (convergence.tier === "WATCH") return;

    if (isPumpFunMint(convergence.token_mint)) {
      logger.info(
        { convergenceId: convergence.id, mint: convergence.token_mint, tier: convergence.tier },
        "execution skipped: pump.fun token (sub-second timing required, out of scope)"
      );
      return;
    }

    if (this.entriesInFlight.has(convergence.token_mint)) {
      logger.info({ convergenceId: convergence.id, mint: convergence.token_mint }, "execution skipped; entry already in flight for this token");
      return;
    }
    this.entriesInFlight.add(convergence.token_mint);
    try {
      await this.executeEntry(convergence, trades);
    } finally {
      this.entriesInFlight.delete(convergence.token_mint);
    }
  }

  private async executeEntry(convergence: ConvergenceRow, trades: TradeRow[]): Promise<void> {
    const existing = this.requireDb()
      .prepare("SELECT id FROM executions WHERE convergence_id = ? AND direction = 'BUY' AND status IN ('PENDING','FILLED')")
      .get(convergence.id) as { id: number } | undefined;
    if (existing) {
      logger.debug({ convergenceId: convergence.id }, "execution already exists for convergence, skipping");
      return;
    }

    const existingPosition = this.requireDb()
      .prepare("SELECT id FROM positions WHERE token_mint = ? AND status IN ('OPEN','PARTIAL')")
      .get(convergence.token_mint) as { id: number } | undefined;
    if (existingPosition) {
      logger.info({ mint: convergence.token_mint, positionId: existingPosition.id }, "execution skipped; open position already exists for this token");
      return;
    }

    if (this.isStale(convergence)) {
      logger.info({ convergenceId: convergence.id, tier: convergence.tier }, "execution skipped for stale convergence");
      return;
    }

    const initialPrice = await this.swaps.getPriceUsd(convergence.token_mint);
    if (!initialPrice) {
      logger.warn({ mint: convergence.token_mint }, "execution skipped; entry price unavailable");
      return;
    }

    if (convergence.tier === "NOTABLE") {
      await sleep(NOTABLE_ENTRY_DELAY_MS);
      const delayedPrice = await this.swaps.getPriceUsd(convergence.token_mint);
      if (!delayedPrice) return;
      const adverseMovePct = ((delayedPrice - initialPrice) / initialPrice) * 100;
      if (adverseMovePct > NOTABLE_MAX_ADVERSE_MOVE_PCT) {
        logger.info({ mint: convergence.token_mint, adverseMovePct }, "execution skipped; notable moved adverse before entry");
        return;
      }
    }

    let entryPrice: number;
    let risk: Awaited<ReturnType<typeof this.risk.checkEntry>>;
    try {
      entryPrice = (await this.swaps.getPriceUsd(convergence.token_mint)) ?? initialPrice;
      risk = await this.risk.checkEntry(convergence, trades, entryPrice);
    } catch (error) {
      logger.error({ err: error instanceof Error ? error : new Error(String(error)), convergenceId: convergence.id }, "execution skipped; risk pre-check failed");
      await this.notify("ENTRY_FAILED", convergence, [{ name: "Error", value: `pre-check error: ${error instanceof Error ? error.message : String(error)}`, inline: false }]);
      return;
    }
    if (!risk.allowed || !risk.adjustedSizePct || !risk.sizeUsd) {
      logger.info({ convergenceId: convergence.id, reason: risk.reason }, "execution rejected by risk engine");
      await this.notify("ENTRY_REJECTED", convergence, [{ name: "Reason", value: risk.reason ?? "unknown", inline: false }]);
      return;
    }

    const liquidityUsd = risk.liquidityUsd ?? null;
    const slippageBps = this.swaps.slippageBpsForLiquidity(liquidityUsd);
    if (slippageBps === null) {
      logger.info({ mint: convergence.token_mint, liquidityUsd }, "execution skipped; liquidity below minimum");
      return;
    }

    let executionId: number;
    try {
      executionId = this.createExecution({
        convergence,
        direction: "BUY",
        amountUsd: risk.sizeUsd,
        priceUsd: entryPrice,
        status: "PENDING",
        sizePct: risk.adjustedSizePct
      });
    } catch (error) {
      // The partial unique index on live BUYs (one PENDING/FILLED BUY per
      // token) is the DB-level backstop against duplicate entries.
      if (isUniqueViolation(error)) {
        logger.info({ convergenceId: convergence.id, mint: convergence.token_mint }, "execution skipped; live BUY already exists for this token (unique index)");
        return;
      }
      throw error;
    }

    try {
      const result = await this.swaps.executeSwap({
        inputMint: USDC_MINT,
        outputMint: convergence.token_mint,
        amountLamports: BigInt(Math.round(risk.sizeUsd * 1_000_000)),
        slippageBps,
        tier: convergence.tier
      });
      // Mirror the SELL phantom-exit guard: a non-positive outputAmount means
      // the swap didn't actually deliver. Recording a fill anyway opens a NaN
      // position, debits paper balance, and trips dedup on later signals.
      if (!Number.isFinite(result.outputAmount) || result.outputAmount <= 0) {
        throw new Error(`entry swap returned non-positive outputAmount: ${result.outputAmount}`);
      }
      const amountToken = result.outputAmount;
      const actualEntryPrice = risk.sizeUsd / amountToken;
      // Fill + balance debit + position open commit atomically: a crash
      // between them would otherwise leave a paid-for fill with no position
      // (or an unpaid position). Network I/O stays outside the transaction.
      const sizeUsd = risk.sizeUsd;
      const applyEntryFill = this.requireDb().transaction(() => {
        this.fillExecution(executionId, {
          direction: "BUY",
          amountToken,
          amountUsd: sizeUsd,
          priceUsd: actualEntryPrice,
          txSignature: result.txSignature
        });
        if (config.execution.mode === "paper") this.risk.updatePaperBalance(-sizeUsd);
        return this.positions.openPosition({
          tokenMint: convergence.token_mint,
          tokenSymbol: convergence.token_symbol,
          entryExecutionId: executionId,
          convergenceId: convergence.id,
          amountToken,
          entryPriceUsd: actualEntryPrice,
          tier: convergence.tier
        });
      });
      const position = applyEntryFill();
      try {
        await this.notify("ENTRY_FILLED", convergence, [
          { name: "Mode", value: config.execution.mode.toUpperCase(), inline: true },
          { name: "Size", value: `${formatUsd(risk.sizeUsd)} (${risk.adjustedSizePct.toFixed(2)}%)`, inline: true },
          { name: "Entry", value: formatUsd(actualEntryPrice), inline: true },
          { name: "Stop", value: formatUsd(position.stop_loss_price), inline: true },
          { name: "Position", value: String(position.id), inline: true }
        ]);
      } catch (notifyErr) {
        logger.warn({ err: notifyErr }, "trade-executor: entry notification failed (non-fatal)");
      }
    } catch (error) {
      this.failExecution(executionId, error);
      this.risk.recordFailedTransaction();
      logger.error({ error, convergenceId: convergence.id }, "execution failed");
      await this.notify("ENTRY_FAILED", convergence, [{ name: "Error", value: String(error), inline: false }]);
    }
  }

  /** Returns true only when the exit actually settled (fill or dust-close). */
  async exitPosition(position: PositionRow, reason: string, sellPct: number, panicExit = false): Promise<boolean> {
    if (!config.execution.enabled) return false;
    if (this.exitsInFlight.has(position.id)) {
      logger.info({ positionId: position.id, reason }, "exit skipped; another exit already in flight for this position");
      return false;
    }
    this.exitsInFlight.add(position.id);
    try {
      return await this.executeExit(position, reason, sellPct, panicExit);
    } finally {
      this.exitsInFlight.delete(position.id);
    }
  }

  private async executeExit(position: PositionRow, reason: string, sellPct: number, panicExit: boolean): Promise<boolean> {
    const current = this.positions.findById(position.id);
    if (!current || current.status === "CLOSED" || current.amount_token <= 0) return false;
    const priceUsd = (await this.swaps.getPriceUsd(current.token_mint)) ?? current.current_price_usd ?? current.entry_price_usd;
    const sellAmountToken = current.amount_token * Math.min(100, Math.max(0, sellPct)) / 100;
    if (sellAmountToken <= 0) return false;

    const amountUsd = sellAmountToken * priceUsd;
    const exitLiquidityUsd = await this.risk.tokenLiquidityLive(current.token_mint);
    // Panic exits prefer "execute at any reasonable price" over "miss the exit
    // entirely"; widen the fallback to 20% when liquidity is unknown.
    const fallbackBps = panicExit ? 2000 : 500;
    const slippageBps = this.swaps.slippageBpsForLiquidity(exitLiquidityUsd) ?? fallbackBps;

    let decimals: number;
    try {
      decimals = Math.max(0, Math.trunc(await this.decimals.resolve(current.token_mint)));
    } catch (error) {
      // A guessed scale sells 1000x too much or too little; failing the exit
      // (it retries next tick) is strictly safer than defaulting.
      logger.error(
        { positionId: current.id, mint: current.token_mint, err: error instanceof Error ? error : new Error(String(error)) },
        "position exit failed: token decimals unresolvable"
      );
      return false;
    }
    const scale = 10n ** BigInt(decimals);
    let total: bigint;
    if (!Number.isFinite(sellAmountToken) || sellAmountToken <= 0) {
      total = 1n;
    } else {
      const flooredTokenAmount = Math.floor(sellAmountToken);
      const intPart = BigInt(flooredTokenAmount);
      const fracPart = sellAmountToken - flooredTokenAmount;
      const fracBaseUnits = BigInt(Math.floor(fracPart * Number(scale)));
      total = intPart * scale + fracBaseUnits;
    }
    if (total < 1n) {
      logger.info(
        { positionId: current.id, sellAmountToken, decimals },
        "exit closed (dust): requested amount rounds to zero base units"
      );
      this.positions.markExit(current, 0, priceUsd, `${reason}_DUST_CLOSE`);
      return true;
    }
    const amountLamports = total;
    const actualSellTokenAmount = Number(amountLamports) / Number(scale);

    const executionId = this.createExecution({
      convergence: {
        id: current.convergence_id ?? 0,
        token_mint: current.token_mint,
        token_symbol: current.token_symbol,
        tier: current.tier
      },
      direction: "SELL",
      amountUsd,
      priceUsd,
      status: "PENDING",
      exitReason: reason
    });

    try {
      const result = await this.swaps.executeSwap({
        inputMint: current.token_mint,
        outputMint: USDC_MINT,
        amountLamports,
        slippageBps,
        isExitSwap: true,
        panicExit,
        tier: current.tier
      });
      // outputAmount <= 0 means the swap did not actually deliver — falling back
      // to amountUsd would record a phantom exit at the pre-trade mark price.
      // Treat as failure so the position stays OPEN and can be retried.
      if (!Number.isFinite(result.outputAmount) || result.outputAmount <= 0) {
        throw new Error(`exit swap returned non-positive outputAmount: ${result.outputAmount}`);
      }
      const exitUsd = result.outputAmount;
      const exitPrice = actualSellTokenAmount > 0 ? exitUsd / actualSellTokenAmount : priceUsd;
      const pnlUsd = actualSellTokenAmount * (exitPrice - current.entry_price_usd);
      const pnlPct = ((exitPrice - current.entry_price_usd) / current.entry_price_usd) * 100;
      // Fill + balance credit + position update commit atomically (see entry).
      const applyExitFill = this.requireDb().transaction(() => {
        this.fillExecution(executionId, {
          direction: "SELL",
          amountToken: actualSellTokenAmount,
          amountUsd: exitUsd,
          priceUsd: exitPrice,
          txSignature: result.txSignature,
          pnlUsd,
          pnlPct,
          exitReason: reason
        });
        if (config.execution.mode === "paper") this.risk.updatePaperBalance(exitUsd);
        const remaining = Math.max(0, current.amount_token - actualSellTokenAmount);
        this.positions.markExit(current, remaining, exitPrice, reason);
      });
      applyExitFill();
      try {
        await this.notifyPositionExit(current, reason, pnlUsd, pnlPct);
      } catch (notifyErr) {
        logger.warn({ err: notifyErr, positionId: current.id }, "trade-executor: exit notification failed (non-fatal)");
      }
      return true;
    } catch (error) {
      this.failExecution(executionId, error);
      this.risk.recordFailedTransaction();
      logger.error({ error, positionId: current.id }, "position exit failed");
      return false;
    }
  }

  private createExecution(input: {
    convergence: Pick<ConvergenceRow, "id" | "token_mint" | "token_symbol" | "tier">;
    direction: "BUY" | "SELL";
    amountUsd: number;
    priceUsd: number;
    status: "PENDING";
    sizePct?: number;
    exitReason?: string;
  }): number {
    const result = this.requireDb()
      .prepare(
        `INSERT INTO executions
          (convergence_id, token_mint, token_symbol, direction, amount_usd, entry_price_usd,
           exit_price_usd, status, exit_reason, tier, position_size_pct)
         VALUES
          (@convergenceId, @tokenMint, @tokenSymbol, @direction, @amountUsd, @entryPriceUsd,
           @exitPriceUsd, @status, @exitReason, @tier, @positionSizePct)`
      )
      .run({
        convergenceId: input.convergence.id || null,
        tokenMint: input.convergence.token_mint,
        tokenSymbol: input.convergence.token_symbol,
        direction: input.direction,
        amountUsd: input.amountUsd,
        entryPriceUsd: input.direction === "BUY" ? input.priceUsd : null,
        exitPriceUsd: input.direction === "SELL" ? input.priceUsd : null,
        status: input.status,
        exitReason: input.exitReason ?? null,
        tier: input.convergence.tier,
        positionSizePct: input.sizePct ?? null
      });
    return Number(result.lastInsertRowid);
  }

  private fillExecution(
    id: number,
    fill: {
      direction: "BUY" | "SELL";
      amountToken: number;
      amountUsd: number;
      priceUsd: number;
      txSignature: string;
      pnlUsd?: number;
      pnlPct?: number;
      exitReason?: string;
    }
  ): void {
    const isBuy = fill.direction === "BUY";
    this.requireDb()
      .prepare(
        `UPDATE executions
         SET amount_token = ?, amount_usd = ?,
             entry_price_usd = ?,
             exit_price_usd = ?,
             pnl_usd = ?, pnl_pct = ?, tx_signature = ?, status = 'FILLED',
             exit_reason = COALESCE(?, exit_reason), closed_at = unixepoch()
         WHERE id = ?`
      )
      .run(
        fill.amountToken,
        fill.amountUsd,
        isBuy ? fill.priceUsd : null,
        isBuy ? null : fill.priceUsd,
        fill.pnlUsd ?? null,
        fill.pnlPct ?? null,
        fill.txSignature,
        fill.exitReason ?? null,
        id
      );
  }

  private failExecution(id: number, error: unknown): void {
    this.requireDb()
      .prepare("UPDATE executions SET status = 'FAILED', exit_reason = ?, closed_at = unixepoch() WHERE id = ?")
      .run(String(error), id);
  }

  /**
   * Marks PENDING executions older than the cutoff as FAILED. A crash between
   * createExecution and the fill/fail update leaves PENDING rows that block
   * convergence retries and (for BUYs) hold the per-token unique slot forever.
   * Run at startup and periodically.
   */
  reapStalePendingExecutions(maxAgeMinutes = STALE_PENDING_MAX_AGE_MINUTES): number {
    const cutoff = unixNow() - maxAgeMinutes * 60;
    const result = this.requireDb()
      .prepare(
        `UPDATE executions
         SET status = 'FAILED',
             exit_reason = COALESCE(exit_reason || ' | ', '') || 'STALE_PENDING_REAPED',
             closed_at = unixepoch()
         WHERE status = 'PENDING' AND created_at < ?`
      )
      .run(cutoff);
    if (result.changes > 0) {
      logger.warn({ reaped: result.changes, maxAgeMinutes }, "trade-executor: stale PENDING executions marked FAILED");
    }
    return result.changes;
  }

  private isStale(convergence: ConvergenceRow): boolean {
    const ageSeconds = unixNow() - convergence.first_trade_at;
    if (convergence.tier === "CRITICAL") return ageSeconds > CRITICAL_MAX_SIGNAL_AGE_SECONDS;
    if (convergence.tier === "NOTABLE") return ageSeconds > NOTABLE_MAX_SIGNAL_AGE_SECONDS;
    return false;
  }

  private async notify(
    title: string,
    convergence: Pick<ConvergenceRow, "token_mint" | "token_symbol" | "tier">,
    fields: Array<{ name: string; value: string; inline: boolean }>
  ): Promise<void> {
    const mode = config.execution.mode === "paper" ? "[PAPER] " : "";
    await this.discord.send(
      {
        embeds: [
          {
            title: `${mode}${title} ${convergence.tier}`,
            description: `${convergence.token_symbol ? `$${convergence.token_symbol}` : truncateAddress(convergence.token_mint)} (${truncateAddress(convergence.token_mint)})`,
            color: title.includes("FAILED") || title.includes("REJECTED") ? 0xffcc00 : 0x00ccff,
            fields,
            timestamp: new Date().toISOString()
          }
        ]
      },
      convergence.tier
    );
  }

  private async notifyPositionExit(position: PositionRow, reason: string, pnlUsd: number, pnlPct: number): Promise<void> {
    await this.discord.send(
      {
        embeds: [
          {
            title: `${config.execution.mode === "paper" ? "[PAPER] " : ""}EXIT ${reason}`,
            description: `${position.token_symbol ? `$${position.token_symbol}` : truncateAddress(position.token_mint)} (${truncateAddress(position.token_mint)})`,
            color: pnlUsd >= 0 ? 0x00ff88 : 0xff3366,
            fields: [
              { name: "P&L", value: `${formatUsd(pnlUsd)} (${pnlPct.toFixed(2)}%)`, inline: true },
              { name: "Hold", value: `${Math.max(1, Math.round((unixNow() - position.opened_at) / 60))}m`, inline: true }
            ],
            timestamp: new Date().toISOString()
          }
        ]
      },
      position.tier
    );
  }

  private requireDb(): AppDatabase {
    if (!this.db) throw new Error("TradeExecutor is not configured");
    return this.db;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const tradeExecutor = new TradeExecutor();
