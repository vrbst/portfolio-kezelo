import { describe, expect, it } from "vitest";
import { resample, sparkline } from "./spark";

describe("sparkline", () => {
  it("scales min to the lowest and max to the highest block", () => {
    expect(sparkline([1, 2, 3], 10)).toBe("▁▅█");
    expect(sparkline([3, 1], 10)).toBe("█▁");
  });

  it("draws a flat series in the middle", () => {
    expect(sparkline([5, 5, 5], 10)).toBe("▄▄▄");
  });

  it("is empty for no data or no width", () => {
    expect(sparkline([], 10)).toBe("");
    expect(sparkline([1, 2], 0)).toBe("");
  });

  it("down-samples to the width, keeping the last value", () => {
    const v = Array.from({ length: 100 }, (_, i) => i);
    const r = resample(v, 10);
    expect(r).toHaveLength(10);
    expect(r[9]).toBe(99);
    expect(sparkline(v, 10)).toHaveLength(10);
  });

  it("leaves a short series as is", () => {
    expect(resample([1, 2], 5)).toEqual([1, 2]);
  });
});
