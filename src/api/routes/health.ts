import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    ok: true,
    service: "solana-whale-watcher",
    timestamp: new Date().toISOString()
  }));
}
