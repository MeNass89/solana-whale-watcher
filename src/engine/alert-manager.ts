import { EventEmitter } from "node:events";
import type { ConvergenceModel, ConvergenceRow } from "../storage/models/convergences.js";
import type { TradeRow } from "../storage/models/trades.js";
import { DiscordAlerter } from "../alerts/discord.js";
import { formatDiscordMessage } from "../alerts/formatter.js";

export const eventBus = new EventEmitter();

export class AlertManager {
  constructor(
    private readonly convergences: ConvergenceModel,
    private readonly discord = new DiscordAlerter()
  ) {}

  async dispatch(convergence: ConvergenceRow, trades: TradeRow[]): Promise<void> {
    eventBus.emit("convergence", { convergence, trades });
    if (convergence.tier === "WATCH") return;

    const sent = await this.discord.send(formatDiscordMessage(convergence, trades), convergence.tier);
    if (sent) this.convergences.markAlerted(convergence.id);
  }
}
