import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { eventBus } from "../../engine/alert-manager.js";

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/events", { preHandler: requireAuth }, async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    reply.raw.write("event: ready\ndata: {}\n\n");

    const onConvergence = (payload: unknown) => {
      reply.raw.write(`event: convergence\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    eventBus.on("convergence", onConvergence);
    reply.raw.on("close", () => eventBus.off("convergence", onConvergence));
  });
}
