import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config/index.js";

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const apiToken = request.headers["x-api-token"];
  const query = request.query as { token?: string } | undefined;
  const token = bearer ?? (Array.isArray(apiToken) ? apiToken[0] : apiToken) ?? query?.token;

  if (token !== config.server.apiAuthToken) {
    await reply.code(401).send({ error: "Unauthorized" });
  }
}
