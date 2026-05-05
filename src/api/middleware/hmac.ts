import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config/index.js";

export async function verifyHeliusHmac(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = config.helius.webhookSecret;
  const authHeader = firstHeader(request.headers["authorization"]);
  if (authHeader && safeEqual(authHeader, expected)) return;

  const signature = firstHeader(request.headers["x-helius-signature"] ?? request.headers["x-signature"]);
  if (signature) {
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
    const digest = crypto.createHmac("sha256", expected).update(rawBody).digest("hex");
    const normalized = signature.replace(/^sha256=/, "");
    if (safeEqual(digest, normalized)) return;
  }

  await reply.code(401).send({ error: "Unauthorized" });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
