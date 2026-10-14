import { afterEach, describe, expect, it, vi } from "vitest";
import { contextAt } from "./testContext";
import { forecastText } from "./reports";
import { analysisContext } from "./analysis/job";
import { VWCE, WBIT } from "../../src/test/fixture";
import type { OutlookFile } from "../../src/lib/outlook";
import type { PortfolioSnapshot } from "../../src/lib/sync";

// The bot's /elorejelzes and the nightly analysis follow the forecast's
// "Kilátások alapján" mode, on the invented portfolio of src/test/fixture.ts.

afterEach(() => vi.useRealTimers());

const AT: [number, number, number, number] = [2026, 10, 14, 10];
const useOutlookMode = (s: PortfolioSnapshot) => {
  s.prefs = {
    ...s.prefs,
    forecast: { updatedAt: "2026-10-01T08:00:00.000Z", value: { returnSource: "outlook" } },
  } as PortfolioSnapshot["prefs"];
};

const cma = (house: string, value: number) => ({
  house, kind: "annualReturn" as const, value, unit: "USD", horizon: "10 év", publishedAt: "2026-06-30", url: `https://example.com/${house}`,
});
const outlook: OutlookFile = {
  v: 1,
  updatedAt: "2026-10-14T00:00:00Z",
  profiles: {
    [VWCE]: { assetClass: "equity_fund", source: "ai", checkedAt: "2026-10-14" },
    [WBIT]: { assetClass: "crypto", underlying: "BTC", source: "ai", checkedAt: "2026-10-14" },
  },
  items: { [VWCE]: { views: [cma("A", 0.05), cma("B", 0.06), cma("C", 0.07)] } },
  errors: {},
};
const returnLine = (t: string) => t.split("\n").find((l) => l.startsWith("Hozam:"))!;

describe("/elorejelzes", () => {
  it("manual mode: byte-identical, with or without an outlook file at hand", () => {
    const plain = forecastText(contextAt(AT));
    const ctx = contextAt(AT);
    ctx.outlook = outlook;
    expect(forecastText(ctx)).toBe(plain);
    expect(returnLine(plain)).not.toMatch(/Kilátások/);
  });

  it("outlook mode with the file: derived returns, said so with the coverage, and different numbers", () => {
    const manual = forecastText(contextAt(AT));
    const ctx = contextAt(AT, useOutlookMode);
    ctx.outlook = outlook;
    const text = forecastText(ctx);
    expect(returnLine(text)).toMatch(/a Kilátások alapján, \d+%-os fedettséggel/);
    expect(returnLine(text)).not.toBe(returnLine(manual));
    expect(text).not.toBe(manual);
  });

  it("outlook mode without the file (unreadable): the manual numbers, and the text says it", () => {
    const manual = forecastText(contextAt(AT));
    const ctx = contextAt(AT, useOutlookMode);
    ctx.outlook = null;
    const text = forecastText(ctx);
    expect(returnLine(text)).toMatch(/kézi érték \(a Kilátások most nem elérhetők\)/);
    expect(text.replace(/ – kézi érték \(a Kilátások most nem elérhetők\)/, "")).toBe(manual);
  });

  it("outlook mode where nothing was looked up (undefined) is treated like an unreadable file", () => {
    const ctx = contextAt(AT, useOutlookMode);
    expect(returnLine(forecastText(ctx))).toMatch(/nem elérhetők/);
  });
});

describe("the nightly analysis context", () => {
  it("names the return source only in outlook mode", () => {
    const plain = contextAt(AT);
    expect(analysisContext(plain)).not.toMatch(/Hozam-feltevés/);
    const ctx = contextAt(AT, useOutlookMode);
    ctx.outlook = outlook;
    expect(analysisContext(ctx)).toMatch(/Hozam-feltevés: éves hozam .* a Kilátásokból levezetve/);
  });
});
