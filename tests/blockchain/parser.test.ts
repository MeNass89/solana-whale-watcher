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
});
