import { describe, it, expect, vi } from "vitest";
import { discoverCoBuyers } from "../jobs/co-buyer-scanner.js";

const mockDb = {
  prepare: vi.fn().mockReturnValue({
    all: vi.fn().mockReturnValue([
      { wallet_address: "newWallet1" },
      { wallet_address: "newWallet2" },
      { wallet_address: "existingWallet" }
    ])
  })
};

const mockWallets = {
  insertIfMissing: vi.fn().mockImplementation((input: { address: string }) => input.address !== "existingWallet")
};

describe("discoverCoBuyers", () => {
  it("inserts new wallets found trading same token in window", async () => {
    const result = await discoverCoBuyers(mockDb as any, mockWallets as any, "tokenMint1", 1700000000, 120);
    expect(mockWallets.insertIfMissing).toHaveBeenCalledTimes(3);
    expect(result).toBe(2);
  });
});
