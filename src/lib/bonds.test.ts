import { describe, expect, it } from "vitest";
import type { Instrument } from "./model";
import type { PortfolioSummary } from "./portfolio";
import { futureBondCashflows } from "./bonds";

// Invented sample data. The app stores a maturity picked as a local day as
// the ISO timestamp of LOCAL midnight — in Budapest "2026-10-28" becomes
// "2026-10-27T23:00:00.000Z". Built here from the local date, so the test
// means the same in any time zone.

const localMidnightIso = (y: number, m0: number, d: number) => new Date(y, m0, d).toISOString();

const dkj = (maturity: string): Instrument => ({
  key: "dkj",
  name: "DKJ",
  type: "tbill",
  currency: "HUF",
  faceValue: 1,
  maturity,
});

const summaryWith = (inst: Instrument) =>
  ({
    accounts: [{ account: { id: "k" }, holdings: [{ instrument: inst, instrumentKey: inst.key, quantity: 1_000_000 }] }],
  }) as unknown as PortfolioSummary;

describe("bond cash flows – maturity stored as an ISO timestamp", () => {
  it("the maturity lands on the local day, not the UTC day before", () => {
    const cf = futureBondCashflows(summaryWith(dkj(localMidnightIso(2026, 9, 28))), new Date(2026, 8, 28));
    expect(cf.map((c) => [c.kind, c.date])).toEqual([["maturity", "2026-10-28"]]);
  });

  it("a plain day string is unchanged", () => {
    const cf = futureBondCashflows(summaryWith(dkj("2026-10-28")), new Date(2026, 8, 28));
    expect(cf.map((c) => c.date)).toEqual(["2026-10-28"]);
  });
});
