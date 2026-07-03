import { describe, expect, it } from "vitest";
import { toSwapView } from "../chain.js";

const WSOL = "So11111111111111111111111111111111111111112";
const MEME = "MemeMint1111111111111111111111111111111111";
const BUYER = "Buyer111111111111111111111111111111111111";

function mockTx(overrides: {
  preBalances: number[];
  postBalances: number[];
  preToken?: Array<{ mint: string; owner: string; amount: number }>;
  postToken?: Array<{ mint: string; owner: string; amount: number }>;
  err?: unknown;
}): any {
  const toBal = (b: { mint: string; owner: string; amount: number }) => ({
    mint: b.mint,
    owner: b.owner,
    uiTokenAmount: { uiAmount: b.amount }
  });
  return {
    blockTime: 1_750_000_000,
    transaction: { message: { accountKeys: [{ pubkey: { toString: () => BUYER } }] } },
    meta: {
      err: overrides.err ?? null,
      preBalances: overrides.preBalances,
      postBalances: overrides.postBalances,
      preTokenBalances: (overrides.preToken ?? []).map(toBal),
      postTokenBalances: (overrides.postToken ?? []).map(toBal)
    }
  };
}

describe("toSwapView", () => {
  it("reads a native-SOL buy: SOL down, token up", () => {
    const view = toSwapView(
      mockTx({
        preBalances: [5e9],
        postBalances: [3e9],
        postToken: [{ mint: MEME, owner: BUYER, amount: 1000 }]
      })
    );
    expect(view?.feePayer).toBe(BUYER);
    expect(view?.solDelta).toBeCloseTo(-2);
    expect(view?.tokenDeltas.get(MEME)).toBe(1000);
  });

  it("folds WSOL movements into solDelta (router swaps)", () => {
    const view = toSwapView(
      mockTx({
        preBalances: [5e9],
        postBalances: [5e9 - 5000], // only the fee moves natively
        preToken: [{ mint: WSOL, owner: BUYER, amount: 10 }],
        postToken: [
          { mint: WSOL, owner: BUYER, amount: 7 },
          { mint: MEME, owner: BUYER, amount: 500 }
        ]
      })
    );
    expect(view?.solDelta).toBeCloseTo(-3, 3);
    expect(view?.tokenDeltas.get(MEME)).toBe(500);
    expect(view?.tokenDeltas.has(WSOL)).toBe(false);
  });

  it("ignores other owners' token balances and failed txs", () => {
    const view = toSwapView(
      mockTx({
        preBalances: [5e9],
        postBalances: [4e9],
        postToken: [{ mint: MEME, owner: "SomeoneElse", amount: 99 }]
      })
    );
    expect(view?.tokenDeltas.size).toBe(0);
    expect(toSwapView(mockTx({ preBalances: [1], postBalances: [1], err: { code: 1 } }))).toBeNull();
  });

  it("reads a sell: token down, SOL up", () => {
    const view = toSwapView(
      mockTx({
        preBalances: [1e9],
        postBalances: [4e9],
        preToken: [{ mint: MEME, owner: BUYER, amount: 800 }],
        postToken: [{ mint: MEME, owner: BUYER, amount: 0 }]
      })
    );
    expect(view?.solDelta).toBeCloseTo(3);
    expect(view?.tokenDeltas.get(MEME)).toBe(-800);
  });
});
