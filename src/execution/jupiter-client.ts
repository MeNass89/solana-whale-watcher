import {
  Keypair,
  PublicKey,
  VersionedTransaction
} from "@solana/web3.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getRpcRouter, type RpcRouter } from "../blockchain/rpc-router.js";
import { tokenDecimalsResolver } from "../blockchain/token-decimals.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";
const QUOTE_MAX_AGE_MS = 3_000;
const SEND_INTERVAL_MS = 500;
const JUPITER_MIN_INTERVAL_MS = 2_000;
const JUPITER_MAX_ATTEMPTS = 3;
const CONFIRM_TIMEOUT_MS = 60_000;
const TIP_HARD_CAP_LAMPORTS = 15_000_000;
const MIN_SANE_PRICE_USD = 1e-15;
const MAX_SANE_PRICE_USD = 1e6;
const MAX_PRICE_CHANGE_RATIO = 100;
let nextJupiterRequestAt = 0;
let jupiterQueue: Promise<void> = Promise.resolve();

function isSanePrice(price: number): boolean {
  return Number.isFinite(price) && price > MIN_SANE_PRICE_USD && price < MAX_SANE_PRICE_USD;
}

function isSanePriceChange(oldPrice: number, newPrice: number): boolean {
  if (!isSanePrice(oldPrice) || !isSanePrice(newPrice)) return false;
  const ratio = Math.max(newPrice / oldPrice, oldPrice / newPrice);
  return ratio < MAX_PRICE_CHANGE_RATIO;
}

export interface SwapParams {
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps: number;
  isExitSwap?: boolean;
  panicExit?: boolean;
  tier?: "WATCH" | "NOTABLE" | "CRITICAL";
}

export interface SwapResult {
  txSignature: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
  executedAt: number;
}

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  inputDecimals?: number;
  outputDecimals?: number;
  priceImpactPct?: string;
  timeTaken?: number;
  contextSlot?: number;
  quotedAt: number;
  raw: Record<string, unknown>;
}

interface JupiterSwapResponse {
  swapTransaction?: string;
  lastValidBlockHeight?: number;
  simulationError?: unknown;
}

export class JupiterClient {
  private router: RpcRouter | null = null;
  private readonly wallet: Keypair | null;

  constructor() {
    this.wallet =
      config.execution.enabled && config.execution.mode === "live" ? parseWalletKeypair(config.execution.walletPrivate) : null;
  }

  slippageBpsForLiquidity(liquidityUsd?: number | null): number | null {
    if (liquidityUsd === undefined || liquidityUsd === null) return null;
    if (liquidityUsd > 500_000) return 100;
    if (liquidityUsd >= 100_000) return 300;
    if (liquidityUsd >= 50_000) return 500;
    if (liquidityUsd >= 5_000) return 2500;
    return null;
  }

  async getPriceUsd(mint: string): Promise<number | null> {
    if (mint === USDC_MINT) return 1;
    try {
      const url = new URL(JUPITER_QUOTE_URL);
      url.searchParams.set("inputMint", USDC_MINT);
      url.searchParams.set("outputMint", mint);
      url.searchParams.set("amount", "1000000");
      url.searchParams.set("slippageBps", "300");
      const response = await jupiterFetch(url);
      if (!response.ok) {
        logger.warn({ mint, status: response.status }, "Jupiter price request failed");
        return null;
      }
      const raw = (await response.json()) as Record<string, unknown>;
      const outAmount = Number(raw.outAmount);
      const decimals = quoteTokenDecimals(raw, mint, "output") ?? (await this.tokenDecimals(mint));
      if (!outAmount || !Number.isFinite(outAmount)) return null;
      const price = 1 / (outAmount / 10 ** decimals);
      if (!isSanePrice(price)) {
        logger.warn({ mint, price }, "getPriceUsd: price outside sane bounds, returning null");
        return null;
      }
      return price;
    } catch (error) {
      logger.warn({ mint, err: error instanceof Error ? error.message : String(error) }, "getPriceUsd: request failed");
      return null;
    }
  }

