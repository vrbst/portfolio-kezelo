import { describe, expect, it } from "vitest";
import type { BondTerms, Instrument } from "./model";
import type { PortfolioSummary } from "./portfolio";
import {
  bondMarketValue,
  couponAmountHuf,
  currentRate,
  futureBondCashflows,
  hasCouponTerms,
  nextCouponDate,
  rateOn,
  redemptionHuf,
} from "./bonds";
import { withBondRates, type BondRatesFile } from "./bondRates";

const FACE = 1_000_000;
const ms = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const frac = (from: number, now: number, to: number) => (now - from) / (to - from);

const bond = (name: string, terms: BondTerms): Instrument => ({
  key: name,
  name,
  type: "gov_bond",
  currency: "HUF",
  faceValue: 1,
  maturity: terms.maturity,
  bond: terms,
});

const summaryWith = (inst: Instrument) =>
  ({
    accounts: [{ account: { id: "mak" }, holdings: [{ instrument: inst, instrumentKey: inst.key, quantity: FACE }] }],
  }) as unknown as PortfolioSummary;

const value = (inst: Instrument, now: number) => bondMarketValue(inst, FACE, FACE, now, now);

const pmap = bond("Prémium Magyar Állampapír 2030/I", {
  couponRate: 0.065,
  couponIntervalMonths: 12,
  firstCouponDate: "2025-03-15",
  maturity: "2030-03-15",
  rates: [{ from: "2026-03-15", rate: 0.0425 }],
});

describe("rate per interest period", () => {
  it("the typed-in rate holds until the first known period, then the period's rate", () => {
    expect(rateOn(pmap.bond, ms(2025, 6, 1))).toBe(0.065);
    expect(rateOn(pmap.bond, ms(2026, 3, 15))).toBe(0.0425);
    expect(rateOn(pmap.bond, ms(2029, 1, 1))).toBe(0.0425);
    expect(currentRate(pmap.bond, new Date(2026, 8, 15))).toBe(0.0425);
  });

  it("with only periods known, the earliest one covers the time before it", () => {
    const b: BondTerms = { rates: [{ from: "2027-01-01", rate: 0.05 }, { from: "2026-01-01", rate: 0.06 }] };
    expect(rateOn(b, ms(2025, 1, 1))).toBe(0.06);
    expect(rateOn(b, ms(2027, 6, 1))).toBe(0.05);
    expect(hasCouponTerms(b)).toBe(true);
    expect(hasCouponTerms({})).toBe(false);
  });

  it("accrues the current period at the current period's rate", () => {
    const now = ms(2026, 9, 15);
    const expected = FACE * (1 + 0.0425 * frac(ms(2026, 3, 15), now, ms(2027, 3, 15)));
    expect(value(pmap, now).value).toBeCloseTo(expected, 2);
  });

  it("each coupon is paid at the rate of the period it closes", () => {
    expect(couponAmountHuf(pmap.bond, FACE, "2026-03-15")).toBeCloseTo(65_000, 6);
    expect(couponAmountHuf(pmap.bond, FACE, "2027-03-15")).toBeCloseTo(42_500, 6);
  });

  it("future coupons carry the last known rate until a new period is published", () => {
    const cf = futureBondCashflows(summaryWith(pmap), new Date(2026, 8, 15)).filter((c) => c.kind === "coupon");
    expect(cf.map((c) => c.date)).toEqual(["2027-03-15", "2028-03-15", "2029-03-15", "2030-03-15"]);
    for (const c of cf) expect(c.amountHuf).toBeCloseTo(42_500, 6);
  });

  it("a step-up series pays more each year as the periods say", () => {
    const plus = bond("Magyar Állampapír Plusz 2029/A", {
      couponIntervalMonths: 12,
      firstCouponDate: "2025-05-10",
      maturity: "2029-05-10",
      rates: [
        { from: "2024-05-10", rate: 0.045 },
        { from: "2025-05-10", rate: 0.05 },
        { from: "2026-05-10", rate: 0.055 },
      ],
    });
    expect(couponAmountHuf(plus.bond, FACE, "2026-05-10")).toBeCloseTo(50_000, 6);
    expect(couponAmountHuf(plus.bond, FACE, "2027-05-10")).toBeCloseTo(55_000, 6);
  });
});

