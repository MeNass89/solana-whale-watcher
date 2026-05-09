import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config/index.js";

export async function verifyHeliusHmac(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = config.helius.webhookSecret;
  if (!expected) {
    request.log.error("verifyHeliusHmac: HELIUS_WEBHOOK_SECRET is not configured — rejecting all requests");
    await reply.code(503).send({ error: "Webhook auth not configured" });
    return;
  }

  const authHeader = firstHeader(request.headers["authorization"]);
  if (authHeader && safeEqual(authHeader, expected)) return;

  const signature = firstHeader(request.headers["x-helius-signature"] ?? request.headers["x-signature"]);
  if (signature) {
    // HMAC must hash the *exact* request bytes. JSON.stringify on the parsed
    // body normalizes whitespace/key order/quotes, so the digest would no
    // longer match the sender's signature. If rawBody is missing it's a
    // server-side misconfig (raw-body parser not registered) — fail loud.
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
    if (!rawBody) {
      request.log.error("verifyHeliusHmac: rawBody not captured — content-type parser misconfigured");
      await reply.code(500).send({ error: "Webhook auth misconfigured" });
      return;
    }
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
