import fs from "node:fs";
import path from "node:path";
import fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { config } from "../config/index.js";
import { registerConvergenceRoutes } from "./routes/convergences.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerWalletRoutes } from "./routes/wallets.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import type { AlertManager } from "../engine/alert-manager.js";
import type { ConvergenceEngine } from "../engine/convergence.js";
import type { AppDatabase } from "../storage/database.js";
import type { ConvergenceModel } from "../storage/models/convergences.js";
import type { TradeModel } from "../storage/models/trades.js";
import type { WalletModel } from "../storage/models/wallets.js";
import { requireAuth } from "./middleware/auth.js";

export interface ServerDeps {
  db: AppDatabase;
  wallets: WalletModel;
  trades: TradeModel;
  convergences: ConvergenceModel;
  engine: ConvergenceEngine;
  alerts: AlertManager;
}

export async function buildServer(deps: ServerDeps) {
  const app = fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    (request as typeof request & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (error) {
      done(error as Error);
    }
  });

  await app.register(cors, { origin: false });
  await registerHealthRoutes(app);
  await registerWebhookRoutes(app, deps);
  await registerWalletRoutes(app, deps.wallets);
  await registerConvergenceRoutes(app, deps.convergences);
  await registerEventRoutes(app);

  app.get("/api/trades", { preHandler: requireAuth }, async () => deps.trades.recent(100));
  app.get("/api/stats", { preHandler: requireAuth }, async () => ({
    activeWallets: deps.wallets.countActive(),
    convergences: deps.convergences.list(10).length
  }));
  app.get("/api/config", { preHandler: requireAuth }, async () => ({
    convergence: config.convergence,
    host: config.server.host,
    port: config.server.port
  }));

  const frontendPath = path.resolve(process.cwd(), "dist/frontend");
  if (fs.existsSync(frontendPath)) {
    await app.register(fastifyStatic, {
      root: frontendPath,
      prefix: "/",
      decorateReply: false
    });
  }

  return app;
}
