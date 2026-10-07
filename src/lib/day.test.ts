import { describe, expect, it } from "vitest";
import { addDaysIso, localDayMs, toLocalDay, utcDay } from "./day";

// Tests run in Europe/Budapest by default (vite.config.ts) and in CI also in
// UTC and America/New_York; every assertion here must hold in all of them.

describe("day helpers", () => {
  it("toLocalDay: local midnight stays on its own day", () => {
    const localMidnight = new Date(2026, 9, 28);
    expect(toLocalDay(localMidnight)).toBe("2026-10-28");
    expect(toLocalDay(localMidnight.getTime())).toBe("2026-10-28");
    // The stored ISO form of a local-midnight date also reads back correctly.
    expect(toLocalDay(new Date(localMidnight.toISOString()))).toBe("2026-10-28");
  });

  it("toLocalDay: late evening is still the same local day", () => {
    expect(toLocalDay(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
    expect(toLocalDay(new Date(2026, 0, 1, 0, 1))).toBe("2026-01-01");
  });

  it("utcDay reads a UTC instant", () => {
    expect(utcDay(Date.UTC(2026, 2, 29))).toBe("2026-03-29");
    expect(utcDay(Date.UTC(2026, 2, 29, 23, 59))).toBe("2026-03-29");
  });

  it("addDaysIso crosses month, year and DST boundaries", () => {
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysIso("2028-03-01", -1)).toBe("2028-02-29");
    // Budapest DST switches: 2026-03-29 and 2026-10-25.
    expect(addDaysIso("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDaysIso("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDaysIso("2026-01-01", 365)).toBe("2027-01-01");
  });

  it("localDayMs: a bare day and the stored instant of its local midnight are the same local midnight", () => {
    const localMidnight = new Date(2026, 9, 28).getTime();
    expect(localDayMs("2026-10-28")).toBe(localMidnight);
    expect(localDayMs(new Date(2026, 9, 28).toISOString())).toBe(localMidnight);
    expect(localDayMs(new Date(2026, 9, 28, 15, 30).toISOString())).toBe(localMidnight);
    expect(localDayMs(undefined)).toBeNaN();
    expect(localDayMs("nem dátum")).toBeNaN();
  });
});
