import { describe, expect, it } from "vitest";
import { getThreshold } from "../../src/config/thresholds.js";

describe("getThreshold", () => {
  it("returns 2 strict regardless of pool size", () => {
    expect(getThreshold(3)).toBe(2);
    expect(getThreshold(20)).toBe(2);
    expect(getThreshold(500)).toBe(2);
  });
});
