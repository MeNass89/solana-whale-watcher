import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import type { ConvergenceModel } from "../../storage/models/convergences.js";

export async function registerConvergenceRoutes(app: FastifyInstance, convergences: ConvergenceModel): Promise<void> {
  app.get("/api/convergences", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) }).parse(request.query);
    return convergences.list(query.limit);
  });

  app.get("/api/convergences/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const convergence = convergences.findById(params.id);
    if (!convergence) return reply.code(404).send({ error: "Not found" });
    return {
      convergence,
      trades: convergences.tradesForConvergence(params.id)
    };
  });
}
