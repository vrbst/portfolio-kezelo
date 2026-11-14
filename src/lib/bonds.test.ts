import { describe, expect, it } from "vitest";
import type { Instrument } from "./model";
import type { PortfolioSummary } from "./portfolio";
import { bondValuationMs, bondMarketValue, futureBondCashflows, nextCouponDate } from "./bonds";

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

describe("a lejárat napja import előtt", () => {
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

  it("névérték + az utolsó kupon, nem csak a névérték", () => {
    const at = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
    for (const day of [at(2027, 3, 31), at(2027, 4, 2)]) {
      const v = bondMarketValue(fix, 1_000_000, 1_000_000, 0, day);
      expect(v.value).toBeCloseTo(1_015_000, 0);
    }
  });
});

describe("bondValuationMs – ünnepnapok", () => {
  const day = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
  const local = (ms: number) => new Date(ms).toDateString();

  it("az ünnepnap (2026-10-23, péntek) után a következő hétfő a nap", () => {
    expect(local(bondValuationMs(day(2026, 10, 23, 10)))).toBe(new Date(2026, 9, 26).toDateString());
    // csütörtök a vágás után: péntek ünnep, hétvége → hétfő
    expect(local(bondValuationMs(day(2026, 10, 22, 17)))).toBe(new Date(2026, 9, 26).toDateString());
  });

  it("áthelyezett pihenőnap (2026-08-21) is kimarad", () => {
    expect(local(bondValuationMs(day(2026, 8, 20, 17)))).toBe(new Date(2026, 7, 24).toDateString());
  });

  it("a hétköznapi és hétvégi szabály változatlan", () => {
    expect(local(bondValuationMs(day(2026, 10, 14, 10)))).toBe(new Date(2026, 9, 14).toDateString());
    expect(local(bondValuationMs(day(2026, 10, 14, 17)))).toBe(new Date(2026, 9, 15).toDateString());
    expect(local(bondValuationMs(day(2026, 10, 16, 15)))).toBe(new Date(2026, 9, 19).toDateString());
    expect(local(bondValuationMs(day(2026, 10, 17, 9)))).toBe(new Date(2026, 9, 19).toDateString());
  });
});
