import { describe, expect, it } from "vitest";
import { tbszExitScenarios, tbszStatus } from "./tbsz";

// TBSZ tax phases (Szja tv. 67/B §): collection year Y, lock to 31 Dec Y+3,
// full maturity after 31 Dec Y+5; szocho only for collection year ≥ 2025.

describe("tbszStatus – phases switch at local midnight of 1 January", () => {
  const cases: [Date, string, number][] = [
    [new Date(2025, 5, 1), "collecting", 0.28],
    [new Date(2025, 11, 31, 23, 59), "collecting", 0.28],
    [new Date(2026, 0, 1, 0, 0, 1), "locked", 0.28],
    [new Date(2028, 11, 31, 23, 0), "locked", 0.28],
    [new Date(2029, 0, 1, 0, 0, 1), "reduced", 0.18],
    [new Date(2030, 11, 31, 12), "reduced", 0.18],
    [new Date(2031, 0, 1, 0, 0, 1), "matured", 0],
  ];
  for (const [now, phase, rate] of cases) {
    it(`2025 vintage on ${now.toLocaleString("hu-HU")}: ${phase}, ${rate * 100}%`, () => {
      const s = tbszStatus(2025, now);
      expect(s.phase).toBe(phase);
      expect(s.taxRate).toBeCloseTo(rate, 10);
    });
  }

  it("a pre-2025 vintage pays no szocho", () => {
    expect(tbszStatus(2024, new Date(2026, 5, 1)).taxRate).toBeCloseTo(0.15, 10);
    expect(tbszStatus(2024, new Date(2028, 5, 1)).taxRate).toBeCloseTo(0.1, 10);
    expect(tbszStatus(2024, new Date(2030, 5, 1)).taxRate).toBe(0);
  });

  it("the next milestone and the days to it", () => {
    const s = tbszStatus(2025, new Date(2026, 11, 30, 12));
    expect(s.next?.key).toBe("three");
    // Milestone days are local calendar days, whatever the time zone.
    expect(new Date(s.milestones[0].date).getDate()).toBe(31);
    expect(new Date(s.milestones[0].date).getMonth()).toBe(11);
    expect(s.progress).toBeGreaterThan(0);
    expect(s.progress).toBeLessThan(1);
  });
});

describe("tbszExitScenarios", () => {
  it("taxes only a positive gain, with the saving from waiting", () => {
    const s = tbszStatus(2025, new Date(2026, 5, 1));
    const [early, three, five] = tbszExitScenarios(s, 1_200_000, 200_000);
    expect([early.state, three.state, five.state]).toEqual(["current", "future", "future"]);
    expect(early.taxHuf).toBeCloseTo(56_000, 6);
    expect(early.netHuf).toBeCloseTo(1_144_000, 6);
    expect(three.taxHuf).toBeCloseTo(36_000, 6);
    expect(three.savedVsNowHuf).toBeCloseTo(20_000, 6);
    expect(five.taxHuf).toBe(0);
    expect(five.netHuf).toBe(1_200_000);
    expect(five.savedVsNowHuf).toBeCloseTo(56_000, 6);
    for (const x of tbszExitScenarios(s, 900_000, -100_000)) expect(x.taxHuf).toBe(0);
  });
});
