import { describe, expect, it } from "vitest";
import { historyGaps, withLiveHistory } from "./data";
import { buildWhyPrompt } from "./news/why";
import type { HistoryFile } from "../../src/lib/prices";

const VWCE = "IE00BK5BQT80";
const AAPL = "US0378331005";

describe("bot: új papír a commitolt history.json-ban nincs benne", () => {
  const committed: HistoryFile = {
    updatedAt: "2026-10-01T00:00:00Z",
    prices: { [VWCE]: [["2026-09-30", 140]] },
    fx: { EUR: [["2026-09-30", 390]] },
  };
  const targets = [
    { key: VWCE, isin: VWCE, currency: "EUR" },
    { key: AAPL, isin: AAPL, currency: "USD" },
  ];

  it("csak a hiányzó papírt és devizát kéri le élőben", () => {
    expect(historyGaps(committed, targets, ["EUR", "USD"])).toEqual({
      targets: [{ key: AAPL, isin: AAPL, currency: "USD" }],
      currencies: ["USD"],
    });
    expect(historyGaps(null, targets, ["EUR"]).targets).toHaveLength(2);
  });

  it("az élő sorozat a commitolt mellé kerül, a meglévőt nem írja felül", () => {
    const merged = withLiveHistory(committed, {
      prices: { [AAPL]: [["2026-09-30", 250]], [VWCE]: [["2026-09-30", 999]] },
      fx: { USD: [["2026-09-30", 340]] },
    });
    expect(merged?.prices[AAPL]).toEqual([["2026-09-30", 250]]);
    expect(merged?.prices[VWCE]).toEqual([["2026-09-30", 140]]);
    expect(merged?.fx.USD).toEqual([["2026-09-30", 340]]);
    expect(withLiveHistory(committed, { prices: {}, fx: {} })).toBe(committed);
  });
});

describe("bot: miért mozdult — egyedi részvény", () => {
  it("részvénynél a cég híreire keres, nem indexet magyaráz", () => {
    const prompt = buildWhyPrompt({
      day: "2026-10-08",
      weekday: 4,
      factors: [{ key: AAPL, label: "AAPL", pct: -0.04, name: "Apple Inc.", ticker: "AAPL", isin: AAPL, currency: "USD", type: "stock" }],
    });
    expect(prompt).toContain("egyedi részvény");
    expect(prompt).not.toContain("ne a tickerre keress");
  });
});
