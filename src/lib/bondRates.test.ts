import { describe, expect, it } from "vitest";
import type { Instrument } from "./model";
import { bondMarketValue } from "./bonds";
import {
  buyableOffers,
  currentDkjSeries,
  dkjSeriesOfName,
  familyOfName,
  fillBondTerms,
  periodFor,
  seriesOfName,
  validateBondRatesFile,
  withBondRates,
  type BondRatesFile,
  type InterestPeriod,
} from "./bondRates";

const period = (p: Partial<InterestPeriod> & Pick<InterestPeriod, "type" | "series">): InterestPeriod => ({
  rate: 5,
  periodStart: "2026-07-22",
  periodEnd: "2026-10-22",
  paymentDate: "2026-10-22",
  maturity: null,
  currency: "HUF",
  ...p,
});

const file = (over: Partial<BondRatesFile> = {}): BondRatesFile => ({
  updatedAt: "2026-10-07T16:20:00.000Z",
  retail: [
    { type: "FixMÁP", series: "2029/Q2", rateText: "5.50", rateMin: 5.5, rateMax: 5.5, ehm: 5.62, maturity: "2029-10-25", currency: "HUF", validFrom: "2026-10-01", validTo: null },
    { type: "MÁP Plusz", series: "2031/M6", rateText: "5.00 - 6.00", rateMin: 5, rateMax: 6, ehm: 5.47, maturity: "2031-11-27", currency: "HUF", validFrom: "2026-10-01", validTo: null },
    { type: "BABA", series: "2045/S_BABA", rateText: "7.40", rateMin: 7.4, rateMax: 7.4, ehm: null, maturity: "2045-02-01", currency: "HUF", validFrom: "2026-02-01", validTo: "2027-01-31" },
    { type: "BMÁP", series: "2032/R1", rateText: "5.47", rateMin: 5.47, rateMax: 5.47, ehm: null, maturity: "2032-06-22", currency: "HUF", validFrom: "2026-06-22", validTo: "2026-09-21" },
    { type: "KTJ I", series: "KTJ_I", rateText: "4.50", rateMin: 4.5, rateMax: 4.5, ehm: 4.5, maturity: null, currency: "HUF", validFrom: "2026-06-15", validTo: null },
  ],
  periods: [
    period({ type: "FixMÁP", series: "2029/Q2", rate: 5.5, periodStart: "2026-07-25", periodEnd: "2026-10-25", paymentDate: "2026-10-25", maturity: "2029-10-25" }),
    period({ type: "PMÁP", series: "2027/J", rate: 5.15, periodStart: "2026-01-27", periodEnd: "2027-01-27", paymentDate: "2027-01-27", maturity: "2027-01-27" }),
    period({ type: "MÁPP_T", series: "2031/M1", rate: 6.5, periodStart: "2026-01-06", periodEnd: "2027-02-27", paymentDate: "2027-02-27", maturity: "2031-02-27" }),
    period({ type: "BMÁP", series: "2028/N", rate: 9.02, maturity: "2028-03-22" }),
    period({ type: "PMÁP", series: "2028/N", rate: 5.9, maturity: "2028-02-23" }),
  ],
  dkj: [
    { auctionDate: "2026-07-01", series: "D261007", isin: "HU0000000001", maturity: "2026-10-07", avgYield: 5.6 },
    { auctionDate: "2026-10-06", series: "D270120", isin: "HU0000000002", maturity: "2027-01-20", avgYield: 5.17 },
    { auctionDate: "2026-10-07", series: "D270428", isin: "HU0000000003", maturity: "2027-04-28", avgYield: 5.15 },
  ],
  ...over,
});

const bond = (name: string, extra: Partial<Instrument> = {}): Instrument => ({
  key: name.toLowerCase().replace(/\W+/g, "-"),
  name,
  type: "gov_bond",
  currency: "HUF",
  faceValue: 1,
  ...extra,
});

