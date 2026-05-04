import { describe, it, expect } from "vitest";
import { getThreshold } from "../config/thresholds.js";

describe("getThreshold (tiered)", () => {
  it("uses core count for threshold, not total", () => {
    const result = getThreshold(15, 44);
    expect(result).toBe(Math.max(2, Math.floor(Math.log2(15) + 1)));
  });

  it("returns 2 as minimum", () => {
    expect(getThreshold(1, 10)).toBe(2);
  });

  it("ignores total when core is provided", () => {
    const a = getThreshold(10, 59);
    const b = getThreshold(10, 200);
    expect(a).toBe(b);
  });
});
