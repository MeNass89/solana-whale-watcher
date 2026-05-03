import { config } from "../config/index.js";
import type { WalletModel } from "../storage/models/wallets.js";
import { HeliusClient } from "./helius-client.js";

export class WalletMonitor {
  constructor(
    private readonly wallets: WalletModel,
    private readonly helius = new HeliusClient()
  ) {}

  async syncWebhook(): Promise<string | void> {
    const addresses = this.wallets.listActive().map((wallet) => wallet.address);
    if (addresses.length === 0) throw new Error("No active wallets to monitor");
    if (config.helius.webhookId) {
      await this.helius.updateWebhook(config.helius.webhookId, addresses, config.server.publicWebhookUrl);
      return;
    }
    return this.helius.registerWebhook(addresses, config.server.publicWebhookUrl);
  }
}
