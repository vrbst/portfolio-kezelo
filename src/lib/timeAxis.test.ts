import { describe, expect, it } from "vitest";
import { formatTimeTick, timeTicks } from "./timeAxis";
import { localDayMs } from "./day";

const ms = (day: string) => localDayMs(day);

describe("timeTicks", () => {
  it("a week without a month start still gets daily labels", () => {
    const { ticks, daily } = timeTicks(ms("2026-10-08"), ms("2026-10-15"));
    expect(daily).toBe(true);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks[0]).toBe(ms("2026-10-08"));
    expect(ticks.every((t) => t >= ms("2026-10-08") && t <= ms("2026-10-15"))).toBe(true);
  });

  it("two weeks are labelled by day, a long span by month", () => {
    expect(timeTicks(ms("2026-09-23"), ms("2026-10-07")).daily).toBe(true);
    const long = timeTicks(ms("2024-01-10"), ms("2026-10-07"));
    expect(long.daily).toBe(false);
    expect(long.ticks.length).toBeLessThanOrEqual(8);
  });

  it("day ticks sit on local midnights across the DST change", () => {
    const { ticks } = timeTicks(ms("2026-10-20"), ms("2026-10-30"));
    for (const t of ticks) {
      const d = new Date(t);
      expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
    }
  });

  it("formats day ticks as month and day, month ticks as month", () => {
    expect(formatTimeTick(ms("2026-10-08"), true)).toMatch(/10\.\s?08/);
    expect(formatTimeTick(ms("2026-10-01"), false)).toMatch(/okt/);
  });
});
