import { describe, expect, it } from "vitest";
import { parseEnhancedTransaction } from "../../src/blockchain/transaction-parser.js";

describe("parseEnhancedTransaction", () => {
  it("parses a wallet SOL to token swap as a BUY", () => {
    const trades = parseEnhancedTransaction(
      {
        signature: "sig",
        source: "JUPITER",
        timestamp: 1000,
        nativeTransfers: [{ fromUserAccount: "wallet", toUserAccount: "pool", amount: 2_000_000_000 }],
        tokenTransfers: [{ fromUserAccount: "pool", toUserAccount: "wallet", mint: "mint", tokenAmount: 100 }]
      },
      new Set(["wallet"])
    );

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ tradeType: "BUY", amountSol: 2, tokenMint: "mint" });
  });

  it("ignores quote mints so a USDC to SOL conversion is not a BUY of wSOL", () => {
    const trades = parseEnhancedTransaction(
      {
        signature: "sig2",
        source: "JUPITER",
        timestamp: 1000,
        nativeTransfers: [{ fromUserAccount: "wallet", toUserAccount: "pool", amount: 5_000_000 }],
        tokenTransfers: [
          { fromUserAccount: "wallet", toUserAccount: "pool", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: 1000 },
          { fromUserAccount: "pool", toUserAccount: "wallet", mint: "So11111111111111111111111111111111111111112", tokenAmount: 13 }
        ]
      },
      new Set(["wallet"])
    );

    expect(trades).toHaveLength(0);
  });

  it("still parses a memecoin BUY when a wSOL leg rides along", () => {
    const trades = parseEnhancedTransaction(
      {
        signature: "sig3",
        source: "JUPITER",
        timestamp: 1000,
        nativeTransfers: [{ fromUserAccount: "wallet", toUserAccount: "pool", amount: 2_000_000_000 }],
        tokenTransfers: [
          { fromUserAccount: "wallet", toUserAccount: "pool", mint: "So11111111111111111111111111111111111111112", tokenAmount: 2 },
          { fromUserAccount: "pool", toUserAccount: "wallet", mint: "memecoin", tokenAmount: 100 }
        ]
      },
      new Set(["wallet"])
    );

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ tradeType: "BUY", tokenMint: "memecoin", amountSol: 2 });
  });
});
