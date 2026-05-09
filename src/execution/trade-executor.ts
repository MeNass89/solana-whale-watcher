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

const NOTABLE_ENTRY_DELAY_MS = 12_000;
const CRITICAL_MAX_SIGNAL_AGE_SECONDS = 45 * 60;
const NOTABLE_MAX_SIGNAL_AGE_SECONDS = 90 * 60;
const NOTABLE_MAX_ADVERSE_MOVE_PCT = 3;

export class TradeExecutor {
  private db: AppDatabase | null = null;
  private swaps: JupiterClient = jupiterClient;
  private risk: RiskEngine = riskEngine;
  private positions: PositionManager = positionManager;
  private discord = new DiscordAlerter();

  configure(input: {
    db: AppDatabase;
    swaps?: JupiterClient;
    risk?: RiskEngine;
    positions?: PositionManager;
    discord?: DiscordAlerter;
  }): void {
    this.db = input.db;
    this.swaps = input.swaps ?? jupiterClient;
    this.risk = input.risk ?? riskEngine;
    this.positions = input.positions ?? positionManager;
    this.discord = input.discord ?? new DiscordAlerter();
  }

  async onConvergence(convergence: ConvergenceRow, trades: TradeRow[]): Promise<void> {
    if (!config.execution.enabled) return;
    if (convergence.tier === "WATCH") return;

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

    const entryPrice = (await this.swaps.getPriceUsd(convergence.token_mint)) ?? initialPrice;
    const risk = await this.risk.checkEntry(convergence, trades, entryPrice);
    if (!risk.allowed || !risk.adjustedSizePct || !risk.sizeUsd) {
      logger.info({ convergenceId: convergence.id, reason: risk.reason }, "execution rejected by risk engine");
      await this.notify("ENTRY_REJECTED", convergence, [{ name: "Reason", value: risk.reason ?? "unknown", inline: false }]);
      return;
    }

    const liquidityUsd = await this.risk.tokenLiquidityLive(convergence.token_mint);
    const slippageBps = this.swaps.slippageBpsForLiquidity(liquidityUsd);
    if (slippageBps === null) {
      logger.info({ mint: convergence.token_mint, liquidityUsd }, "execution skipped; liquidity below minimum");
      return;
    }

    const executionId = this.createExecution({
      convergence,
      direction: "BUY",
      amountUsd: risk.sizeUsd,
      priceUsd: entryPrice,
      status: "PENDING",
      sizePct: risk.adjustedSizePct
    });

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
      this.fillExecution(executionId, {
        direction: "BUY",
        amountToken,
        amountUsd: risk.sizeUsd,
        priceUsd: actualEntryPrice,
        txSignature: result.txSignature
      });
      if (config.execution.mode === "paper") this.risk.updatePaperBalance(-risk.sizeUsd);
      const position = this.positions.openPosition({
        tokenMint: convergence.token_mint,
        tokenSymbol: convergence.token_symbol,
        entryExecutionId: executionId,
        convergenceId: convergence.id,
        amountToken,
        entryPriceUsd: actualEntryPrice,
        tier: convergence.tier
      });
      await this.notify("ENTRY_FILLED", convergence, [
        { name: "Mode", value: config.execution.mode.toUpperCase(), inline: true },
        { name: "Size", value: `${formatUsd(risk.sizeUsd)} (${risk.adjustedSizePct.toFixed(2)}%)`, inline: true },
        { name: "Entry", value: formatUsd(actualEntryPrice), inline: true },
        { name: "Stop", value: formatUsd(position.stop_loss_price), inline: true },
        { name: "Position", value: String(position.id), inline: true }
      ]);
    } catch (error) {
      this.failExecution(executionId, error);
      this.risk.recordFailedTransaction();
      logger.error({ error, convergenceId: convergence.id }, "execution failed");
      await this.notify("ENTRY_FAILED", convergence, [{ name: "Error", value: String(error), inline: false }]);
    }
  }

  async exitPosition(position: PositionRow, reason: string, sellPct: number, panicExit = false): Promise<void> {
    if (!config.execution.enabled) return;
    const current = this.positions.findById(position.id);
    if (!current || current.status === "CLOSED" || current.amount_token <= 0) return;
    const priceUsd = (await this.swaps.getPriceUsd(current.token_mint)) ?? current.current_price_usd ?? current.entry_price_usd;
    const sellAmountToken = current.amount_token * Math.min(100, Math.max(0, sellPct)) / 100;
    if (sellAmountToken <= 0) return;

    const amountUsd = sellAmountToken * priceUsd;
    const exitLiquidityUsd = await this.risk.tokenLiquidityLive(current.token_mint);
    // Panic exits prefer "execute at any reasonable price" over "miss the exit
    // entirely"; widen the fallback to 20% when liquidity is unknown.
    const fallbackBps = panicExit ? 2000 : 500;
    const slippageBps = this.swaps.slippageBpsForLiquidity(exitLiquidityUsd) ?? fallbackBps;
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
      const decimals = Math.max(0, Math.trunc(this.tokenDecimals(current.token_mint)));
      const result = await this.swaps.executeSwap({
        inputMint: current.token_mint,
        outputMint: USDC_MINT,
        // Multiply in BigInt space — for high-decimal tokens with large balances,
        // sellAmountToken * 10**decimals can exceed Number.MAX_SAFE_INTEGER (2^53)
        // and silently truncate, corrupting exit P&L.
        amountLamports: (() => {
          const tokenInteger = BigInt(Math.max(1, Math.round(sellAmountToken)));
          return tokenInteger * (10n ** BigInt(decimals));
        })(),
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
      const exitPrice = sellAmountToken > 0 ? exitUsd / sellAmountToken : priceUsd;
      const pnlUsd = sellAmountToken * (exitPrice - current.entry_price_usd);
      const pnlPct = ((exitPrice - current.entry_price_usd) / current.entry_price_usd) * 100;
      this.fillExecution(executionId, {
        direction: "SELL",
        amountToken: sellAmountToken,
        amountUsd: exitUsd,
        priceUsd: exitPrice,
        txSignature: result.txSignature,
        pnlUsd,
        pnlPct,
        exitReason: reason
      });
      if (config.execution.mode === "paper") this.risk.updatePaperBalance(exitUsd);
      const remaining = Math.max(0, current.amount_token - sellAmountToken);
      this.positions.markExit(current, remaining, exitPrice, reason);
      await this.notifyPositionExit(current, reason, pnlUsd, pnlPct);
    } catch (error) {
      this.failExecution(executionId, error);
      this.risk.recordFailedTransaction();
      logger.error({ error, positionId: current.id }, "position exit failed");
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

  private isStale(convergence: ConvergenceRow): boolean {
    const ageSeconds = unixNow() - convergence.first_trade_at;
    if (convergence.tier === "CRITICAL") return ageSeconds > CRITICAL_MAX_SIGNAL_AGE_SECONDS;
    if (convergence.tier === "NOTABLE") return ageSeconds > NOTABLE_MAX_SIGNAL_AGE_SECONDS;
    return false;
  }


  private tokenDecimals(mint: string): number {
    const row = this.requireDb().prepare("SELECT decimals FROM tokens WHERE mint = ?").get(mint) as
      | { decimals: number | null }
      | undefined;
    return row?.decimals ?? 6;
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
