import {
  Keypair,
  PublicKey,
  VersionedTransaction
} from "@solana/web3.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getRpcRouter, type RpcRouter } from "../blockchain/rpc-router.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoS2GPGkdbz5PSx9GP";

const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";
const JUPITER_PRICE_URL = "https://api.jup.ag/price/v2";
const PRICE_BATCH_SIZE = 100;
const PRICE_BATCH_DELAY_MS = 200;
const PRICE_429_BASE_DELAY_MS = 2_000;
const PRICE_429_MAX_RETRIES = 3;
const QUOTE_MAX_AGE_MS = 3_000;
const SEND_INTERVAL_MS = 500;
const CONFIRM_TIMEOUT_MS = 60_000;
const TIP_HARD_CAP_LAMPORTS = 15_000_000;
const MIN_SANE_PRICE_USD = 1e-15;
const MAX_SANE_PRICE_USD = 1e6;
const MAX_PRICE_CHANGE_RATIO = 100;

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
  private readonly router: RpcRouter;
  private readonly wallet: Keypair | null;
  private readonly mintDecimalsCache = new Map<string, number>();

  constructor() {
    this.router = getRpcRouter();
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
      const response = await fetch(url);
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

  /**
   * Batch-fetch USD prices for multiple mints in one call using Jupiter Price
   * API v2. Chunks into batches of PRICE_BATCH_SIZE with delays between them.
   * Returns a Map<mint, price>. Mints that fail resolve to null.
   */
  async getPricesUsdBatch(mints: string[]): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    if (mints.length === 0) return result;

    // Dedupe and handle known stablecoins locally
    const unique = [...new Set(mints)];
    const toFetch: string[] = [];
    for (const mint of unique) {
      if (mint === USDC_MINT) {
        result.set(mint, 1);
      } else {
        toFetch.push(mint);
      }
    }

    // Process in batches
    for (let i = 0; i < toFetch.length; i += PRICE_BATCH_SIZE) {
      const batch = toFetch.slice(i, i + PRICE_BATCH_SIZE);
      const ids = batch.join(",");
      let fetched = false;

      for (let attempt = 0; attempt <= PRICE_429_MAX_RETRIES; attempt++) {
        try {
          const url = `${JUPITER_PRICE_URL}?ids=${ids}&vsToken=${USDC_MINT}`;
          const response = await fetch(url);

          if (response.status === 429) {
            const delay = PRICE_429_BASE_DELAY_MS * 2 ** attempt;
            logger.warn({ attempt, delay, batchSize: batch.length }, "Jupiter Price API 429 — backing off");
            await sleep(delay);
            continue;
          }

          if (!response.ok) {
            logger.warn({ status: response.status, batchSize: batch.length }, "Jupiter batch price request failed");
            for (const mint of batch) result.set(mint, null);
            fetched = true;
            break;
          }

          const body = (await response.json()) as { data?: Record<string, { price?: string | number }> };
          const data = body.data ?? {};
          for (const mint of batch) {
            const entry = data[mint];
            const raw = entry?.price;
            const price = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
            if (Number.isFinite(price) && isSanePrice(price)) {
              result.set(mint, price);
            } else {
              result.set(mint, null);
            }
          }
          fetched = true;
          break;
        } catch (error) {
          if (attempt === PRICE_429_MAX_RETRIES) {
            logger.warn({ err: error instanceof Error ? error.message : String(error), batchSize: batch.length }, "Jupiter batch price: all retries failed");
            for (const mint of batch) result.set(mint, null);
            fetched = true;
          } else {
            await sleep(PRICE_429_BASE_DELAY_MS * 2 ** attempt);
          }
        }
      }

      if (!fetched) {
        for (const mint of batch) result.set(mint, null);
      }

      // Delay between batches to avoid hammering
      if (i + PRICE_BATCH_SIZE < toFetch.length) {
        await sleep(PRICE_BATCH_DELAY_MS);
      }
    }

    return result;
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

    const response = await fetch(url);
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
    const quote = await this.getQuote(params).catch((error) => {
      logger.warn({ error }, "Jupiter paper quote unavailable; using price fallback");
      return null;
    });
    const inputAmount = await this.rawAmountToUi(params.inputMint, params.amountLamports, quote?.inputDecimals);
    if (quote && BigInt(quote.inAmount) !== params.amountLamports) {
      // A mismatched quote means the swap simulation priced a different size
      // than we requested. Recording the fill against the requested size
      // would attribute a wrong entry price; rejecting is safer than silent
      // P&L corruption.
      throw new Error(
        `jupiter: quote.inAmount (${quote.inAmount}) does not match requested amountLamports (${params.amountLamports.toString()})`
      );
    }
    if (quote?.priceImpactPct) {
      const allowedImpactPct = this.exitSlippageBps(params) / 100;
      if (Number(quote.priceImpactPct) > allowedImpactPct) {
        throw new Error(`Price impact ${quote.priceImpactPct}% exceeds ${allowedImpactPct}% limit`);
      }
    }
    let outputAmount: number;
    if (quote) {
      outputAmount = await this.rawAmountToUi(params.outputMint, BigInt(quote.outAmount), quote.outputDecimals);
    } else {
      outputAmount = await this.fallbackOutputAmount(params, inputAmount);
    }
    // Sanity-check both branches: a malformed quote (e.g. wrong decimals) can
    // also produce an absurd outputAmount that would poison downstream PnL.
    if (!Number.isFinite(outputAmount) || outputAmount <= 0 || outputAmount > 1e30) {
      logger.warn({ inputMint: params.inputMint, outputMint: params.outputMint, outputAmount, quoted: Boolean(quote) }, "paper swap: produced insane output amount, rejecting");
      throw new Error("Paper swap pricing produced invalid amount");
    }

    return {
      txSignature: `paper-${Date.now()}`,
      inputAmount,
      outputAmount,
      priceImpactPct: quote ? Number(quote.priceImpactPct ?? 0) : 0,
      executedAt: Math.floor(Date.now() / 1000)
    };
  }

  private async fallbackOutputAmount(params: SwapParams, inputAmount: number): Promise<number> {
    const inputPrice = params.inputMint === USDC_MINT ? 1 : await this.getPriceUsd(params.inputMint);
    const outputPrice = params.outputMint === USDC_MINT ? 1 : await this.getPriceUsd(params.outputMint);
    if (!inputPrice || !outputPrice) return 0;
    return (inputAmount * inputPrice) / outputPrice;
  }

  private async freshQuote(params: SwapParams): Promise<JupiterQuote> {
    let quote = await this.getQuote(params);
    if (Date.now() - quote.quotedAt > QUOTE_MAX_AGE_MS) quote = await this.getQuote(params);
    return quote;
  }

  private async buildSwapTransaction(quote: JupiterQuote, params: SwapParams): Promise<JupiterSwapResponse> {
    if (!this.wallet) throw new Error("Wallet not configured");
    const response = await fetch(JUPITER_SWAP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      const status = await this.router.call("getSignatureStatuses", (c) => c.getSignatureStatuses([signature]));
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
    if (mint === SOL_MINT) return this.router.call("getBalance", (c) => c.getBalance(pubkey));
    const accounts = await this.router.call("getParsedTokenAccountsByOwner", (c) =>
      c.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(mint) })
    );
    return accounts.value.reduce((sum, account) => {
      const info = account.account.data.parsed.info as { tokenAmount?: { amount?: string } };
      return sum + Number(info.tokenAmount?.amount ?? 0);
    }, 0);
  }

  private async assertNetworkHealthy(): Promise<void> {
    const samples = await this.router.call("getRecentPerformanceSamples", (c) => c.getRecentPerformanceSamples(1));
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

  private async tokenDecimals(mint: string): Promise<number> {
    const known = knownTokenDecimals(mint);
    if (known !== null) return known;

    const cached = this.mintDecimalsCache.get(mint);
    if (cached !== undefined) return cached;

    const mintKey = new PublicKey(mint);
    const account = await this.router.call("getAccountInfo", (c) => c.getAccountInfo(mintKey));
    const decimals = account?.data[44];
    if (decimals === undefined) {
      logger.warn({ mint }, "Token mint decimals unavailable; defaulting to 9");
      return 9;
    }

    this.mintDecimalsCache.set(mint, decimals);
    return decimals;
  }
}

function parseWalletKeypair(secret: string): Keypair {
  if (!secret) throw new Error("SOLANA_WALLET_PRIVATE is empty");
  const values = JSON.parse(secret) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(values));
}

function knownTokenDecimals(mint: string): number | null {
  if (mint === SOL_MINT) return 9;
  if (mint === USDC_MINT || mint === USDT_MINT) return 6;
  return null;
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
