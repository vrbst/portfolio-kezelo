import { describe, expect, it } from "vitest";
import type { Transaction } from "../model";
import { matchExisting } from "./match";

// Invented rows. "c0ll1de" stands for a 32-bit hash two different rows share.

const tx = (id: string, grossAmount: number, date = "2026-09-01T10:00:00.000Z"): Transaction => ({
  id,
  accountId: "ly-test",
  date,
  type: "buy",
  instrumentKey: "IE00TEST0001",
  quantity: 1,
  currency: "EUR",
  grossAmount,
  netAmount: -grossAmount,
});

const stored = (...txs: Transaction[]) => new Map(txs.map((t) => [t.id, t]));

describe("matchExisting", () => {
  it("the same transaction again is a re-import, skipped", () => {
    const r = matchExisting([tx("a1", 100)], stored(tx("a1", 100)));
    expect(r.newTxs).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.isNew).toEqual([false]);
  });

  it("a different transaction on a taken id is kept under a suffixed id", () => {
    const r = matchExisting([tx("c0ll1de", 250)], stored(tx("c0ll1de", 100)));
    expect(r.newTxs.map((t) => [t.id, t.grossAmount])).toEqual([["c0ll1de~x", 250]]);
    expect(r.skipped).toBe(0);
    expect(r.isNew).toEqual([true]);
  });

  it("importing the collided row again finds it under the suffix", () => {
    const r = matchExisting(
      [tx("c0ll1de", 250)],
      stored(tx("c0ll1de", 100), tx("c0ll1de~x", 250)),
    );
    expect(r.newTxs).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it("new ids pass through unchanged", () => {
    const fresh = tx("b2", 50);
    const r = matchExisting([fresh], stored(tx("a1", 100)));
    expect(r.newTxs).toEqual([fresh]);
  });

  it("a row moved onto a suffix never shares it with another row of the same import", () => {
    const parsed = [tx("c0ll1de", 250), tx("c0ll1de~x", 300)];
    const r = matchExisting(parsed, stored(tx("c0ll1de", 100)));
    const ids = r.newTxs.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
    expect(r.newTxs.map((t) => [t.id, t.grossAmount])).toEqual([
      ["c0ll1de~x", 250],
      ["c0ll1de~x~x", 300],
    ]);
    const again = matchExisting(parsed, stored(tx("c0ll1de", 100), ...r.newTxs));
    expect(again.newTxs).toEqual([]);
  });
});
