import { openDatabase } from "../src/storage/database.js";
import { WalletModel } from "../src/storage/models/wallets.js";
import { WalletMonitor } from "../src/blockchain/wallet-monitor.js";
import { logger } from "../src/utils/logger.js";

const db = openDatabase();
const wallets = new WalletModel(db);
const monitor = new WalletMonitor(wallets);

const id = await monitor.syncWebhook();
if (id) logger.info({ webhookId: id }, "Helius webhook created; add this value to HELIUS_WEBHOOK_ID");
else logger.info("Helius webhook updated");
