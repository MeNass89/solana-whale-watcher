import { describe, it, expect } from "vitest";
import { isSanePrice, isSanePriceChange } from "../execution/jupiter-client.js";

describe("price sanity checks", () => {
  it("rejects NaN, Infinity, negative prices", () => {
    expect(isSanePrice(Number.NaN)).toBe(false);
    expect(isSanePrice(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSanePrice(-1)).toBe(false);
  });

  // Contract: isSanePrice accepts the open interval (1e-15, 1e6).
  // Boundary values themselves are rejected — this is intentional, since
  // exact 1e-15 / 1e6 quotes are far more likely to be a stale or stuck
  // feed than a real meme-coin / large-cap price.
  it("rejects prices at or below 1e-15", () => {
    expect(isSanePrice(1e-16)).toBe(false);
    expect(isSanePrice(1e-15)).toBe(false);
  });

  it("rejects prices at or above 1e6", () => {
    expect(isSanePrice(1_000_000)).toBe(false);
    expect(isSanePrice(1_000_001)).toBe(false);
  });

  it("rejects 100x price changes in a single tick", () => {
    expect(isSanePriceChange(1, 100)).toBe(false);
    expect(isSanePriceChange(100, 1)).toBe(false);
  });

  it("accepts normal meme coin prices (1e-9 to 1e-3)", () => {
    expect(isSanePrice(1e-9)).toBe(true);
    expect(isSanePrice(1e-6)).toBe(true);
    expect(isSanePrice(1e-3)).toBe(true);
  });

  it("accepts normal price movements (2x, 5x)", () => {
    expect(isSanePriceChange(1e-6, 2e-6)).toBe(true);
    expect(isSanePriceChange(1e-6, 5e-6)).toBe(true);
  });
});