describe("payment frequency", () => {
  it("a monthly payer: twelfth of the yearly coupon, every month", () => {
    const monthly = bond("Havi kamatozású 2027/A", {
      couponRate: 0.06,
      couponIntervalMonths: 1,
      firstCouponDate: "2026-01-10",
      maturity: "2027-01-10",
    });
    expect(nextCouponDate(monthly.bond, new Date(2026, 8, 15))).toBe("2026-10-10");
    const cf = futureBondCashflows(summaryWith(monthly), new Date(2026, 8, 15)).filter((c) => c.kind === "coupon");
    expect(cf.map((c) => c.date)).toEqual(["2026-10-10", "2026-11-10", "2026-12-10", "2027-01-10"]);
    for (const c of cf) expect(c.amountHuf).toBeCloseTo(5_000, 6);
  });

  it("a half-yearly payer accrues over its six-month period", () => {
    const half = bond("Féléves 2028/A", {
      couponRate: 0.05,
      couponIntervalMonths: 6,
      firstCouponDate: "2026-04-01",
      maturity: "2028-04-01",
    });
    const now = ms(2026, 7, 1);
    const expected = FACE * (1 + 0.025 * frac(ms(2026, 4, 1), now, ms(2026, 10, 1)));
    expect(value(half, now).value).toBeCloseTo(expected, 2);
  });
});

describe("capitalizing bond (interest paid at maturity)", () => {
  const baba = bond("Babakötvény 2027/S_BABA", {
    capitalizing: true,
    issueDate: "2024-02-01",
    maturity: "2027-02-01",
    firstCouponDate: "2025-02-01",
    rates: [
      { from: "2024-02-01", rate: 0.07 },
      { from: "2025-02-01", rate: 0.05 },
      { from: "2026-02-01", rate: 0.074 },
    ],
  });

  it("the yearly interest compounds into the value", () => {
    const now = ms(2026, 8, 1);
    const expected = FACE * 1.07 * 1.05 * (1 + 0.074 * frac(ms(2026, 2, 1), now, ms(2027, 2, 1)));
    expect(value(baba, now).value).toBeCloseTo(expected, 2);
  });

  it("no coupons on the way, the whole amount at maturity", () => {
    const cf = futureBondCashflows(summaryWith(baba), new Date(2026, 7, 1));
    expect(cf.map((c) => c.kind)).toEqual(["maturity"]);
    expect(cf[0].amountHuf).toBeCloseTo(FACE * 1.07 * 1.05 * 1.074, 2);
    expect(redemptionHuf(baba.bond, FACE)).toBeCloseTo(FACE * 1.07 * 1.05 * 1.074, 2);
    expect(nextCouponDate(baba.bond, new Date(2026, 7, 1))).toBeUndefined();
    expect(couponAmountHuf(baba.bond, FACE, "2026-02-01")).toBeUndefined();
  });

  it("without an issue date it is valued at par and asks for the data", () => {
    const noIssue = bond("Babakötvény 2045/S_BABA", { capitalizing: true, rates: [{ from: "2026-02-01", rate: 0.074 }] });
    expect(value(noIssue, ms(2026, 8, 1))).toMatchObject({ value: FACE, needsData: true });
  });
});

describe("from the ÁKK file to the value", () => {
  it("a PMÁP with a stale typed-in rate is valued at the published period rate", () => {
    const typed = bond("Prémium Magyar Állampapír 2030/I", {
      couponRate: 0.065,
      couponIntervalMonths: 12,
      firstCouponDate: "2025-03-15",
      maturity: "2030-03-15",
    });
    const file: BondRatesFile = {
      updatedAt: "2026-09-14T18:00:00.000Z",
      retail: [],
      dkj: [],
      periods: [
        { type: "PMÁP", series: "2030/I", rate: 4.25, periodStart: "2026-03-15", periodEnd: "2027-03-15", paymentDate: "2027-03-15", maturity: "2030-03-15", currency: "HUF" },
      ],
    };
    const [filled] = withBondRates([typed], file);
    const now = ms(2026, 9, 15);
    const expected = FACE * (1 + 0.0425 * frac(ms(2026, 3, 15), now, ms(2027, 3, 15)));
    expect(value(filled, now).value).toBeCloseTo(expected, 2);
    expect(value(typed, now).value).toBeGreaterThan(expected);
  });
});
