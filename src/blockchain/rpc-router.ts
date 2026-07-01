import { Connection, type Commitment } from "@solana/web3.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";
import type { RpcUsageLogger } from "./rpc-usage-logger.js";

export type EndpointId = "alchemy" | "chainstack" | "helius";

export type RpcMethod =
  | "getAccountInfo"
  | "getBalance"
  | "getParsedTokenAccountsByOwner"
  | "getRecentPerformanceSamples"
  | "getSignatureStatuses"
  | "getSignaturesForAddress"
  | "getTransaction"
  | "sendTransaction"
  | "simulateTransaction";

interface EndpointEntry {
  id: EndpointId;
  url: string;
  connection: Connection;
  breaker: CircuitBreaker;
}

const METHOD_AFFINITY: Record<RpcMethod, EndpointId[]> = {
  // Runtime cheap calls — Chainstack first (3M req/mo runtime), Alchemy as fallback
  getAccountInfo: ["chainstack", "alchemy", "helius"],
  getBalance: ["chainstack", "alchemy", "helius"],
  getParsedTokenAccountsByOwner: ["chainstack", "alchemy", "helius"],
  getRecentPerformanceSamples: ["chainstack", "alchemy", "helius"],
  getSignatureStatuses: ["alchemy", "chainstack", "helius"],

  // Archive methods — Chainstack 403s, Alchemy preferred, Helius last resort
  getSignaturesForAddress: ["alchemy", "helius"],
  getTransaction: ["alchemy", "helius"],

  // Tx submission — Alchemy primary (300M CU/mo), Helius fallback
  sendTransaction: ["alchemy", "helius"],
  simulateTransaction: ["alchemy", "chainstack", "helius"]
};

export class RpcRouter {
  private readonly endpoints = new Map<EndpointId, EndpointEntry>();
  private usageLogger: RpcUsageLogger | null = null;

  constructor() {
    if (config.rpc.alchemyApiKey) {
      this.register("alchemy", `https://solana-mainnet.g.alchemy.com/v2/${config.rpc.alchemyApiKey}`);
    }
    if (config.rpc.chainstackUrl) {
      this.register("chainstack", config.rpc.chainstackUrl);
    }
    if (config.helius.apiKey) {
      this.register("helius", `https://mainnet.helius-rpc.com/?api-key=${config.helius.apiKey}`);
    }

    if (this.endpoints.size === 0) {
      throw new Error("RpcRouter: no endpoints configured (need at least one of ALCHEMY_API_KEY / CHAINSTACK_RPC_URL / HELIUS_API_KEY)");
    }
    logger.info({ endpoints: [...this.endpoints.keys()] }, "RpcRouter initialised");
  }

  setUsageLogger(usageLogger: RpcUsageLogger): void {
    this.usageLogger = usageLogger;
  }

  /**
   * Pick a Connection for a given method, walking the affinity chain until
   * we find an endpoint with a CLOSED or HALF_OPEN breaker. Throws if all
   * endpoints in the chain are OPEN.
   *
   * Use this when you need a `Connection` instance (e.g. to pass to a library
   * that expects one — Jupiter, web3.js helpers). Logging happens at the
   * call site via `recordUsage()`.
   */
  pickConnection(method: RpcMethod): { endpoint: EndpointId; connection: Connection } {
    const chain = METHOD_AFFINITY[method];
    for (const id of chain) {
      const entry = this.endpoints.get(id);
      if (!entry) continue;
      const state = entry.breaker.getState();
      if (state !== "OPEN") return { endpoint: id, connection: entry.connection };
    }
    throw new Error(`RpcRouter: all endpoints OPEN or missing for method ${method}`);
  }

  /**
   * Execute a method through the router with automatic fallback and breaker
   * protection. Caller provides a closure that runs against a given Connection.
   */
  async call<T>(method: RpcMethod, fn: (connection: Connection) => Promise<T>, opts: { commitment?: Commitment } = {}): Promise<T> {
    const chain = METHOD_AFFINITY[method];
    let lastError: unknown = null;

    for (const id of chain) {
      const entry = this.endpoints.get(id);
      if (!entry) continue;
      const state = entry.breaker.getState();
      if (state === "OPEN") continue;

      const startedAt = Date.now();
      try {
        const result = await entry.breaker.execute(() => fn(entry.connection));
        this.recordUsage(id, method, "ok", Date.now() - startedAt, null);
        return result;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const status = err instanceof CircuitOpenError ? "circuit_open" : isRateLimit(err) ? "rate_limited" : "error";
        this.recordUsage(id, method, status, durationMs, errorMessage(err));
        lastError = err;
        // On rate-limit or circuit-open, try next endpoint in chain
        if (status === "rate_limited" || status === "circuit_open") continue;
        // On other errors (e.g. -32602 invalid param), do not retry — surface to caller
        throw err;
      }
    }

    if (lastError) throw lastError;
    throw new Error(`RpcRouter: no endpoint available for method ${method}`);
  }

  getMetrics() {
    const out: Record<string, ReturnType<CircuitBreaker["getMetrics"]>> = {};
    for (const [id, entry] of this.endpoints) out[id] = entry.breaker.getMetrics();
    return out;
  }

  private register(id: EndpointId, url: string): void {
    // disableRetryOnRateLimit: web3.js otherwise retries 429s internally with
    // backoff — every hidden retry is a real billed request invisible to the
    // usage logger, and it makes the endpoint look hard-down to the breaker.
    // 429s must surface immediately so the router fails over instead.
    const connection = new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true });
    const breaker = new CircuitBreaker({ name: id });
    this.endpoints.set(id, { id, url, connection, breaker });
  }

  private recordUsage(endpoint: EndpointId, method: RpcMethod, status: string, durationMs: number, error: string | null): void {
    if (!this.usageLogger) return;
    this.usageLogger.record({ endpoint, method, status, durationMs, error });
  }
}

function isRateLimit(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /429|Too Many Requests|rate.?limit/i.test(message);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

let singleton: RpcRouter | null = null;
export function getRpcRouter(): RpcRouter {
  if (!singleton) singleton = new RpcRouter();
  return singleton;
}
