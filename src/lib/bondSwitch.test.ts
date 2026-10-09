import { describe, expect, it } from "vitest";
import type { Instrument } from "./model";
import type { BondRatesFile, RetailOffer } from "./bondRates";
import {
  adviseHolding,
  bondAdvice,
  bondMarket,
  breakEvenYears,
  offerYieldPct,
  rankedOffers,
  switchGain,
  type BondHolding,
} from "./bondSwitch";
import type { SavingsGoal } from "./savings";

const TODAY = "2026-10-08";

const offer = (o: Partial<RetailOffer> & Pick<RetailOffer, "type" | "series">): RetailOffer => ({
  rateText: "",
  rateMin: null,
  rateMax: null,
  ehm: null,
  maturity: "2030-01-01",
  currency: "HUF",
  validFrom: "2026-01-01",
  validTo: null,
  ...o,
});

const file = (over: Partial<BondRatesFile> = {}): BondRatesFile => ({
  updatedAt: "2026-10-07T21:12:05.640Z",
  retail: [
    offer({ type: "FixMÁP", series: "2029/Q2", rateMin: 5.5, rateMax: 5.5, ehm: 5.62, maturity: "2029-10-25" }),
    offer({ type: "MÁP Plusz", series: "2031/M6", rateMin: 5, rateMax: 6, ehm: 5.47, maturity: "2031-11-27" }),
    offer({ type: "PMÁP", series: "2036/I1", rateMin: 4.5, rateMax: 4.5, maturity: "2036-02-21", validTo: "2027-02-20" }),
    offer({ type: "BABA", series: "2045/S_BABA", rateMin: 7.4, rateMax: 7.4, maturity: "2045-02-01" }),
    offer({ type: "KTJ I", series: "KTJ_I", rateMin: 4.5, rateMax: 4.5, ehm: 4.5, maturity: null }),
    offer({ type: "EMÁP", series: "2029/U_EUR", rateMin: 2.493, rateMax: 2.493, maturity: "2029-10-25", currency: "EUR" }),
    offer({ type: "BMÁP", series: "2032/R0", rateMin: 9, rateMax: 9, maturity: "2032-06-22", validTo: "2026-09-21" }),
  ],
  periods: [],
  dkj: [
    { auctionDate: "2026-10-06", series: "D270120", isin: "HU0000000002", maturity: "2027-01-20", avgYield: 5.17 },
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

const holding = (instrument: Instrument, face = 1_000_000, saleCost = 0.01): BondHolding => ({
  instrumentKey: instrument.key,
  instrument,
  quantity: face,
  costBasisHuf: face,
  marketValueHuf: face,
  redeemableValueHuf: saleCost ? face * (1 - saleCost) : undefined,
});

describe("offerYieldPct", () => {
  it("prefers EHM, then the middle of a rate range", () => {
    expect(offerYieldPct(offer({ type: "FixMÁP", series: "x", rateMin: 5.5, rateMax: 5.5, ehm: 5.62 }))).toBe(5.62);
    expect(offerYieldPct(offer({ type: "MÁP Plusz", series: "x", rateMin: 5, rateMax: 6 }))).toBe(5.5);
    expect(offerYieldPct(offer({ type: "X", series: "x" }))).toBeUndefined();
  });
});

describe("rankedOffers", () => {
  it("keeps buyable offers of the currency, best yield first", () => {
    const names = rankedOffers(file(), TODAY).map((o) => `${o.offer.type} ${o.offer.series}`);
    expect(names).toEqual(["FixMÁP 2029/Q2", "MÁP Plusz 2031/M6", "PMÁP 2036/I1"]);
    expect(rankedOffers(file(), TODAY, "EUR").map((o) => o.offer.series)).toEqual(["2029/U_EUR"]);
  });

  it("marks floating-rate families", () => {
    const pm = rankedOffers(file(), TODAY).find((o) => o.offer.type === "PMÁP")!;
    expect(pm.floating).toBe(true);
  });
});

describe("switch arithmetic", () => {
  it("the gain is zero exactly at the break-even time", () => {
    const be = breakEvenYears(1_000_000, 990_000, 1_000_000, 3, 5.62)!;
    expect(be).toBeGreaterThan(0);
    expect(switchGain(1_000_000, 990_000, 1_000_000, 3, 5.62, be)).toBeCloseTo(0, 6);
    expect(switchGain(1_000_000, 990_000, 1_000_000, 3, 5.62, be + 1)).toBeGreaterThan(0);
  });

  it("never breaks even when the new rate does not earn more per year", () => {
    expect(breakEvenYears(1_000_000, 990_000, 1_000_000, 5.6, 5.62)).toBeUndefined();
  });
});

describe("adviseHolding", () => {
  it("suggests a switch when the higher rate pays back the fee before maturity", () => {
    const inst = bond("Fix Magyar Állampapír 2030/I", { maturity: "2030-12-15", bond: { couponRate: 0.03 } });
    const a = adviseHolding(holding(inst), file(), TODAY)!;
    expect(a.ratePct).toBeCloseTo(3);
    expect(a.verdict.kind).toBe("switch");
    if (a.verdict.kind !== "switch") return;
    expect(a.verdict.saleCostHuf).toBe(10_000);
    expect(a.verdict.breakEvenMonths).toBeGreaterThan(4);
    expect(a.verdict.breakEvenMonths).toBeLessThan(6);
    expect(a.verdict.gainHuf).toBeGreaterThan(0);
    expect(a.verdict.horizonYears).toBeLessThanOrEqual(a.verdict.to.years);
  });

  it("a floating bond is compared at its current ÁKK period rate, not a stale typed-in one", () => {
    const inst = bond("Prémium Magyar Állampapír 2030/I", { maturity: "2030-03-15", bond: { couponRate: 0.065 } });
    const periods = [
      { type: "PMÁP", series: "2030/I", rate: 4.25, periodStart: "2026-03-15", periodEnd: "2027-03-15", paymentDate: "2027-03-15", maturity: "2030-03-15", currency: "HUF" },
      { type: "PMÁP", series: "2030/I", rate: 3.9, periodStart: "2027-03-15", periodEnd: "2028-03-15", paymentDate: "2028-03-15", maturity: "2030-03-15", currency: "HUF" },
    ];
    const a = adviseHolding(holding(inst), file({ periods: periods.slice(0, 1) }), TODAY)!;
    expect(a.ratePct).toBe(4.25);
    expect(a.floating).toBe(true);
    expect(a.verdict.kind).toBe("switch");
    expect(adviseHolding(holding(inst), file({ periods }), TODAY)!.ratePct).toBe(4.25);
    expect(adviseHolding(holding(inst), file({ periods: periods.slice(1) }), TODAY)!.ratePct).toBe(6.5);
  });

  it("keeps a bond that already pays as much as the best offer", () => {
    const inst = bond("Fix Magyar Állampapír 2030/I", { maturity: "2030-12-15", bond: { couponRate: 0.055 } });
    const a = adviseHolding(holding(inst), file(), TODAY)!;
    expect(a.verdict).toMatchObject({ kind: "keep", reason: "no-better" });
  });

  it("keeps it when the fee would not pay back before the bond matures", () => {
    const inst = bond("Fix Magyar Állampapír 2027/J", { maturity: "2027-10-08", bond: { couponRate: 0.052 } });
    const a = adviseHolding(holding(inst), file(), TODAY)!;
    expect(a.verdict).toMatchObject({ kind: "keep", reason: "fee" });
  });

  it("without a sale cost even a short remaining term can be worth switching", () => {
    const inst = bond("Fix Magyar Állampapír 2027/J", { maturity: "2027-10-08", bond: { couponRate: 0.04 } });
    const a = adviseHolding(holding(inst, 1_000_000, 0), file(), TODAY)!;
    expect(a.verdict.kind).toBe("switch");
  });

  it("flags a bond maturing soon instead of comparing", () => {
    const inst = bond("Fix Magyar Állampapír 2026/K", { maturity: "2026-11-01", bond: { couponRate: 0.03 } });
    const a = adviseHolding(holding(inst), file(), TODAY)!;
    expect(a.verdict).toEqual({ kind: "maturing", days: 24 });
  });

  it("does not compare a T-bill or a bond with unknown rate", () => {
    const dkj = bond("Diszkont Kincstárjegy D270512", { type: "tbill", maturity: "2027-05-12" });
    expect(adviseHolding(holding(dkj, 1_000_000, 0), file(), TODAY)!.verdict).toMatchObject({ reason: "tbill" });
    const unknown = bond("Fix Magyar Állampapír 2030/I", { maturity: "2030-12-15" });
    expect(adviseHolding(holding(unknown), file(), TODAY)!.verdict).toMatchObject({ reason: "no-rate" });
  });

  it("compares an EUR bond only with EUR offers", () => {
    const inst = bond("Euró Magyar Állampapír 2030/A", {
      currency: "EUR",
      maturity: "2030-06-01",
      bond: { couponRate: 0.04 },
    });
    const a = adviseHolding(holding(inst), file(), TODAY)!;
    expect(a.verdict).toMatchObject({ kind: "keep", reason: "no-better" });
  });

  it("skips matured bonds, empty positions and non-bonds", () => {
    const old = bond("Fix Magyar Állampapír 2025/A", { maturity: "2025-01-01", bond: { couponRate: 0.03 } });
    expect(adviseHolding(holding(old), file(), TODAY)).toBeUndefined();
    const sold = bond("Fix Magyar Állampapír 2030/I", { maturity: "2030-12-15", bond: { couponRate: 0.03 } });
    expect(adviseHolding(holding(sold, 0), file(), TODAY)).toBeUndefined();
    const etf = bond("VWCE", { type: "etf" });
    expect(adviseHolding(holding(etf), file(), TODAY)).toBeUndefined();
  });
});

describe("maturing bond of a savings goal", () => {
  const goal = (over: Partial<SavingsGoal> = {}): SavingsGoal => ({
    id: "g1",
    name: "Autó",
    targetHuf: 1_000_000,
    targetDate: "2027-06-30",
    instrumentKeys: ["dkj"],
    includeCoupons: false,
    createdAt: "2026-01-01",
    ...over,
  });
  const dkjInst = bond("Diszkont Kincstárjegy D261028", { key: "dkj", type: "tbill", maturity: "2026-10-28" });
  const dkjFile = file({
    dkj: [
      { auctionDate: "2026-10-06", series: "D270120", isin: null, maturity: "2027-01-20", avgYield: 5.17 },
      { auctionDate: "2026-09-23", series: "D270428", isin: null, maturity: "2027-04-28", avgYield: 5.16 },
      { auctionDate: "2026-09-24", series: "D270818", isin: null, maturity: "2027-08-18", avgYield: 5.4 },
      { auctionDate: "2026-09-08", series: "D261112", isin: null, maturity: "2026-11-12", avgYield: 5.5 },
    ],
  });

  it("suggests the best paper maturing by the goal's date, not after it", () => {
    const a = adviseHolding(holding(dkjInst, 1_000_000, 0), dkjFile, TODAY, [goal()])!;
    expect(a.verdict).toMatchObject({
      kind: "maturing",
      days: 20,
      goal: { id: "g1", name: "Autó", targetDate: "2027-06-30" },
      reinvest: { name: "DKJ D270120", yieldPct: 5.17, maturity: "2027-01-20" },
    });
  });

  it("holds cash when nothing matures between the payout and the goal's date", () => {
    const a = adviseHolding(holding(dkjInst, 1_000_000, 0), dkjFile, TODAY, [goal({ targetDate: "2026-12-15" })])!;
    expect(a.verdict).toMatchObject({ kind: "maturing", goal: { targetDate: "2026-12-15" } });
    expect(a.verdict.kind === "maturing" && a.verdict.reinvest).toBeFalsy();
  });

  it("a goal due before the payout is told the money arrives late, with nothing to reinvest", () => {
    const a = adviseHolding(holding(dkjInst, 1_000_000, 0), dkjFile, TODAY, [goal({ targetDate: "2026-10-20" })])!;
    expect(a.verdict).toMatchObject({ kind: "maturing", plan: { kind: "late", days: 8 } });
    expect(a.verdict.kind === "maturing" && a.verdict.reinvest).toBeFalsy();
  });

  it("a goal due on the payout day is covered by the payout", () => {
    const a = adviseHolding(holding(dkjInst, 1_000_000, 0), dkjFile, TODAY, [goal({ targetDate: "2026-10-28" })])!;
    expect(a.verdict).toMatchObject({ kind: "maturing", plan: { kind: "payout" } });
  });

  it("a DKJ yield from an old auction is not offered for reinvestment", () => {
    const old = { auctionDate: "2026-01-14", series: "D270310", isin: null, maturity: "2027-03-10", avgYield: 9 };
    const a = adviseHolding(holding(dkjInst, 1_000_000, 0), file({ dkj: [...dkjFile.dkj, old] }), TODAY, [goal()])!;
    expect(a.verdict).toMatchObject({ plan: { kind: "reinvest" }, reinvest: { name: "DKJ D270120" } });
    expect(bondMarket(file({ dkj: [old] }), TODAY)!.dkj).toEqual([{ ...old, fresh: false }]);
  });

  it("of several linked goals, the one the payout still arrives in time for is advised", () => {
    const early = goal({ id: "g0", name: "Babakocsi", targetDate: "2026-10-20" });
    const a = adviseHolding(holding(dkjInst, 1_000_000, 0), dkjFile, TODAY, [early, goal()])!;
    expect(a.verdict).toMatchObject({ goal: { id: "g1" }, plan: { kind: "reinvest" } });
    const onlyEarly = adviseHolding(holding(dkjInst, 1_000_000, 0), dkjFile, TODAY, [early])!;
    expect(onlyEarly.verdict).toMatchObject({ goal: { id: "g0" }, plan: { kind: "late" } });
  });

  it("without a goal, or with a past goal, it stays a plain maturity flag", () => {
    expect(adviseHolding(holding(dkjInst, 1_000_000, 0), dkjFile, TODAY)!.verdict).toEqual({ kind: "maturing", days: 20 });
    const past = goal({ targetDate: "2026-01-01" });
    expect(adviseHolding(holding(dkjInst, 1_000_000, 0), dkjFile, TODAY, [past])!.verdict).toEqual({
      kind: "maturing",
      days: 20,
    });
  });
});

describe("bondAdvice / bondMarket", () => {
  it("lists switch candidates first and is empty without data", () => {
    const keep = bond("Fix Magyar Állampapír 2031/A", { maturity: "2031-12-15", bond: { couponRate: 0.06 } });
    const sw = bond("Fix Magyar Állampapír 2030/I", { maturity: "2030-12-15", bond: { couponRate: 0.03 } });
    const out = bondAdvice([holding(keep, 5_000_000), holding(sw)], file(), TODAY);
    expect(out.map((a) => a.verdict.kind)).toEqual(["switch", "keep"]);
    expect(bondAdvice([holding(sw)], null, TODAY)).toEqual([]);
    expect(bondMarket(null, TODAY)).toBeNull();
    expect(bondMarket(file(), TODAY)!.dkj.map((d) => d.series)).toEqual(["D270120"]);
  });
});
