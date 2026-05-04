import { describe, it, expect } from "vitest";
import { JupiterClient } from "../execution/jupiter-client.js";

describe("slippageBpsForLiquidity", () => {
  const client = new JupiterClient();

  it("returns 100 bps for >$500k liquidity", () => {
    expect(client.slippageBpsForLiquidity(600_000)).toBe(100);
  });
  it("returns 300 bps for $100k-$500k liquidity", () => {
    expect(client.slippageBpsForLiquidity(200_000)).toBe(300);
  });
  it("returns 500 bps for $50k-$100k liquidity", () => {
    expect(client.slippageBpsForLiquidity(75_000)).toBe(500);
  });
  it("returns 2500 bps for <$50k liquidity (MEME tier)", () => {
    expect(client.slippageBpsForLiquidity(30_000)).toBe(2500);
  });
  it("returns 2500 bps for $10k liquidity", () => {
    expect(client.slippageBpsForLiquidity(10_000)).toBe(2500);
  });
  it("returns null for null/undefined liquidity", () => {
    expect(client.slippageBpsForLiquidity(null)).toBeNull();
    expect(client.slippageBpsForLiquidity(undefined)).toBeNull();
  });
});
