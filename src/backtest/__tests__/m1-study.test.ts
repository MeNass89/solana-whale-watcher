import { describe, expect, it } from "vitest";
import { deterministicSample, rankWalletsOnTrain, type M1Signal } from "../m1-study.js";

function sig(tokenMint: string, wallet: string, ts: number): M1Signal {
  return { tokenMint, wallet, ts, usd: 1000, isPump: tokenMint.endsWith("pump") };
}

describe("deterministicSample", () => {
  const signals = [
    sig("AAAAAzzzzzzzzzzzzzzz", "w1", 300),
    sig("BBBBBmmmmmmmmmmmmmmm", "w2", 100),
    sig("CCCCCaaaaaaaaaaaaaaa", "w3", 200)
  ];

  it("is order-independent and reproducible", () => {
    const a = deterministicSample(signals, 2);
    const b = deterministicSample([...signals].reverse(), 2);
    expect(a.map((s) => s.tokenMint)).toEqual(b.map((s) => s.tokenMint));
  });

  it("sorts by mint substring for selection, returns time-ordered", () => {
    const picked = deterministicSample(signals, 2);
    // substrings: "zzzz…" > "mmmm…" > "aaaa…" → picks C then B, then re-sorts by ts
    expect(picked.map((s) => s.tokenMint)).toEqual(["BBBBBmmmmmmmmmmmmmmm", "CCCCCaaaaaaaaaaaaaaa"]);
    expect(picked[0].ts).toBeLessThan(picked[1].ts);
  });
});

describe("rankWalletsOnTrain", () => {
  it("selects the top quartile using TRAIN signals only", () => {
    const signals: M1Signal[] = [];
    // 8 wallets × 5 train signals each; wallet w0 best, w7 worst
    for (let w = 0; w < 8; w++) {
      for (let i = 0; i < 5; i++) {
        signals.push(sig(`tok-${w}-${i}`, `w${w}`, 100 + i));
      }
    }
    // valid-half signal for w7 with a huge return must NOT affect ranking
    signals.push(sig("tok-late", "w7", 10_000));
    const rets = new Map(signals.map((s) => [s.tokenMint, s.tokenMint === "tok-late" ? 999 : 10 - Number(s.wallet.slice(1)) * 3]));
    const { elite, table } = rankWalletsOnTrain(signals, (s) => rets.get(s.tokenMint) ?? null, 5000);
    expect(table.length).toBe(8);
    expect(elite.size).toBe(2); // top quartile of 8
    expect(elite.has("w0")).toBe(true);
    expect(elite.has("w1")).toBe(true);
    expect(elite.has("w7")).toBe(false);
  });

  it("requires a minimum number of train signals", () => {
    const signals = [sig("t1", "w1", 100), sig("t2", "w1", 101)];
    const { table } = rankWalletsOnTrain(signals, () => 5, 5000, 5);
    expect(table.length).toBe(0);
  });
});
