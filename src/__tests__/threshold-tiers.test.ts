import { describe, it, expect } from "vitest";
import { getThreshold, getMinWalletsForTier } from "../config/thresholds.js";

describe("convergence thresholds", () => {
  it("requires minimum 2 wallets regardless of pool size", () => {
    expect(getThreshold(1)).toBe(2);
    expect(getThreshold(0)).toBe(2);
  });

  it("CRITICAL requires 3 wallets", () => {
    expect(getMinWalletsForTier("CRITICAL")).toBe(3);
  });

  it("NOTABLE requires 2 wallets", () => {
    expect(getMinWalletsForTier("NOTABLE")).toBe(2);
  });

  it("WATCH requires 1 wallet (observation only)", () => {
    expect(getMinWalletsForTier("WATCH")).toBe(1);
  });
});
