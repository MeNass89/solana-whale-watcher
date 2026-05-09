import { afterEach, describe, expect, it, vi } from "vitest";
import { DexScreenerClient, DexScreenerRateLimitError } from "../blockchain/dexscreener-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DexScreenerClient", () => {
  it("exports the class", () => {
    expect(DexScreenerClient).toBeDefined();
  });

  it("returns empty array for a 404 not-found mint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 404 })));
    const result = await new DexScreenerClient().getTokenPairs("invalidmint123");
    expect(result).toEqual([]);
  });

  it("returns empty array on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const result = await new DexScreenerClient().getTokenPairs("anymint");
    expect(result).toEqual([]);
  });

  it("throws DexScreenerRateLimitError on 429 so callers can back off", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Too Many Requests", { status: 429, headers: { "retry-after": "2" } })));
    await expect(new DexScreenerClient().getTokenPairs("anymint")).rejects.toBeInstanceOf(DexScreenerRateLimitError);
  });
});
