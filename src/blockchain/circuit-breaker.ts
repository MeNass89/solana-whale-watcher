import { logger } from "../utils/logger.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;
  openDurationMs?: number;
  halfOpenMaxAttempts?: number;
}

export interface CircuitMetrics {
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  halfOpenAttempts: number;
}

export class CircuitOpenError extends Error {
  constructor(readonly endpoint: string, readonly retryAfterMs: number) {
    super(`circuit OPEN for ${endpoint}, retry after ${retryAfterMs}ms`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private metrics: CircuitMetrics = {
    consecutiveFailures: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    openedAt: null,
    lastFailureAt: null,
    halfOpenAttempts: 0
  };

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly halfOpenMaxAttempts: number;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.openDurationMs = opts.openDurationMs ?? 60 * 60 * 1000;
    this.halfOpenMaxAttempts = opts.halfOpenMaxAttempts ?? 1;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.refreshState();

    if (this.state === "OPEN") {
      const retryAfterMs = this.remainingOpenMs();
      throw new CircuitOpenError(this.name, retryAfterMs);
    }

    if (this.state === "HALF_OPEN" && this.metrics.halfOpenAttempts >= this.halfOpenMaxAttempts) {
      throw new CircuitOpenError(this.name, this.openDurationMs);
    }

    if (this.state === "HALF_OPEN") this.metrics.halfOpenAttempts++;

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (isRateLimitError(err)) this.onFailure(err);
      throw err;
    }
  }

  getState(): CircuitState {
    this.refreshState();
    return this.state;
  }

  getMetrics(): Readonly<CircuitMetrics> & { state: CircuitState } {
    this.refreshState();
    return { ...this.metrics, state: this.state };
  }

  private refreshState(): void {
    if (this.state !== "OPEN") return;
    if (this.metrics.openedAt === null) return;
    if (Date.now() - this.metrics.openedAt >= this.openDurationMs) {
      this.state = "HALF_OPEN";
      this.metrics.halfOpenAttempts = 0;
      logger.warn({ endpoint: this.name }, "circuit HALF_OPEN — probing");
    }
  }

  private onSuccess(): void {
    this.metrics.totalSuccesses++;
    if (this.state === "HALF_OPEN" || this.state === "OPEN") {
      logger.info({ endpoint: this.name }, "circuit CLOSED — endpoint recovered");
    }
    this.state = "CLOSED";
    this.metrics.consecutiveFailures = 0;
    this.metrics.openedAt = null;
    this.metrics.halfOpenAttempts = 0;
  }

  private onFailure(err: unknown): void {
    this.metrics.totalFailures++;
    this.metrics.consecutiveFailures++;
    this.metrics.lastFailureAt = Date.now();

    if (this.state === "HALF_OPEN") {
      this.trip();
      return;
    }

    if (this.metrics.consecutiveFailures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = "OPEN";
    this.metrics.openedAt = Date.now();
    this.metrics.halfOpenAttempts = 0;
    logger.error(
      { endpoint: this.name, consecutiveFailures: this.metrics.consecutiveFailures, openDurationMs: this.openDurationMs },
      "circuit OPEN — endpoint tripped on 429"
    );
  }

  private remainingOpenMs(): number {
    if (this.metrics.openedAt === null) return this.openDurationMs;
    return Math.max(0, this.openDurationMs - (Date.now() - this.metrics.openedAt));
  }
}

function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (/429|Too Many Requests|rate.?limit/i.test(message)) return true;
  const status = (err as { status?: number; statusCode?: number; code?: number | string }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? (err as { code?: number | string }).code;
  if (status === 429 || status === "429") return true;
  return false;
}
