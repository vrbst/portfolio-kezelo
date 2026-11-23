import { describe, it, expect } from "vitest";
import { settle, type SettleState } from "./settledValue";

/** Feeds frames [current, loading, timedOut]; returns what is shown. */
function run(frames: [number, boolean, boolean?][]) {
  let st: SettleState<number> | null = null;
  const shown: number[] = [];
  for (const [cur, loading, timedOut] of frames) {
    st = settle(st, cur, loading, timedOut ?? false);
    shown.push(st.shown);
  }
  return { shown, st: st! };
}

describe("settle", () => {
  it("shows the first value at once", () => {
    expect(run([[100, true]]).shown).toEqual([100]);
  });

  it("holds the previous value for a whole price round, then releases once", () => {
    // settled at 100; a round starts and the total wobbles through mixed values
    const { shown } = run([
      [100, false],
      [100, true], // round starts
      [103, true], // snapshot
      [98, true], // new FX × old prices
      [101, true], // partial quotes
      [102, true], // off-hours cross-check
      [102.5, false], // round ends
    ]);
    expect(shown).toEqual([100, 100, 100, 100, 100, 100, 102.5]);
    expect(new Set(shown).size).toBe(2);
  });

  it("shows a change that arrives outside a round (import, manual price) at once", () => {
    expect(
      run([
        [100, false],
        [120, false],
      ]).shown,
    ).toEqual([100, 120]);
  });

  it("lets go after the max hold so a stalled security cannot pin the number", () => {
    const { shown } = run([
      [100, false],
      [100, true],
      [101, true],
      [102, true, true], // the hold timer fired
      [103, true, true], // released: follows live values again
      [104, false],
    ]);
    expect(shown).toEqual([100, 100, 100, 102, 103, 104]);
  });

  it("holds again in the next round after a release", () => {
    const { shown } = run([
      [100, false],
      [100, true],
      [105, true, true], // released by the max hold
      [106, false], // round over
      [106, true], // next round starts
      [90, true],
      [107, false],
    ]);
    expect(shown).toEqual([100, 100, 105, 106, 106, 106, 107]);
  });

  it("reports holding only while it holds", () => {
    const { st } = run([
      [100, false],
      [100, true],
      [101, true],
    ]);
    expect(st.holding).toBe(true);
    expect(run([[100, false]]).st.holding).toBe(false);
  });
});
