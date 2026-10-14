import { describe, expect, it } from "vitest";
import { bandChanges, horizonMonths, rangeScale, upside, viewText } from "./outlookView";

const target = { min: 38_000, avg: 45_000, max: 52_000 };

describe("upside", () => {
  it("the average target against the price, in the same currency", () => {
    expect(upside(target, 40_000, "HUF", "HUF")).toBeCloseTo(0.125, 6);
    expect(upside(target, 50_000, "huf", "HUF")).toBeCloseTo(-0.1, 6);
  });

  it("null across currencies or without a usable price", () => {
    expect(upside(target, 100, "HUF", "EUR")).toBeNull();
    expect(upside(target, undefined, "HUF", "HUF")).toBeNull();
    expect(upside(target, 0, "HUF", "HUF")).toBeNull();
  });
});

describe("rangeScale", () => {
  it("the price inside the range", () => {
    const s = rangeScale(target, 45_000, true);
    expect(s.avg).toBeCloseTo(0.5, 6);
    expect(s.price).toBeCloseTo(0.5, 6);
  });

  it("a price outside the range widens the scale so both stay on it", () => {
    const s = rangeScale(target, 60_000, true);
    expect(s.price).toBe(1);
    expect(s.avg).toBeCloseTo((45_000 - 38_000) / (60_000 - 38_000), 6);
  });

  it("no price marker when the currencies differ", () => {
    expect(rangeScale(target, 60_000, false).price).toBeNull();
    expect(rangeScale(target, 60_000, false).avg).toBeCloseTo(0.5, 6);
  });

  it("a one-point range does not divide by zero", () => {
    expect(rangeScale({ min: 5, avg: 5, max: 5 }, undefined, false).avg).toBe(0.5);
  });
});

describe("bandChanges / horizonMonths / viewText", () => {
  it("the band as changes against spot", () => {
    const c = bandChanges({
      underlying: "BTC", horizonDays: 90, expiry: "2027-01-15", spot: 100, forward: 101,
      p10: 80, p50: 99, p90: 125, probUp: 0.5, asOf: "2026-10-17",
    });
    expect(c.p10).toBeCloseTo(-0.2, 6);
    expect(c.p90).toBeCloseTo(0.25, 6);
  });

  it("months from days", () => {
    expect([horizonMonths(72), horizonMonths(163), horizonMonths(345), horizonMonths(3)]).toEqual([2, 5, 11, 1]);
  });

  it("a target with its unit, a return as a yearly percentage", () => {
    const base = { house: "X", publishedAt: "2026-07-20", url: "https://example.com" };
    expect(viewText({ ...base, kind: "target", value: 52_900, unit: "HUF" }).replace(/\s/g, " ")).toMatch(/^52.900 HUF$/);
    expect(viewText({ ...base, kind: "annualReturn", value: 0.059, unit: "%/év" })).toMatch(/^5,9%\/év$/);
    // a currency as the unit says what the return is in
    expect(viewText({ ...base, kind: "annualReturn", value: 0.07, unit: "USD" })).toBe("7,0%/év (USD)");
  });
});
