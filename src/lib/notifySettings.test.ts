import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_NOTIFY, loadNotifySettings, saveNotifySettings, type NotifySettings } from "./planPrefs";
import { applyRemotePrefs, collectPrefs, mergePrefs } from "./prefs";
import { installLocalStorage } from "../../scripts/notify/env";

describe("notify settings", () => {
  beforeEach(() => installLocalStorage());

  it("nothing saved → the defaults, which equal today's behaviour", () => {
    expect(loadNotifySettings()).toEqual(DEFAULT_NOTIFY);
    expect(DEFAULT_NOTIFY).toMatchObject({ weeklyHour: 18, monthlyHour: 8, planReminderDay: 10, off: {} });
  });

  it("malformed values fall back field by field", () => {
    localStorage.setItem(
      "pf-notify",
      JSON.stringify({
        off: { weekly: true, nonsense: true, yearly: "yes" },
        ai: { newsMorning: "off", newsEvening: "maybe", analysis: "silent", why: "silent" },
        wealthStepHuf: -5,
        drawdownStepPct: "3",
        weeklyHour: 24,
        monthlyHour: 7.5,
        planReminderDay: 29,
        quietHours: { from: "25:00", to: "07:30" },
      }),
    );
    expect(loadNotifySettings()).toEqual({
      ...DEFAULT_NOTIFY,
      off: { weekly: true },
      ai: { newsMorning: "off", newsEvening: "notify", analysis: "silent", why: "notify" },
    });
    localStorage.setItem("pf-notify", "[1]");
    expect(loadNotifySettings()).toEqual(DEFAULT_NOTIFY);
  });

  it("valid values are kept; null quiet hours mean none", () => {
    const v: NotifySettings = {
      off: { drawdown: true },
      ai: { newsMorning: "silent", newsEvening: "off", analysis: "notify", why: "off" },
      wealthStepHuf: 500_000,
      drawdownStepPct: 3,
      weeklyHour: 20,
      monthlyHour: 0,
      planReminderDay: 1,
      quietHours: null,
    };
    saveNotifySettings(v);
    expect(loadNotifySettings()).toEqual(v);
  });

  it("is a synced pref: collected, merged last-write-wins, applied from the cloud copy", () => {
    saveNotifySettings({ ...DEFAULT_NOTIFY, weeklyHour: 20 });
    const local = collectPrefs()!;
    expect(local.notify?.value.weeklyHour).toBe(20);

    const newer = { notify: { updatedAt: "2999-01-01T00:00:00.000Z", value: { ...DEFAULT_NOTIFY, weeklyHour: 19 } } };
    expect(mergePrefs(local, newer)?.notify?.value.weeklyHour).toBe(19);

    expect(applyRemotePrefs(newer)).toBe(true);
    expect(loadNotifySettings().weeklyHour).toBe(19);
  });
});
