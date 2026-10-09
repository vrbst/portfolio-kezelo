import { beforeEach, describe, expect, it } from "vitest";
import { alertDaysPerMonth, dailyAbsMoves, moveCrosses, typicalMovePct } from "./moveAlerts";
import { loadMoveAlertSettings, saveMoveAlertSettings } from "./planPrefs";
import { collectPrefs } from "./prefs";
import { installLocalStorage } from "../../scripts/notify/env";

describe("move statistics", () => {
  const series = (closes: number[]): [string, number][] =>
    closes.map((c, i) => [`2026-01-${String(i + 1).padStart(2, "0")}`, c]);

  it("daily moves are the absolute close-to-close changes of the last N days", () => {
    const m = dailyAbsMoves(series([100, 102, 99.96, 0, 100, 101]), 10);
    expect(m.map((x) => Math.round(x * 10_000) / 10_000)).toEqual([0.02, 0.02, 0.01]);
    expect(dailyAbsMoves(series([1, 2, 4, 8]), 2)).toEqual([1, 1]);
    expect(dailyAbsMoves(undefined)).toEqual([]);
  });

  it("a move crosses the threshold the same way the bot counts it, exact hits included", () => {
    expect(moveCrosses(0.01, 1)).toBe(true);
    expect(moveCrosses(0.0099, 1)).toBe(false);
    expect(moveCrosses(0.07, 3.5)).toBe(true);
  });

  it("alert days per month scale the hit rate to 21 trading days", () => {
    expect(alertDaysPerMonth([0.005, 0.015, 0.02, 0.001], 1)).toBeCloseTo(10.5);
    expect(alertDaysPerMonth([], 1)).toBeNull();
  });

  it("the typical move is the median", () => {
    expect(typicalMovePct([0.01, 0.03, 0.02])).toBeCloseTo(2);
    expect(typicalMovePct([0.01, 0.02, 0.03, 0.04])).toBeCloseTo(2.5);
    expect(typicalMovePct([])).toBeNull();
  });
});

describe("move alert settings", () => {
  beforeEach(() => installLocalStorage());

  it("malformed thresholds are dropped on load", () => {
    localStorage.setItem(
      "pf-move-alerts",
      JSON.stringify({ portfolioPct: -1, positionPct: "2", byKey: { A: 3, B: 0, C: "x", D: null } }),
    );
    expect(loadMoveAlertSettings()).toEqual({ byKey: { A: 3 } });
    localStorage.setItem("pf-move-alerts", "[1]");
    expect(loadMoveAlertSettings()).toEqual({ byKey: {} });
  });

  it("a saved setting is part of the synced prefs", () => {
    saveMoveAlertSettings({ portfolioPct: 2, byKey: { "EUR/HUF": 0.5 } });
    expect(collectPrefs()?.moveAlerts?.value).toEqual({ portfolioPct: 2, byKey: { "EUR/HUF": 0.5 } });
  });
});
