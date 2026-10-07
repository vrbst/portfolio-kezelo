import { describe, expect, it } from "vitest";
import {
  RANGES,
  effectiveRange,
  profitBase,
  rangeAvailability,
  rangeCutoff,
  sliceRange,
} from "./chartRange";
import { addDaysIso } from "./day";

const NOW = new Date(2026, 9, 7, 12);
const point = (date: string, value: number, invested: number) => ({ date, value, invested });
const daily = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => point(addDaysIso(from, i), 1_000 + i, 900));

describe("rangeCutoff", () => {
  it("counts calendar days back from the local day", () => {
    expect(rangeCutoff("1w", NOW)).toBe("2026-09-30");
    expect(rangeCutoff("2w", NOW)).toBe("2026-09-23");
    expect(rangeCutoff("1m", NOW)).toBe("2026-09-07");
    expect(rangeCutoff("1y", NOW)).toBe("2025-10-07");
    expect(rangeCutoff("ytd", NOW)).toBe("2026-01-01");
    expect(rangeCutoff("max", NOW)).toBeNull();
  });

  it("just after local midnight it is still that local day", () => {
    expect(rangeCutoff("1w", new Date(2026, 9, 7, 0, 30))).toBe("2026-09-30");
  });

  it("has a short, unambiguous label and a full title for every range", () => {
    const labels = RANGES.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((l) => l.length <= 4)).toBe(true);
    expect(RANGES.every((r) => r.title.length > 0)).toBe(true);
  });
});

describe("rangeAvailability / sliceRange", () => {
  const sparse = [point("2020-01-03", 1, 1), point("2023-05-01", 2, 1), point("2026-10-07", 3, 1)];

  it("a range needs at least two points inside it", () => {
    const a = rangeAvailability(sparse, NOW);
    expect(a["1w"]).toBe(false);
    expect(a["1y"]).toBe(false);
    expect(a.max).toBe(true);
  });

  it("agrees with a plain filter on a daily series", () => {
    const s = daily("2025-01-01", 645);
    const a = rangeAvailability(s, NOW);
    for (const { key } of RANGES) {
      const cutoff = rangeCutoff(key, NOW);
      const n = cutoff ? s.filter((p) => p.date >= cutoff).length : s.length;
      expect(a[key]).toBe(n >= 2);
      expect(sliceRange(s, key, NOW)).toHaveLength(n);
    }
  });

  it("never falls back to the whole series while a short range is selected", () => {
    expect(sliceRange(sparse, "1w", NOW)).toEqual([point("2026-10-07", 3, 1)]);
  });
});

describe("effectiveRange", () => {
  it("the selected range when it has data, else the next longer one that has", () => {
    const avail = { "1w": false, "2w": false, "1m": true, "3m": true, "6m": true, "1y": true, ytd: true, max: true };
    expect(effectiveRange("3m", avail)).toBe("3m");
    expect(effectiveRange("1w", avail)).toBe("1m");
    const none = { ...avail, "1m": false, "3m": false, "6m": false, "1y": false, ytd: false };
    expect(effectiveRange("2w", none)).toBe("max");
  });
});

describe("profitBase", () => {
  it("a short range measures the gain from its own first day; Max the lifetime gain", () => {
    const s = [point("2026-09-30", 1_200, 1_000), point("2026-10-07", 1_150, 1_000)];
    expect(profitBase(s, "1w")).toBe(200);
    expect(s.at(-1)!.value - s.at(-1)!.invested - profitBase(s, "1w")).toBe(-50);
    expect(profitBase(s, "max")).toBe(0);
    expect(profitBase([], "1w")).toBe(0);
  });
});
