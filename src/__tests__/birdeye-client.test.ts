import { describe, it, expect } from "vitest";
import { BirdEyeClient } from "../blockchain/birdeye-client.js";

describe("BirdEyeClient", () => {
  it("exports the class", () => {
    expect(BirdEyeClient).toBeDefined();
  });

  it("getTokenOverview returns null when no API key", async () => {
    const client = new BirdEyeClient("");
    const result = await client.getTokenOverview("So11111111111111111111111111111111111111112");
    expect(result).toBeNull();
  });
});
