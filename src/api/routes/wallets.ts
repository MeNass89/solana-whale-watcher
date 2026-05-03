import { PublicKey } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import type { WalletModel } from "../../storage/models/wallets.js";

const walletBody = z.object({
  address: z.string().min(32),
  label: z.string().optional(),
  source: z.enum(["manual", "axiom", "nansen", "dune", "discovered", "co-buyer"]).default("manual"),
  state: z.enum(["NEW", "PROBATION", "ACTIVE", "DORMANT", "DEMOTED", "PRUNED", "ARCHIVED"]).default("NEW"),
  active: z.boolean().default(true)
});

export async function registerWalletRoutes(app: FastifyInstance, wallets: WalletModel): Promise<void> {
  app.get("/api/wallets", { preHandler: requireAuth }, async () => wallets.listAll());

  app.post("/api/wallets", { preHandler: requireAuth }, async (request, reply) => {
    const body = walletBody.parse(request.body);
    new PublicKey(body.address);
    wallets.upsert(body);
    await reply.code(201).send(wallets.find(body.address));
  });

  app.put("/api/wallets/:address", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ address: z.string() }).parse(request.params);
    const body = walletBody.partial().omit({ address: true }).parse(request.body);
    new PublicKey(params.address);
    wallets.update(params.address, body);
    await reply.send(wallets.find(params.address));
  });

  app.delete("/api/wallets/:address", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ address: z.string() }).parse(request.params);
    wallets.deactivate(params.address);
    await reply.code(204).send();
  });
}
