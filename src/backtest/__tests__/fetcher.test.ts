import { describe, expect, it } from "vitest";
import { coalesceWindows, mergeIntervals, MINUTE_REQUEST_SPAN } from "../fetcher.js";

describe("mergeIntervals", () => {
  it("merges overlapping intervals and keeps disjoint ones", () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 15, end: 30 },
        { start: 100, end: 110 }
      ])
    ).toEqual([
      { start: 10, end: 30 },
      { start: 100, end: 110 }
    ]);
  });
});

describe("coalesceWindows", () => {
  it("groups nearby windows into one request-sized interval", () => {
    const hour = 3600;
    // three convergences 2h apart → windows fit in one 1000-minute request
    const windows = [0, 2 * hour, 4 * hour].map((ft) => ({ start: ft - hour, end: ft + 2 * hour }));
    const groups = coalesceWindows(windows, MINUTE_REQUEST_SPAN);
    expect(groups).toEqual([{ start: -hour, end: 6 * hour }]);
  });

  it("splits when the merged span would exceed the request span", () => {
    const day = 86400;
    const windows = [0, 5 * day].map((ft) => ({ start: ft, end: ft + 3 * 3600 }));
    const groups = coalesceWindows(windows, MINUTE_REQUEST_SPAN);
    expect(groups).toHaveLength(2);
  });
});
