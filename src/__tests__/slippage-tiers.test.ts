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

  // Boundary exactness — guards against >= vs > drift in the tier ladder.
  it("boundary: 500_000 falls into 300 bps tier (uses > 500k for 100 bps)", () => {
    expect(client.slippageBpsForLiquidity(500_000)).toBe(300);
  });
  it("boundary: 100_000 falls into 300 bps tier (>= 100k)", () => {
    expect(client.slippageBpsForLiquidity(100_000)).toBe(300);
  });
  it("boundary: 50_000 falls into 500 bps tier (>= 50k)", () => {
    expect(client.slippageBpsForLiquidity(50_000)).toBe(500);
  });
  it("boundary: 5_000 falls into 2500 bps tier (>= 5k)", () => {
    expect(client.slippageBpsForLiquidity(5_000)).toBe(2500);
  });
  it("boundary: 4_999 returns null (below 5k floor)", () => {
    expect(client.slippageBpsForLiquidity(4_999)).toBeNull();
  });
});
