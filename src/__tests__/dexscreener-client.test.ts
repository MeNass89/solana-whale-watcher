import { describe, it, expect } from "vitest";
import { DexScreenerClient } from "../blockchain/dexscreener-client.js";

describe("DexScreenerClient", () => {
  it("exports the class", () => {
    expect(DexScreenerClient).toBeDefined();
  });

  it("getTokenPairs returns empty array for invalid mint", async () => {
    const client = new DexScreenerClient();
    const result = await client.getTokenPairs("invalidmint123");
    expect(result).toEqual([]);
  });
});