describe("series and family from a MÁK security name", () => {
  it.each([
    ["Fix Magyar Állampapír 2029/Q2", "FixMÁP", "2029/Q2"],
    ["Prémium Magyar Állampapír 2027/J", "PMÁP", "2027/J"],
    ["Prémium Euró Magyar Állampapír 2027/X_EUR", "PEMÁP", "2027/X_EUR"],
    ["Bónusz Magyar Állampapír 2028/N", "BMÁP", "2028/N"],
    ["Magyar Állampapír Plusz 2031/M1", "MÁP Plusz", "2031/M1"],
  ])("%s", (name, family, series) => {
    expect(familyOfName(name)).toBe(family);
    expect(seriesOfName(name)).toBe(series);
  });

  it("a DKJ by its D-code", () => {
    expect(dkjSeriesOfName("Diszkont Kincstárjegy D270428")).toBe("D270428");
    expect(dkjSeriesOfName("Fix Magyar Állampapír 2029/Q2")).toBeUndefined();
  });
});

describe("periodFor", () => {
  it("the same series name in two families needs the family from the name", () => {
    expect(periodFor(bond("Bónusz Magyar Állampapír 2028/N"), file())?.rate).toBe(9.02);
    expect(periodFor(bond("Prémium Magyar Állampapír 2028/N"), file())?.rate).toBe(5.9);
    expect(periodFor(bond("Állampapír 2028/N"), file())).toBeUndefined();
  });

  it("MÁPP_T rows count as MÁP Plusz", () => {
    expect(periodFor(bond("Magyar Állampapír Plusz 2031/M1"), file())?.rate).toBe(6.5);
  });

  it("no match without a file, a series or for a T-bill", () => {
    expect(periodFor(bond("Fix Magyar Állampapír 2029/Q2"), null)).toBeUndefined();
    expect(periodFor(bond("Magyar Állampapír Plusz"), file())).toBeUndefined();
    expect(periodFor(bond("Fix Magyar Állampapír 2029/Q2", { type: "tbill" }), file())).toBeUndefined();
  });
});

