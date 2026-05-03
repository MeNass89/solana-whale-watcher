import { describe, expect, it } from "vitest";
import { getThreshold } from "../../src/config/thresholds.js";

describe("getThreshold", () => {
  it("uses the planned log2 threshold with a minimum of two", () => {
    expect(getThreshold(3)).toBe(2);
    expect(getThreshold(5)).toBe(3);
    expect(getThreshold(500)).toBe(9);
  });
});
