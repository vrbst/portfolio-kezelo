import { describe, expect, it } from "vitest";
import { builtHistory } from "./glideChartData";
import type { WeightPoint } from "../lib/rebalance";

// Invented sample data.
const point = (day: string, ws: Record<string, number>): WeightPoint => ({
  day,
  buckets: Object.fromEntries(
    Object.entries(ws).map(([id, weight]) => [id, { weight, target: 0.5, low: 0.45, high: 0.55, status: "within" as const }]),
  ),
});

describe("builtHistory", () => {
  const h = [
    point("2026-03-01", { R: 1, K: 0, C: 0 }),
    point("2026-04-01", { R: 0.35, K: 0.65, C: 0 }),
    point("2026-05-01", { R: 0.4, K: 0.6, C: 0 }),
    point("2026-10-01", { R: 0.42, K: 0.55, C: 0.03 }),
  ];

  it("drops only the months the charted bucket was 0% or 100%", () => {
    expect(builtHistory(h, "R").map((p) => p.day)).toEqual(["2026-04-01", "2026-05-01", "2026-10-01"]);
  });

  it("a long-empty other bucket does not hide the past", () => {
    // C was empty until October — charting R must still show April on.
    expect(builtHistory(h, "R")[0].day).toBe("2026-04-01");
  });
});
