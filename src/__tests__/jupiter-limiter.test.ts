import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadClient() {
  vi.resetModules();
  vi.stubEnv("HELIUS_API_KEY", "test-helius");
  vi.stubEnv("JUPITER_API_KEY", "test-jupiter");
  vi.doMock("../blockchain/token-decimals.js", () => ({
    tokenDecimalsResolver: { resolve: vi.fn().mockResolvedValue(9) }
  }));
  const mod = await import("../execution/jupiter-client.js");
  return mod;
}

function quoteResponse(outAmount = "2000000000") {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputMint: "mint-a",
      inAmount: "1000000",
      outAmount,
      outputDecimals: 9,
      priceImpactPct: "0"
    }),
    text: vi.fn().mockResolvedValue("")
  };
}

describe("JupiterClient limiter and backoff", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("honors Retry-After on 429 and sends the optional API key header", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (name: string) => name.toLowerCase() === "retry-after" ? "3" : null },
        text: vi.fn().mockResolvedValue("rate limited")
      })
      .mockResolvedValueOnce(quoteResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { JupiterClient, USDC_MINT } = await loadClient();
    const client = new JupiterClient();

    const quotePromise = client.getQuote({ inputMint: USDC_MINT, outputMint: "mint-a", amountLamports: 1_000_000n, slippageBps: 300 });
    await vi.advanceTimersByTimeAsync(6_000);
    const quote = await quotePromise;

    expect(quote.outAmount).toBe("2000000000");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "x-api-key": "test-jupiter" });
  }, 10_000);

  it("spaces quote requests at no more than 0.5 rps", async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(quoteResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const { JupiterClient, USDC_MINT } = await loadClient();
    const client = new JupiterClient();

    const first = client.getQuote({ inputMint: USDC_MINT, outputMint: "mint-a", amountLamports: 1_000_000n, slippageBps: 300 });
    const second = client.getQuote({ inputMint: USDC_MINT, outputMint: "mint-a", amountLamports: 1_000_000n, slippageBps: 300 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 5_000);

  it("retries thrown network errors inside the Jupiter retry loop", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(quoteResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { JupiterClient, USDC_MINT } = await loadClient();
    const client = new JupiterClient();

    const quotePromise = client.getQuote({ inputMint: USDC_MINT, outputMint: "mint-a", amountLamports: 1_000_000n, slippageBps: 300 });
    await vi.advanceTimersByTimeAsync(3_000);
    const quote = await quotePromise;

    expect(quote.outAmount).toBe("2000000000");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prices exits from the actual token-to-USDC quote size", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        inputMint: "mint-a",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "2500000000",
        outAmount: "500000000",
        inputDecimals: 9,
        outputDecimals: 6,
        priceImpactPct: "1.2"
      }),
      text: vi.fn().mockResolvedValue("")
    });
    vi.stubGlobal("fetch", fetchMock);
    const { JupiterClient } = await loadClient();
    const client = new JupiterClient();

    const price = await client.getExitPriceUsd("mint-a", 2.5);

    expect(price).toBe(200);
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("inputMint")).toBe("mint-a");
    expect(url.searchParams.get("outputMint")).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(url.searchParams.get("amount")).toBe("2500000000");
  });
});