describe("fillBondTerms", () => {
  it("fills the missing terms and the real maturity of a FixMÁP", () => {
    const filled = fillBondTerms(bond("Fix Magyar Állampapír 2029/Q2"), file());
    expect(filled.maturity).toBe("2029-10-25");
    expect(filled.bond).toEqual({
      couponRate: 0.055,
      couponIntervalMonths: 3,
      firstCouponDate: "2026-07-25",
    });
  });

  it("replaces a maturity derived from the name, never one entered by hand", () => {
    const derived = bond("Fix Magyar Állampapír 2029/Q2", { maturity: "2029-06-30" });
    expect(fillBondTerms(derived, file()).maturity).toBe("2029-10-25");
    const manual = bond("Fix Magyar Állampapír 2029/Q2", {
      maturity: "2029-06-30",
      bond: { maturity: "2029-10-26" },
    });
    const kept = fillBondTerms(manual, file());
    expect(kept.maturity).toBe("2029-06-30");
    expect(kept.bond?.maturity).toBe("2029-10-26");
  });

  it("keeps every value entered by hand", () => {
    const own = { couponRate: 0.06, couponIntervalMonths: 12, firstCouponDate: "2026-03-01" };
    const inst = bond("Fix Magyar Állampapír 2029/Q2", { maturity: "2029-10-25", bond: own });
    expect(fillBondTerms(inst, file())).toBe(inst);
  });

  it("a yearly PMÁP gets a 12-month schedule", () => {
    expect(fillBondTerms(bond("Prémium Magyar Állampapír 2027/J"), file()).bond).toEqual({
      couponRate: 0.0515,
      rates: [{ from: "2026-01-27", rate: 0.0515 }],
      couponIntervalMonths: 12,
      firstCouponDate: "2026-01-27",
    });
  });

  it("an irregular first period: issued at its start, the payment day anchors the schedule", () => {
    expect(fillBondTerms(bond("Magyar Állampapír Plusz 2031/M1"), file()).bond).toEqual({
      couponRate: 0.065,
      rates: [{ from: "2026-01-06", rate: 0.065 }],
      firstCouponDate: "2027-02-27",
      issueDate: "2026-01-06",
    });
  });

  it("a floating bond gets the period rate even when a rate was typed in, keeping the typed one", () => {
    const own = bond("Prémium Magyar Állampapír 2027/J", { bond: { couponRate: 0.07 } });
    const filled = fillBondTerms(own, file()).bond!;
    expect(filled.couponRate).toBe(0.07);
    expect(filled.rates).toEqual([{ from: "2026-01-27", rate: 0.0515 }]);
    const again = fillBondTerms({ ...own, bond: filled }, file()).bond!;
    expect(again.rates).toHaveLength(1);
  });

  it("a FixMÁP gets no rate periods: its coupon is fixed", () => {
    expect(fillBondTerms(bond("Fix Magyar Állampapír 2029/Q2"), file()).bond?.rates).toBeUndefined();
  });

  it("a Babakötvény is marked capitalizing", () => {
    const f = file({ periods: [period({ type: "BABA", series: "2045/S_BABA", rate: 7.4, periodStart: "2026-02-01", periodEnd: "2027-02-01", paymentDate: null, maturity: "2045-02-01" })] });
    const b = fillBondTerms(bond("Babakötvény 2045/S_BABA"), f).bond!;
    expect(b.capitalizing).toBe(true);
    expect(b.rates).toEqual([{ from: "2026-02-01", rate: 0.074 }]);
  });

  it("the filled terms value the bond with accrued interest instead of at par", () => {
    const raw = bond("Fix Magyar Állampapír 2029/Q2");
    const now = new Date(2026, 8, 9).getTime();
    expect(bondMarketValue(raw, 1_000_000, 1_000_000, now, now).needsData).toBe(true);
    const [filled] = withBondRates([raw], file());
    const v = bondMarketValue(filled, 1_000_000, 1_000_000, now, now);
    expect(v.needsData).toBe(false);
    expect(v.value).toBeCloseTo(1_000_000 * (1 + (0.055 / 4) * (46 / 92)), 0);
  });
});

describe("offers", () => {
  it("buyable retail offers leave out BABA, closed and series-less rows", () => {
    expect(buyableOffers(file(), "2026-10-07").map((o) => o.series)).toEqual(["2029/Q2", "2031/M6"]);
  });

  it("every running DKJ series once, at its latest auction, by maturity", () => {
    const dkj = [
      ...file().dkj,
      { auctionDate: "2026-09-29", series: "D270120", isin: "HU0000000002", maturity: "2027-01-20", avgYield: 5.16 },
      { auctionDate: "2026-02-11", series: "D270210", isin: "HU0000000004", maturity: "2027-02-10", avgYield: 5.9 },
      { auctionDate: "2025-09-01", series: "D261216", isin: "HU0000000005", maturity: "2026-12-16", avgYield: 6.1 },
    ];
    const list = currentDkjSeries(file({ dkj }), "2026-10-07");
    expect(list.map((a) => a.series)).toEqual(["D270120", "D270210", "D270428"]);
    expect(list[0].avgYield).toBe(5.17);
    expect(currentDkjSeries(file({ dkj }), "2026-10-06").map((a) => a.series)).toEqual(["D261007", "D270120", "D270210"]);
    expect(currentDkjSeries(file({ dkj: file().dkj.slice(0, 1) }), "2026-10-07")).toEqual([]);
  });
});

describe("validateBondRatesFile", () => {
  it("drops malformed rows and rejects a wrong shape", () => {
    const raw = {
      ...file(),
      periods: [...file().periods, { type: "PMÁP", series: "x", rate: "5", periodStart: "2026-01-01", periodEnd: "2027-01-01" }],
    };
    expect(validateBondRatesFile(raw).periods).toHaveLength(file().periods.length);
    expect(() => validateBondRatesFile({ retail: [] })).toThrow();
    expect(() => validateBondRatesFile(null)).toThrow();
  });
});
