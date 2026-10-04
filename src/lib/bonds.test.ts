import { describe, expect, it } from "vitest";
import type { Instrument } from "./model";
import type { PortfolioSummary } from "./portfolio";
import { bondMarketValue, futureBondCashflows, nextCouponDate } from "./bonds";

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

describe("coupon schedule on a month-end day", () => {
  // Invented quarterly series paying on the 31st (or the month's last day).
  const fix: Instrument = {
    key: "fix",
    name: "FIX",
    type: "gov_bond",
    currency: "HUF",
    faceValue: 1,
    bond: {
      couponRate: 0.06,
      couponIntervalMonths: 3,
      firstCouponDate: "2026-03-31",
      maturity: "2027-03-31",
    },
  };

  it("never drifts to the 1st or stays on a clamped 30th", () => {
    const cf = futureBondCashflows(summaryWith(fix), new Date(2026, 2, 1));
    expect(cf.filter((c) => c.kind === "coupon").map((c) => c.date)).toEqual([
      "2026-03-31",
      "2026-06-30",
      "2026-09-30",
      "2026-12-31",
      "2027-03-31",
    ]);
  });

  it("the next coupon after a 30 June one is 30 Sep, then 31 Dec", () => {
    expect(nextCouponDate(fix.bond, new Date(2026, 6, 1))).toBe("2026-09-30");
    expect(nextCouponDate(fix.bond, new Date(2026, 9, 1))).toBe("2026-12-31");
  });

  it("a full regular quarter accrues exactly the quarter's coupon", () => {
    // 30 Sep → 31 Dec: on the 31st the anchor is the new coupon, so look the
    // day before — nearly the full 1.5%.
    const v = bondMarketValue(fix, 1_000_000, 1_000_000, 0, new Date(2026, 11, 30).getTime());
    expect(v.value).toBeGreaterThan(1_014_800);
    expect(v.value).toBeLessThan(1_015_000);
  });
});