  async getExitPriceUsd(mint: string, amountToken: number): Promise<number | null> {
    if (mint === USDC_MINT) return 1;
    if (!Number.isFinite(amountToken) || amountToken <= 0) return null;
    try {
      const decimals = await this.tokenDecimals(mint);
      const rawAmount = BigInt(Math.floor(amountToken * 10 ** decimals));
      if (rawAmount < 1n) return null;
      const url = new URL(JUPITER_QUOTE_URL);
      url.searchParams.set("inputMint", mint);
      url.searchParams.set("outputMint", USDC_MINT);
      url.searchParams.set("amount", rawAmount.toString());
      url.searchParams.set("slippageBps", "300");
      url.searchParams.set("dynamicSlippage", "true");
      url.searchParams.set("maxAccounts", "64");
      url.searchParams.set("restrictIntermediateTokens", "true");
      const response = await jupiterFetch(url);
      if (!response.ok) {
        logger.warn({ mint, amountToken, status: response.status }, "Jupiter exit price request failed");
        return null;
      }
      const raw = (await response.json()) as Record<string, unknown>;
      const outAmount = Number(raw.outAmount);
      if (!outAmount || !Number.isFinite(outAmount)) {
        logger.warn({ mint, amountToken }, "Jupiter exit price request returned no route");
        return null;
      }
      const usdcOut = outAmount / 1_000_000;
      const price = usdcOut / amountToken;
      if (!isSanePrice(price)) {
        logger.warn({ mint, amountToken, price }, "getExitPriceUsd: price outside sane bounds, returning null");
        return null;
      }
      return price;
    } catch (error) {
      logger.warn({ mint, amountToken, err: error instanceof Error ? error.message : String(error) }, "getExitPriceUsd: request failed");
      return null;
    }
  }

  /**
   * Get a real exit quote: "if I sold all my tokens right now, how much USDC would I get?"
   * Returns null if quote fails (token dead, pool drained, etc.)
   */
  async getExitQuoteUsd(
    tokenMint: string,
    amountToken: number,
    decimals: number
  ): Promise<{ totalUsd: number; effectivePrice: number; priceImpactPct: number } | null> {
    if (amountToken <= 0 || decimals < 0) return null;

    const amountLamports = BigInt(Math.floor(amountToken * 10 ** decimals));
    if (amountLamports < 1n) return null;

    try {
      const quote = await this.getQuote({
        inputMint: tokenMint,
        outputMint: USDC_MINT,
        amountLamports,
        slippageBps: 300
      });
      const outAmount = Number(quote.outAmount) / 1e6; // USDC = 6 decimals
      if (!Number.isFinite(outAmount) || outAmount <= 0) return null;
      return {
        totalUsd: outAmount,
        effectivePrice: outAmount / amountToken,
        priceImpactPct: Number(quote.priceImpactPct ?? 0)
      };
    } catch {
      return null;
    }
  }

  async getQuote(params: SwapParams): Promise<JupiterQuote> {
    const url = new URL(JUPITER_QUOTE_URL);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amountLamports.toString());
    url.searchParams.set("slippageBps", this.exitSlippageBps(params).toString());
    url.searchParams.set("dynamicSlippage", "true");
    url.searchParams.set("maxAccounts", "64");
    url.searchParams.set("restrictIntermediateTokens", "true");

    const response = await jupiterFetch(url);
    if (!response.ok) throw new Error(`Jupiter quote failed: ${response.status} ${await response.text()}`);

