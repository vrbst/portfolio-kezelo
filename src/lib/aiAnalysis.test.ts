import { describe, expect, it } from "vitest";
import {
  newestAnalysis,
  validateNightly,
  type Analysis,
  type StoredAnalysis,
} from "./aiAnalysis";

const data: Analysis = {
  headline: "Rendben.",
  overall: "rendben",
  changes: "",
  sections: [{ topic: "hozam", title: "Hozam", status: "rendben", text: "Szép." }],
};
const stored = (at: string): StoredAnalysis => ({ at, model: "opus", costUsd: 0, data });

describe("validateNightly", () => {
  const file = { version: 1, day: "2026-10-15", at: "2026-10-15T01:30:00Z", model: "opus", engine: "claude-code", costUsd: 0.2, data };

  it("accepts what the nightly job writes", () => {
    expect(validateNightly(file)).toEqual(file);
  });

  it("refuses a newer version, a missing day and an unreadable analysis", () => {
    expect(() => validateNightly({ ...file, version: 2 })).toThrow("újabb verzió");
    expect(() => validateNightly({ ...file, day: "tegnap" })).toThrow("nap");
    expect(() => validateNightly({ ...file, data: { nope: 1 } })).toThrow("nem értelmezhető");
    expect(() => validateNightly("x")).toThrow();
  });
});

describe("newestAnalysis", () => {
  it("picks the later one, and whichever exists", () => {
    const a = stored("2026-10-14T10:00:00Z");
    const b = stored("2026-10-15T01:30:00Z");
    expect(newestAnalysis(a, b)).toBe(b);
    expect(newestAnalysis(b, a)).toBe(b);
    expect(newestAnalysis(a, undefined)).toBe(a);
    expect(newestAnalysis(undefined, b)).toBe(b);
    expect(newestAnalysis(undefined, undefined)).toBeUndefined();
  });
});
