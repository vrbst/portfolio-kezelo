// Regressions from the code review of the "Kilátások alapján" forecast.

import { describe, expect, it } from "vitest";
import { isLongTerm, outlookReturns, pppAdjust, type GrowthHolding, type ManualReturns } from "./outlookReturns";
import type { ImpliedBand, OutlookFile } from "./outlook";
import type { Instrument } from "./model";

const NOW = new Date(2026, 9, 14, 12);
const MANUAL: ManualReturns = { annualReturn: { pess: 0.03, real: 0.06, opt: 0.09 }, mcSigma: 0.15, months: 120, inflationPct: 0.035 };

const holding = (key: string, type: Instrument["type"], over: Partial<GrowthHolding> = {}): GrowthHolding => ({
  key,
  name: over.name ?? key,
  instrument: { key, name: over.name ?? key, type, currency: over.currency ?? "EUR" } as Instrument,
  currency: "EUR",
  valueHuf: 1_000_000,
  ...over,
});
const file = (profiles: OutlookFile["profiles"], items: OutlookFile["items"]): OutlookFile => ({ v: 1, updatedAt: "x", profiles, items, errors: {} });
const prof = (assetClass: OutlookFile["profiles"][string]["assetClass"], underlying?: string) => ({
  assetClass, ...(underlying ? { underlying } : {}), source: "ai" as const, checkedAt: "2026-10-14",
});
const cma = (house: string, value: number, horizon: string | undefined, unit = "HUF", publishedAt = "2026-06-30") => ({
  house, kind: "annualReturn" as const, value, unit, ...(horizon === undefined ? {} : { horizon }), publishedAt, url: `https://example.com/${house}`,
});
const target = (house: string, value: number, unit: string, publishedAt = "2026-10-01", horizon = "12 hó") => ({
  house, kind: "target" as const, value, unit, horizon, publishedAt, url: `https://example.com/${house}`,
});
const band = (spot = 83_000): ImpliedBand => ({
  underlying: "BTC", horizonDays: 345, expiry: "2027-09-24", spot, forward: spot, p10: spot * 0.6, p50: spot, p90: spot * 1.6, probUp: 0.5, asOf: "2026-10-14",
});

describe("the long-term filter cannot be dodged by an unparsable horizon", () => {
  it("what is accepted and what is not", () => {
    expect(isLongTerm(undefined)).toBe(true);
    expect(isLongTerm("")).toBe(true);
    expect(isLongTerm("10 év")).toBe(true);
    expect(isLongTerm("10–15 év")).toBe(true);
    expect(isLongTerm("5 years")).toBe(true);
    expect(isLongTerm("120 hónap")).toBe(true);
    expect(isLongTerm("hosszú táv")).toBe(true);
    expect(isLongTerm("1 év")).toBe(false);
    expect(isLongTerm("12 hónap")).toBe(false);
    expect(isLongTerm("2030-ig")).toBe(false);
    expect(isLongTerm("valamikor")).toBe(false);
  });

  it("a '12 hónap' return is no ten-year expectation, and an unreadable horizon does not win a house's tie-break", () => {
    const outlook = file({ E: prof("equity_fund") }, { E: { views: [cma("A", 0.2, "12 hónap"), cma("B", 0.05, "10 év"), cma("B", 0.5, "2030-ig")] } });
    const r = outlookReturns({ holdings: [holding("E", "etf", { currency: "HUF" })], outlook, manual: MANUAL, now: NOW });
    expect(r.scenarios.real).toBeCloseTo(0.05, 12);
    expect(r.assets[0].sources.map((s) => s.label)).toEqual(["B"]);
  });
});

describe("crypto price targets", () => {
  const btc = (views: OutlookFile["items"][string]["views"]) =>
    outlookReturns({
      holdings: [holding("B", "etf", { name: "Bitcoin ETP" })],
      outlook: file({ B: prof("crypto", "BTC") }, { B: { implied: [band()], views } }),
      manual: MANUAL,
      now: NOW,
    });

  it("only dollar targets are compared with the dollar spot", () => {
    expect(btc([target("Bank", 90_000, "EUR")]).usable).toBe(false);
    expect(btc([target("Bank", 9_000_000, "HUF")]).usable).toBe(false);
  });

  it("a target from months ago (stale) is left out, a fresh one is used", () => {
    expect(btc([target("Old", 113_000, "USD", "2026-01-15")]).usable).toBe(false);
    expect(btc([target("Old", 113_000, "USD", "2026-01-15"), target("New", 113_000, "USD")]).assets[0].sources.map((s) => s.label)).toEqual(["New"]);
  });

  it("the move is in forint terms (the dollar–forint inflation gap), and the breakdown says how much", () => {
    const r = btc([target("Citi", 113_000, "USD")]);
    const u = 113_000 / 83_000 - 1;
    const raw = 0.95 * 0.06 + 0.05 * u;
    expect(r.scenarios.real).toBeCloseTo(0.95 * 0.06 + 0.05 * pppAdjust(u, "USD", 0.035), 12);
    expect(r.assets[0].fxAdjPp).toBeCloseTo((r.scenarios.real - raw) * 100, 9);
    expect(r.assets[0].fxAdjPp).toBeGreaterThan(0);
  });
});

describe("share targets in a foreign currency", () => {
  const stock = (currency: string) =>
    outlookReturns({
      holdings: [holding("S", "stock", { currency, price: 100 })],
      outlook: file({ S: prof("equity") }, { S: { consensus: [{ source: "yahoo", asOf: "2026-10-14", currency, target: { min: 90, avg: 120, max: 150 } }] } }),
      manual: MANUAL,
      now: NOW,
    });

  it("a dollar-listed share's 12-month move is put on the forint base like the ETFs' returns", () => {
    const usd = stock("USD");
    const a = 0.05;
    expect(usd.scenarios.real).toBeCloseTo((1 - a) * 0.06 + a * pppAdjust(0.2, "USD", 0.035), 12);
    expect(usd.assets[0].fxAdjPp).toBeGreaterThan(0);
  });

  it("a forint-listed share needs no correction", () => {
    const huf = stock("HUF");
    expect(huf.assets[0].fxAdjPp).toBe(0);
    expect(huf.scenarios.real).toBeCloseTo(0.95 * 0.06 + 0.05 * 0.2, 12);
  });
});

describe("currencies without an inflation figure are reported, not silently left", () => {
  const views = (unit: string) =>
    outlookReturns({
      holdings: [holding("E", "etf", { currency: "HUF" })],
      outlook: file({ E: prof("equity_fund") }, { E: { views: [cma("A", 0.06, "10 év", unit)] } }),
      manual: MANUAL,
      now: NOW,
    });

  it("a known one is corrected without a warning", () => {
    const r = views("CHF");
    expect(r.warnings.some((w) => /inflációs adat/.test(w))).toBe(false);
    expect(r.assets[0].fxAdjPp).toBeGreaterThan(0);
  });

  it("an unknown one is used as is and named in a warning", () => {
    const r = views("SEK");
    expect(r.assets[0].uncorrected).toEqual(["SEK"]);
    expect(r.warnings.some((w) => /SEK/.test(w) && /inflációs adat/.test(w))).toBe(true);
    expect(r.scenarios.real).toBeCloseTo(0.06, 12);
  });
});
