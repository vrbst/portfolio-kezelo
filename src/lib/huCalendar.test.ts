import { describe, expect, it } from "vitest";
import { easterSunday, isPublicHoliday, isWorkday, lastWorkdayOfMonth, SWAPPED_DAYS } from "./huCalendar";

// The month boundary of every goal (payday = the month's last working day)
// and the month-end leftover reminder depend on this calendar.

describe("Hungarian working-day calendar", () => {
  it("Easter dates", () => {
    expect(easterSunday(2025)).toEqual([3, 20]);
    expect(easterSunday(2026)).toEqual([3, 5]);
    expect(easterSunday(2027)).toEqual([2, 28]);
  });

  it("Easter-bound and fixed holidays", () => {
    expect(isPublicHoliday(2026, 3, 3)).toBe(true); // nagypéntek
    expect(isPublicHoliday(2026, 3, 6)).toBe(true); // húsvéthétfő
    expect(isPublicHoliday(2026, 4, 25)).toBe(true); // pünkösdhétfő
    expect(isPublicHoliday(2026, 9, 23)).toBe(true);
    expect(isPublicHoliday(2026, 3, 7)).toBe(false);
  });

  it("swapped days: a Saturday worked, a weekday off", () => {
    expect(isWorkday(new Date(2026, 0, 10, 12))).toBe(true); // Sat, worked
    expect(isWorkday(new Date(2026, 0, 2, 12))).toBe(false); // Fri, off
    expect(isWorkday(new Date(2026, 11, 24, 12))).toBe(false);
  });

  it("the month's last working day (payday)", () => {
    const expected: [number, number, number][] = [
      [2026, 0, 30], // 31 Jan is a Saturday
      [2026, 3, 30],
      [2026, 4, 29], // 30–31 May weekend
      [2026, 7, 31],
      [2026, 9, 30], // 31 Oct Saturday
      [2026, 11, 31], // 24–26 Dec off, 31 Dec a Thursday
      [2025, 9, 31], // 24 Oct 2025 swapped off, 31 Oct a Friday
    ];
    for (const [y, m0, d] of expected) expect([y, m0, lastWorkdayOfMonth(y, m0)]).toEqual([y, m0, d]);
  });

  it("the swapped days of the current and — from December — next year are recorded", () => {
    // The decree is published each autumn; without it the month-end dates of
    // the missing year may be wrong. This test turns red on 1 December so the
    // new year's days get added in time (src/lib/huCalendar.ts SWAPPED_DAYS).
    const now = new Date();
    const years = new Set(Object.keys(SWAPPED_DAYS).map((d) => Number(d.slice(0, 4))));
    expect(years.has(now.getFullYear()), `hiányzik a ${now.getFullYear()}. évi munkanap-áthelyezés`).toBe(true);
    if (now.getMonth() === 11)
      expect(years.has(now.getFullYear() + 1), `hiányzik a ${now.getFullYear() + 1}. évi munkanap-áthelyezés`).toBe(true);
  });
});