    const raw = (await response.json()) as Record<string, unknown>;
    return {
      inputMint: String(raw.inputMint ?? params.inputMint),
      outputMint: String(raw.outputMint ?? params.outputMint),
      inAmount: String(raw.inAmount ?? params.amountLamports.toString()),
      outAmount: String(raw.outAmount ?? "0"),
      inputDecimals: quoteTokenDecimals(raw, params.inputMint, "input"),
      outputDecimals: quoteTokenDecimals(raw, params.outputMint, "output"),
      priceImpactPct: typeof raw.priceImpactPct === "string" ? raw.priceImpactPct : undefined,
      timeTaken: typeof raw.timeTaken === "number" ? raw.timeTaken : undefined,
      contextSlot: typeof raw.contextSlot === "number" ? raw.contextSlot : undefined,
      quotedAt: Date.now(),
      raw
    };
  }

  async executeSwap(params: SwapParams): Promise<SwapResult> {
    if (config.execution.mode === "paper") return this.executePaperSwap(params);
    if (!config.execution.enabled) throw new Error("Live swap requested while execution is disabled");
    if (!this.wallet) throw new Error("SOLANA_WALLET_PRIVATE is required for live execution");

    await this.assertNetworkHealthy();
    const quote = await this.freshQuote(params);
    if (BigInt(quote.inAmount) !== params.amountLamports) {
      throw new Error(
        `jupiter: quote.inAmount (${quote.inAmount}) does not match requested amountLamports (${params.amountLamports.toString()})`
      );
    }
    const allowedImpactPct = this.exitSlippageBps(params) / 100;
    if (quote.priceImpactPct && Number(quote.priceImpactPct) > allowedImpactPct) {
      throw new Error(`Price impact ${quote.priceImpactPct}% exceeds ${allowedImpactPct}% limit`);
    }
    const beforeBalance = await this.tokenBalance(params.outputMint);
    const swap = await this.buildSwapTransaction(quote, params);
    if (swap.simulationError) throw new Error(`Jupiter simulation failed: ${JSON.stringify(swap.simulationError)}`);
    if (!swap.swapTransaction) throw new Error("Jupiter swap response did not include a transaction");

    const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
    transaction.sign([this.wallet]);
    const serialized = transaction.serialize();
    const signature = base58Encode(transaction.signatures[0]);
    await this.sendJitoBundle(serialized, params);

    await this.waitForConfirmation(signature);
    const afterBalance = await this.tokenBalance(params.outputMint);
    if (afterBalance <= beforeBalance && !params.isExitSwap) {
      throw new Error("Swap signature confirmed but output token balance did not increase");
    }

    return {
      txSignature: signature,
      inputAmount: await this.rawAmountToUi(params.inputMint, params.amountLamports, quote.inputDecimals),
      outputAmount: await this.rawAmountToUi(params.outputMint, BigInt(quote.outAmount), quote.outputDecimals),
      priceImpactPct: Number(quote.priceImpactPct ?? 0),
      executedAt: Math.floor(Date.now() / 1000)
    };
  }

  private async executePaperSwap(params: SwapParams): Promise<SwapResult> {
    // No fallback pricing: a failed quote MUST fail the paper swap. The old
    // spot-price fallback priced full exits at zero-impact buy-side spot and
    // minted phantom cash (+$572k on a single dead token). A fill that
    // Jupiter cannot quote is a fill that would not exist in live trading.
    const quote = await this.getQuote(params).catch((error) => {
      throw new Error(
        `Jupiter paper quote unavailable; refusing to synthesize a fill: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    const inputAmount = await this.rawAmountToUi(params.inputMint, params.amountLamports, quote.inputDecimals);
    if (BigInt(quote.inAmount) !== params.amountLamports) {
      // A mismatched quote means the swap simulation priced a different size
      // than we requested. Recording the fill against the requested size
      // would attribute a wrong entry price; rejecting is safer than silent
      // P&L corruption.
      throw new Error(
        `jupiter: quote.inAmount (${quote.inAmount}) does not match requested amountLamports (${params.amountLamports.toString()})`
      );
    }
    if (quote.priceImpactPct) {
      const allowedImpactPct = this.exitSlippageBps(params) / 100;
      if (Number(quote.priceImpactPct) > allowedImpactPct) {
        throw new Error(`Price impact ${quote.priceImpactPct}% exceeds ${allowedImpactPct}% limit`);
      }
    }
    const outputAmount = await this.rawAmountToUi(params.outputMint, BigInt(quote.outAmount), quote.outputDecimals);
    // Sanity-check: a malformed quote (e.g. wrong decimals) can produce an
    // absurd outputAmount that would poison downstream PnL.
    if (!Number.isFinite(outputAmount) || outputAmount <= 0 || outputAmount > 1e30) {
      logger.warn({ inputMint: params.inputMint, outputMint: params.outputMint, outputAmount }, "paper swap: produced insane output amount, rejecting");
      throw new Error("Paper swap pricing produced invalid amount");
    }

    return {
      txSignature: `paper-${Date.now()}`,
      inputAmount,
      outputAmount,
      priceImpactPct: Number(quote.priceImpactPct ?? 0),
      executedAt: Math.floor(Date.now() / 1000)
    };
  }

  private async freshQuote(params: SwapParams): Promise<JupiterQuote> {
    let quote = await this.getQuote(params);
    if (Date.now() - quote.quotedAt > QUOTE_MAX_AGE_MS) quote = await this.getQuote(params);
    return quote;
  }

  private async buildSwapTransaction(quote: JupiterQuote, params: SwapParams): Promise<JupiterSwapResponse> {
    if (!this.wallet) throw new Error("Wallet not configured");
    const response = await jupiterFetch(JUPITER_SWAP_URL, {
      method: "POST",
      headers: jupiterHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        asLegacyTransaction: false,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: this.tipLamports(params)
      })
    });
    if (!response.ok) throw new Error(`Jupiter swap failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as JupiterSwapResponse;
  }

  private async sendJitoBundle(serializedTransaction: Uint8Array, params: SwapParams): Promise<void> {
    const encoded = Buffer.from(serializedTransaction).toString("base64");
    const startedAt = Date.now();
    let lastError: unknown;

    while (Date.now() - startedAt < CONFIRM_TIMEOUT_MS) {
      try {
        const response = await fetch(`${config.execution.jitoBlockEngineUrl}/api/v1/bundles`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "sendBundle",
            params: [[encoded], { bundleOnly: true, tipLamports: this.tipLamports(params) }]
          })
        });
        const payload = (await response.json()) as { result?: string; error?: unknown };
        if (!response.ok || payload.error) {
          const errorStr = JSON.stringify(payload.error ?? payload);
          if (/insufficient|invalid|simulation failed|account not found/i.test(errorStr)) {
            throw new Error(`Permanent Jito error: ${errorStr}`);
          }
          throw new Error(errorStr);
        }
        if (payload.result) return;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Permanent")) throw error;
        lastError = error;
        await sleep(SEND_INTERVAL_MS);
      }
    }

    throw new Error(`Jito bundle submission timed out: ${String(lastError)}`);
  }

  private async waitForConfirmation(signature: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < CONFIRM_TIMEOUT_MS) {
      const status = await this.requireRouter().call("getSignatureStatuses", (c) => c.getSignatureStatuses([signature]));
      const value = status.value[0];
      if (value?.err) throw new Error(`Swap failed on-chain: ${JSON.stringify(value.err)}`);
      if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") return;
      await sleep(SEND_INTERVAL_MS);
    }
    throw new Error("Timed out waiting for swap confirmation");
  }

  private async tokenBalance(mint: string): Promise<number> {
    if (!this.wallet) return 0;
    const pubkey = this.wallet.publicKey;
    if (mint === SOL_MINT) return this.requireRouter().call("getBalance", (c) => c.getBalance(pubkey));
    const accounts = await this.requireRouter().call("getParsedTokenAccountsByOwner", (c) =>
      c.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(mint) })
    );
    return accounts.value.reduce((sum, account) => {
      const info = account.account.data.parsed.info as { tokenAmount?: { amount?: string } };
      return sum + Number(info.tokenAmount?.amount ?? 0);
    }, 0);
  }

  private async assertNetworkHealthy(): Promise<void> {
    const samples = await this.requireRouter().call("getRecentPerformanceSamples", (c) => c.getRecentPerformanceSamples(1));
    const sample = samples[0];
    if (!sample) return;
    const tps = sample.numTransactions / sample.samplePeriodSecs;
    if (tps < 1_000) {
      await sleep(30_000);
      throw new Error(`Network congestion: TPS ${Math.round(tps)} below 1000`);
    }
  }

  private exitSlippageBps(params: SwapParams): number {
    if (params.panicExit) return 2_500;
    if (params.isExitSwap) return params.slippageBps + 300;
    return params.slippageBps;
  }

  private tipLamports(params: SwapParams): number {
    const base = params.tier === "CRITICAL" ? 5_000_000 : params.tier === "NOTABLE" ? 2_000_000 : 500_000;
    return Math.min(base, TIP_HARD_CAP_LAMPORTS);
  }

  private async rawAmountToUi(mint: string, rawAmount: bigint, quoteDecimals?: number): Promise<number> {
    if (rawAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      // Number(bigint) silently truncates above 2^53-1; refuse rather than corrupt P&L.
      throw new Error(
        `rawAmountToUi: rawAmount ${rawAmount.toString()} exceeds Number.MAX_SAFE_INTEGER for mint ${mint}`
      );
    }
    const decimals = quoteDecimals ?? (await this.tokenDecimals(mint));
    return Number(rawAmount) / 10 ** decimals;
  }

  // Shared resolver: DB token row -> on-chain mint fetch -> throws on failure.
  // No silent default — a guessed scale corrupts every downstream amount.
  private async tokenDecimals(mint: string): Promise<number> {
    return tokenDecimalsResolver.resolve(mint);
  }

  private requireRouter(): RpcRouter {
    this.router ??= getRpcRouter();
    return this.router;
  }
}

