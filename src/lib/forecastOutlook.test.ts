import { beforeEach, describe, expect, it } from "vitest";
import { runTool } from "./aiTools";
import { DEFAULT_SETTINGS, loadForecastSettings, projectFromSettings, saveForecastSettings } from "./forecast";
import type { OutlookFile } from "./outlook";
import type { PortfolioSummary } from "./portfolio";

// The forecast in "Kilátások alapján" mode: the stored settings stay the
// user's, only what the engine runs with changes. Invented, round numbers.

const NOW = new Date(2026, 9, 14, 10);
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
});

const summary = {
  totalValueHuf: 2_000_000,
  holdingsValueHuf: 2_000_000,
  cashValueHuf: 0,
  netDepositedHuf: 2_000_000,
  accounts: [
    {
      account: { kind: "tbsz" },
      cashValueHuf: 0,
      holdings: [
        {
          instrumentKey: "VWCE",
          instrument: { key: "VWCE", name: "VWCE", type: "etf" },
          quantity: 10,
          currency: "EUR",
          marketValueHuf: 2_000_000,
          costBasisCcy: 0,
          costBasisHuf: 0,
        },
      ],
    },
  ],
} as unknown as PortfolioSummary;

const view = (house: string, value: number) => ({
  house, kind: "annualReturn" as const, value, unit: "USD", horizon: "10 év", publishedAt: "2026-06-30", url: `https://example.com/${house}`,
});
const outlook: OutlookFile = {
  v: 1,
  updatedAt: "2026-10-14T00:00:00Z",
  profiles: { VWCE: { assetClass: "equity_fund", source: "ai", checkedAt: "2026-10-14" } },
  items: { VWCE: { views: [view("A", 0.05), view("B", 0.06), view("C", 0.07)] } },
  errors: {},
};

const setMode = (mode: string) => store.set("pf-forecast", JSON.stringify({ returnSource: mode }));
const run = (o?: OutlookFile | null) => projectFromSettings(summary, [], {}, [], {}, NOW, o);

describe("returnSource in the stored settings", () => {
  it("manual by default, also for settings saved before it existed", () => {
    expect(loadForecastSettings().returnSource).toBe("manual");
    expect(DEFAULT_SETTINGS.returnSource).toBe("manual");
    store.set("pf-forecast", JSON.stringify({ months: 60 }));
    expect(loadForecastSettings().returnSource).toBe("manual");
  });

  it("only the exact 'outlook' counts; anything else is manual", () => {
    setMode("outlook");
    expect(loadForecastSettings().returnSource).toBe("outlook");
    for (const odd of ["Outlook", "yes", "", "1"]) {
      setMode(odd);
      expect(loadForecastSettings().returnSource).toBe("manual");
    }
    store.set("pf-forecast", JSON.stringify({ returnSource: true }));
    expect(loadForecastSettings().returnSource).toBe("manual");
  });

  it("it round-trips through save and load", () => {
    saveForecastSettings({ ...DEFAULT_SETTINGS, returnSource: "outlook" });
    expect(loadForecastSettings().returnSource).toBe("outlook");
  });
});

describe("projectFromSettings", () => {
  it("manual mode: the outlook is ignored — the very same projection as without it", () => {
    const without = run();
    const withFile = run(outlook);
    expect(withFile.estimate).toBeNull();
    expect(withFile.assumptions.annualReturn).toEqual(DEFAULT_SETTINGS.annualReturn);
    expect(withFile.result).toEqual(without.result);
  });

  it("outlook mode: the engine runs with the derived returns, the settings report the derived σ", () => {
    setMode("outlook");
    const r = run(outlook);
    expect(r.estimate?.usable).toBe(true);
    expect(r.assumptions.annualReturn).toBe(r.estimate!.scenarios);
    expect(r.assumptions.annualReturn.real).not.toBe(DEFAULT_SETTINGS.annualReturn.real);
    expect(r.settings.mcSigma).toBe(r.estimate!.sigma);
    expect(r.settings.returnSource).toBe("outlook");
    // a better expectation than the manual 6 % (the dollar views are corrected to forint terms) → a larger projection
    const manual = (setMode("manual"), run(outlook));
    expect(r.result.points.at(-1)!.real).toBeGreaterThan(manual.result.points.at(-1)!.real);
  });

  it("outlook mode never writes the derived numbers into the stored settings", () => {
    setMode("outlook");
    const before = store.get("pf-forecast");
    run(outlook);
    expect(store.get("pf-forecast")).toBe(before);
    expect(loadForecastSettings().annualReturn).toEqual(DEFAULT_SETTINGS.annualReturn);
    expect(loadForecastSettings().mcSigma).toBe(DEFAULT_SETTINGS.mcSigma);
  });

  it("outlook mode without the file (not loaded yet, no sync): exactly the manual projection", () => {
    const manual = run();
    setMode("outlook");
    for (const o of [null, undefined]) {
      const r = run(o);
      expect(r.estimate?.usable).toBe(false);
      expect(r.assumptions.annualReturn).toEqual(DEFAULT_SETTINGS.annualReturn);
      expect(r.result).toEqual(manual.result);
    }
  });
});

describe("the AI's run_forecast tool follows the setting", () => {
  const env = (o?: OutlookFile | null) =>
    ({ summary, transactions: [], fx: {}, goalExpenses: [], outlook: o }) as unknown as Parameters<typeof runTool>[2];
  const used = (o?: OutlookFile | null) => {
    const r = runTool("run_forecast", {}, env(o));
    expect(r.isError).toBe(false);
    return (JSON.parse(r.content) as { used: { return_source: string; returns_pct: { real: number } } }).used;
  };

  it("manual: the typed numbers, said so", () => {
    expect(used(outlook)).toMatchObject({ return_source: "manual", returns_pct: { real: 6 } });
  });

  it("outlook mode with the file: the derived returns, said so", () => {
    setMode("outlook");
    const u = used(outlook);
    expect(u.return_source).toBe("outlook");
    expect(u.returns_pct.real).not.toBe(6);
  });

  it("outlook mode without the file: the manual numbers, honestly labelled manual", () => {
    setMode("outlook");
    expect(used(null)).toMatchObject({ return_source: "manual", returns_pct: { real: 6 } });
  });

  it("a what-if return shifts all three scenarios from whatever the base is", () => {
    setMode("outlook");
    const base = used(outlook).returns_pct.real;
    const r = runTool("run_forecast", { realistic_return_pct: base + 1 }, env(outlook));
    const j = JSON.parse(r.content) as { used: { returns_pct: { pess: number; real: number; opt: number } } };
    expect(j.used.returns_pct.real).toBeCloseTo(base + 1, 1);
  });
});
