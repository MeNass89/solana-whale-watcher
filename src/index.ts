import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config/index.js";
import { DiscordAlerter } from "./alerts/discord.js";
import { buildServer } from "./api/server.js";
import { HeliusClient } from "./blockchain/helius-client.js";
import { TokenResolver } from "./blockchain/token-resolver.js";
import { WalletMonitor } from "./blockchain/wallet-monitor.js";
import { AlertManager } from "./engine/alert-manager.js";
import { ConvergenceEngine } from "./engine/convergence.js";
import { checkWebhookHealth } from "./jobs/webhook-health.js";
import { runPriceTracker } from "./jobs/price-tracker.js";
import { runTokenMetadata } from "./jobs/token-metadata.js";
import { runWalletScorer } from "./jobs/wallet-scorer.js";
import { runLeaderboardRefresh } from "./jobs/leaderboard-refresh.js";
import { openDatabase } from "./storage/database.js";
import { ConvergenceModel } from "./storage/models/convergences.js";
import { TokenModel } from "./storage/models/tokens.js";
import { TradeModel } from "./storage/models/trades.js";
import { WalletModel } from "./storage/models/wallets.js";
import { logger } from "./utils/logger.js";
import { positionManager } from "./execution/position-manager.js";
import { riskEngine } from "./execution/risk-engine.js";
import { tradeExecutor } from "./execution/trade-executor.js";
import { stopRecentTradesCleanup } from "./blockchain/transaction-parser.js";

process.on("unhandledRejection", (err) => {
  logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "unhandled rejection (non-fatal)");
});
process.on("SIGTERM", () => { logger.info("SIGTERM"); process.exit(0); });
process.on("SIGINT", () => { logger.info("SIGINT"); process.exit(0); });

async function main(): Promise<void> {
  const db = openDatabase();
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  const shutdown = (signal: string) => {
    logger.info(signal);
    stopRecentTradesCleanup();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const wallets = new WalletModel(db);
  seedWallets(wallets);

  const trades = new TradeModel(db);
  const convergences = new ConvergenceModel(db);
  const tokens = new TokenModel(db);
  const resolver = new TokenResolver(tokens);
  const engine = new ConvergenceEngine(trades, convergences, wallets, tokens, resolver, db);
  const alerts = new AlertManager(convergences);
  riskEngine.configure(db);
  tradeExecutor.configure({ db, risk: riskEngine, positions: positionManager });
  positionManager.configure({
    db,
    wallets,
    exitHandler: (position, reason, sellPct, panicExit) => tradeExecutor.exitPosition(position, reason, sellPct, panicExit)
  });
  if (config.execution.enabled) positionManager.start();

  const helius = new HeliusClient();
  const monitor = new WalletMonitor(wallets);

  try {
    await monitor.syncWebhook();
    logger.info("webhook synced at startup");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err : new Error(String(err)) }, "webhook sync failed at startup");
  }

  // Wallet scorer: daily at 9:43 (aligned with finance-review), also 60s after startup
  const scorerJob = () => runWalletScorer(wallets, trades, helius, monitor).catch((err) => {
    logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "wallet-scorer: job failed");
  });
  setTimeout(scorerJob, 60_000);
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 9 && now.getMinutes() === 43) scorerJob();
  }, 60 * 1000);

  const leaderboardJob = () => runLeaderboardRefresh().catch((err) => {
    logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "leaderboard-refresh: job failed");
  });
  let leaderboardRunning = false;
  const leaderboardJobGuarded = async () => {
    if (leaderboardRunning) return;
    leaderboardRunning = true;
    try {
      await leaderboardJob();
    } finally {
      leaderboardRunning = false;
    }
  };
  // Run once at startup so freshly-deployed instances have wallet_class /
  // realized_sol_30d immediately rather than waiting for the next 06:00 tick.
  // Use the guarded path here too so a startup-triggered run can't overlap
  // with the 06:00 periodic if the timer happens to fire near that window.
  setTimeout(leaderboardJobGuarded, 90_000);
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 6 && now.getMinutes() === 0) leaderboardJobGuarded();
  }, 60 * 1000);

  // Mutex prevents overlapping runs when the 15-min interval lands while a
  // previous health check is still re-enabling a wedged webhook.
  let webhookHealthRunning = false;
  const webhookHealthJob = async () => {
    if (webhookHealthRunning) return;
    webhookHealthRunning = true;
    try {
      await checkWebhookHealth(helius, config.helius.webhookId, config.server.publicWebhookUrl, new DiscordAlerter(), wallets);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "webhook-health: job failed");
    } finally {
      webhookHealthRunning = false;
    }
  };
  setInterval(webhookHealthJob, 15 * 60 * 1000);
  setTimeout(webhookHealthJob, 120_000);

  setInterval(() => {
    engine.retryPendingExecutions().catch((err) => {
      logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "convergence execution retry failed");
    });
  }, 5 * 60 * 1000);

  const metadataJob = () => runTokenMetadata(db, tokens).catch((err) => {
    logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "token-metadata: job failed");
  });
  setTimeout(metadataJob, 30_000);
  setInterval(metadataJob, 5 * 60 * 1000);

  const priceTrackerJob = () => runPriceTracker(db).catch((err) => {
    logger.error({ err: err instanceof Error ? err : new Error(String(err)) }, "price-tracker: job failed");
  });
  setTimeout(priceTrackerJob, 45_000);
  setInterval(priceTrackerJob, 15 * 60 * 1000);

  setInterval(() => {
    try { db.pragma("wal_checkpoint(PASSIVE)"); } catch {}
  }, 4 * 60 * 60 * 1000);

  const app = await buildServer({ db, wallets, trades, convergences, engine, alerts });

  await app.listen({ host: config.server.host, port: config.server.port });
  logger.info({ host: config.server.host, port: config.server.port }, "server started");
}

function seedWallets(wallets: WalletModel): void {
  const seedPath = "src/config/wallets.seed.json";
  if (!fs.existsSync(seedPath)) return;
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as Array<{ address: string; label?: string; source?: string }>;
  let added = 0;
  for (const wallet of seed) {
    if (!wallet.address) continue;
    try {
      new PublicKey(wallet.address);
      if (wallets.find(wallet.address)) continue;
      wallets.upsert({
        address: wallet.address,
        label: wallet.label,
        source: wallet.source === "axiom" || wallet.source === "nansen" || wallet.source === "dune" ? wallet.source : "manual"
      });
      added++;
    } catch (error) {
      logger.warn({ address: wallet.address, err: error instanceof Error ? error : new Error(String(error)) }, "invalid seed wallet skipped");
    }
  }
  if (added > 0) logger.info({ added }, "seed wallets inserted");
}

main().catch((error) => {
  logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "fatal startup error");
  process.exit(1);
});