function parseWalletKeypair(secret: string): Keypair {
  if (!secret) throw new Error("SOLANA_WALLET_PRIVATE is empty");
  const values = JSON.parse(secret) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(values));
}

function quoteTokenDecimals(raw: Record<string, unknown>, mint: string, side: "input" | "output"): number | undefined {
  const directKeys =
    side === "input"
      ? ["inputDecimals", "inDecimals", "sourceDecimals"]
      : ["outputDecimals", "outDecimals", "destinationDecimals"];
  for (const key of directKeys) {
    const decimals = numberValue(raw[key]);
    if (decimals !== undefined) return decimals;
  }

  const tokenKeys =
    side === "input"
      ? ["inputToken", "inputTokenInfo", "inToken", "sourceToken"]
      : ["outputToken", "outputTokenInfo", "outToken", "destinationToken"];
  for (const key of tokenKeys) {
    const decimals = tokenInfoDecimals(raw[key], mint);
    if (decimals !== undefined) return decimals;
  }

  return undefined;
}

function tokenInfoDecimals(value: unknown, mint: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const token = value as Record<string, unknown>;
  const tokenMint = typeof token.mint === "string" ? token.mint : typeof token.address === "string" ? token.address : undefined;
  if (tokenMint && tokenMint !== mint) return undefined;
  return numberValue(token.decimals);
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 18) return undefined;
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jupiterFetch(input: URL | string, init: RequestInit = {}): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= JUPITER_MAX_ATTEMPTS; attempt += 1) {
    await throttleJupiter();
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        headers: jupiterHeaders(init.headers),
        signal: combinedSignal(init.signal, AbortSignal.timeout(10_000))
      });
    } catch (error) {
      lastError = error;
      if (attempt === JUPITER_MAX_ATTEMPTS) throw error;
      const delayMs = Math.min(8_000, 1_000 * 2 ** (attempt - 1));
      logger.warn({ err: error instanceof Error ? error.message : String(error), attempt, delayMs }, "Jupiter request threw; backing off");
      await sleep(delayMs);
      continue;
    }
    if (response.ok || !isRetryableJupiterStatus(response.status) || attempt === JUPITER_MAX_ATTEMPTS) return response;
    lastResponse = response;
    const delayMs = retryAfterMs(response) ?? Math.min(8_000, 1_000 * 2 ** (attempt - 1));
    logger.warn({ status: response.status, attempt, delayMs }, "Jupiter request failed; backing off");
    await sleep(delayMs);
  }
  if (lastError) throw lastError;
  return lastResponse!;
}

function combinedSignal(a: AbortSignal | null | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([a, b]);
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const abort = () => controller.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function throttleJupiter(): Promise<void> {
  const scheduled = jupiterQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, nextJupiterRequestAt - now);
    if (waitMs > 0) await sleep(waitMs);
    nextJupiterRequestAt = Date.now() + JUPITER_MIN_INTERVAL_MS;
  });
  jupiterQueue = scheduled.catch(() => {});
  return scheduled;
}

function jupiterHeaders(input?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {};
  if (input instanceof Headers) {
    input.forEach((value, key) => { headers[key] = value; });
  } else if (Array.isArray(input)) {
    for (const [key, value] of input) headers[key] = value;
  } else if (input) {
    Object.assign(headers, input);
  }
  if (config.execution.jupiterApiKey) headers["x-api-key"] = config.execution.jupiterApiKey;
  return headers;
}

function isRetryableJupiterStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let encoded = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded += alphabet[0];
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) encoded += alphabet[digits[index]];
  return encoded;
}

export { isSanePrice, isSanePriceChange };

export const jupiterClient = new JupiterClient();
