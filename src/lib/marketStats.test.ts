import { describe, expect, it } from "vitest";
import { marketStats } from "./marketStats";

describe("marketStats", () => {
  const series: [string, number][] = [
    ["2025-09-01", 500],
    ["2025-10-20", 100],
    ["2026-03-02", 120],
    ["2026-06-01", 80],
    ["2026-10-07", 110],
  ];

  it("52-week range, distance from the high and position in the range, last year only", () => {
    const s = marketStats(series, "2026-10-08")!;
    expect(s).toMatchObject({ low: 80, high: 120, last: 110, sinceDay: "2025-10-20" });
    expect(s.fromHigh).toBeCloseTo(110 / 120 - 1);
    expect(s.rangePos).toBeCloseTo(0.75);
  });

  it("a live price is the latest point; it replaces today's close", () => {
    expect(marketStats(series, "2026-10-08", 130)).toMatchObject({ high: 130, last: 130, fromHigh: 0 });
    const withToday: [string, number][] = [...series, ["2026-10-08", 90]];
    expect(marketStats(withToday, "2026-10-08", 100)).toMatchObject({ last: 100 });
  });

  it("no stats from less than two points", () => {
    expect(marketStats(undefined, "2026-10-08")).toBeNull();
    expect(marketStats([["2026-10-07", 1]], "2026-10-08")).toBeNull();
  });
});
