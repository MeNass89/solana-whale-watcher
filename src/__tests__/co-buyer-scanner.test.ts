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
  find: vi.fn().mockImplementation((addr: string) =>
    addr === "existingWallet" ? { address: addr } : null
  ),
  upsert: vi.fn()
};

describe("discoverCoBuyers", () => {
  it("inserts new wallets found trading same token in window", async () => {
    const result = await discoverCoBuyers(mockDb as any, mockWallets as any, "tokenMint1", 1700000000, 120);
    expect(mockWallets.upsert).toHaveBeenCalledTimes(2);
    expect(result).toBe(2);
  });
});
