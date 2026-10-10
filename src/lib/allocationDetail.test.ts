import { describe, expect, it } from "vitest";
import { computePortfolio, allocationByClass, allocationByCurrency } from "./portfolio";
import { detailByAccount, detailByClass, detailByCurrency, detailBySector } from "./allocationDetail";
import { sectorExposure, validateFundamentalsFile } from "./fundamentals";
import { consolidatedHoldings } from "./holdings";
import { ACCOUNTS, VWCE, fixtureHistory, fixturePriceFile, fixtureSnapshot, instruments } from "../test/fixture";

const NOW = new Date(2026, 9, 10, 12);
const priceFile = fixturePriceFile(fixtureHistory("2026-10-09"));
const summary = computePortfolio(
  ACCOUNTS,
  fixtureSnapshot().transactions,
  new Map(instruments().map((i) => [i.key, i])),
  new Map(Object.entries(priceFile.prices).map(([k, p]) => [k, p.price])),
  priceFile.fx,
  NOW,
);
const sum = (items: { valueHuf: number }[]) => items.reduce((s, c) => s + c.valueHuf, 0);

describe("allocationDetail", () => {
  it("every slice's contributors add up to the slice, and the slices match the plain allocation", () => {
    for (const s of [...detailByClass(summary), ...detailByCurrency(summary, priceFile.fx), ...detailByAccount(summary)])
      expect(sum(s.items)).toBeCloseTo(s.value, 6);
    const byClass = new Map(detailByClass(summary).map((s) => [s.key, s.value]));
    for (const a of allocationByClass(summary)) expect(byClass.get(a.key)).toBeCloseTo(a.value, 6);
    const byCcy = new Map(detailByCurrency(summary, priceFile.fx).map((s) => [s.key, s.value]));
    for (const a of allocationByCurrency(summary, priceFile.fx)) expect(byCcy.get(a.key)).toBeCloseTo(a.value, 6);
  });

  it("the bond slice lists the individual bonds", () => {
    const bond = detailByClass(summary).find((s) => s.key === "bond");
    expect(bond?.items.length).toBeGreaterThan(0);
    expect(bond!.items.map((i) => i.label).join()).not.toContain("HU0000TESZT"); // ticker/name, not the raw key
  });

  it("sectors: an ETF splits by its weights, a stock counts fully; sums match sectorExposure", () => {
    const at = NOW.toISOString();
    const file = validateFundamentalsFile({
      v: 1,
      updatedAt: at,
      items: { [VWCE]: { symbol: "VWCE.DE", fetchedAt: at, sectors: [{ name: "technology", weight: 0.6 }, { name: "energy", weight: 0.4 }] } },
      errors: {},
    });
    const { slices, coveredHuf } = detailBySector(summary, file);
    const vwce = consolidatedHoldings(summary).find((h) => h.instrumentKey === VWCE)!;
    expect(coveredHuf).toBeCloseTo(vwce.marketValueHuf, 6);
    expect(slices.map((s) => s.key)).toEqual(["technology", "energy"]);
    expect(slices[0].value).toBeCloseTo(vwce.marketValueHuf * 0.6, 6);
    for (const s of slices) expect(sum(s.items)).toBeCloseTo(s.value, 6);
    const exp = sectorExposure(
      consolidatedHoldings(summary).map((h) => ({ key: h.instrumentKey, valueHuf: h.marketValueHuf })),
      file,
    );
    expect(exp.sectors.map((w) => w.weight)).toEqual(slices.map((s) => s.value / coveredHuf));
  });

  it("no fundamentals file → no sector slices", () => {
    expect(detailBySector(summary, null).slices).toEqual([]);
  });
});
