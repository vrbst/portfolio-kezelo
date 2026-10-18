import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { contextAt } from "../notify/testContext";
import { ChartsView } from "./ChartsView";
import {
  ALLOC_MODES,
  CHART_IDS,
  FORECAST_YEARS,
  buildChart,
  priceHoldings,
  type ChartId,
  type ChartOptions,
} from "./charts";
import { CHART_RANGES } from "./ranges";

afterEach(() => vi.useRealTimers());

const ctx = () => contextAt([2026, 5, 15, 10]);
const OPTS: ChartOptions = { range: 3, mode: 0, pick: 0, hide: false, columns: 60 };

const frame = (c: ReturnType<typeof ctx>, chart: ChartId, o: Partial<ChartOptions> = {}) => {
  const { lastFrame, unmount } = render(
    <ChartsView ctx={c} chart={chart} options={{ ...OPTS, ...o }} columns={80} height={8} />,
  );
  const out = lastFrame() ?? "";
  unmount();
  return out;
};

// A personal Ft amount like "1 234 567 Ft" or "35,93 M Ft".
const AMOUNT = /\d[\d\s,.]*\s?(M )?Ft/;

describe("terminal charts", () => {
  it("draw every chart with data on the invented portfolio", () => {
    const c = ctx();
    for (const id of CHART_IDS) {
      const data = buildChart(id, c, OPTS);
      expect(data.kind, id).not.toBe("empty");
      const out = frame(c, id);
      expect(out, id).toContain(data.title);
    }
  });

  it("show no personal Ft amount in privacy mode, anywhere", () => {
    const c = ctx();
    const ranged: ChartId[] = ["value", "profit", "twr", "drawdown", "price"];
    for (const id of CHART_IDS) {
      const ranges = ranged.includes(id) ? CHART_RANGES.length : 1;
      for (let range = 0; range < ranges; range++)
        expect(frame(c, id, { hide: true, range }), `${id}/${range}`).not.toMatch(AMOUNT);
    }
    for (let mode = 0; mode < ALLOC_MODES.length; mode++)
      expect(frame(c, "alloc", { hide: true, mode })).not.toMatch(AMOUNT);
    // the control: the same charts do print amounts when not hidden.
    expect(frame(c, "value")).toMatch(AMOUNT);
    expect(frame(c, "alloc")).toMatch(AMOUNT);
  }, 60_000);

  it("line charts draw braille dots in their series colours", () => {
    const out = frame(ctx(), "value");
    expect(out).toMatch(/[⠁-⣿]{5}/);
  });

  it("the time range changes what is drawn", () => {
    const c = ctx();
    const all = buildChart("value", c, { ...OPTS, range: 3 });
    const month = buildChart("value", c, { ...OPTS, range: 0 });
    expect(all.kind === "line" && month.kind === "line").toBe(true);
    if (all.kind === "line" && month.kind === "line") {
      expect(month.series[0].values.length).toBeLessThan(all.series[0].values.length);
      expect(month.xFirst > all.xFirst).toBe(true);
    }
  });

  it("the forecast horizon grows with its setting", () => {
    const c = ctx();
    const len = (i: number) => {
      const d = buildChart("forecast", c, { ...OPTS, range: i });
      return d.kind === "line" ? d.series[0].values.length : 0;
    };
    expect(len(0)).toBe(FORECAST_YEARS[0] * 12 + 1);
    expect(len(2)).toBeGreaterThan(len(0));
  });

  it("the allocation shares add up to the whole, in every view", () => {
    const c = ctx();
    for (let mode = 0; mode < ALLOC_MODES.length; mode++) {
      const d = buildChart("alloc", c, { ...OPTS, mode });
      expect(d.kind).toBe("hbars");
      if (d.kind !== "hbars") continue;
      const shares = d.items.map((i) => Number((i.note ?? "").split("%")[0].replace(",", ".")));
      expect(shares.reduce((a, b) => a + b, 0)).toBeGreaterThan(99.5);
      expect(shares.reduce((a, b) => a + b, 0)).toBeLessThan(100.5);
    }
  });

  it("the price chart steps through the holdings and wraps around", () => {
    const c = ctx();
    const n = priceHoldings(c).length;
    expect(n).toBeGreaterThan(1);
    const title = (pick: number) => buildChart("price", c, { ...OPTS, pick }).title;
    expect(title(0)).not.toBe(title(1));
    expect(title(n)).toBe(title(0));
    expect(title(-1)).toBe(title(n - 1));
  });

  it("an empty portfolio gives a message, not a crash", () => {
    const c = ctx();
    c.series = [];
    expect(buildChart("value", c, OPTS).kind).toBe("empty");
    expect(frame(c, "value")).toContain("Nincs elég adat");
  });
});
