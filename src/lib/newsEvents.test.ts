import { describe, expect, it } from "vitest";
import {
  EVENT_KINDS,
  EVENT_RESULTS_SIZE,
  NEWS_JSON_SCHEMA,
  emptyEventsFile,
  validateDigestBody,
  validateEventsFile,
  withEventResult,
} from "./newsSchema";
import { fixtureEventsFile, fixtureNewsBody } from "../test/newsFixture";

const upcomingOf = (extra: Record<string, unknown>) => {
  const b = fixtureNewsBody();
  b.upcoming = [{ date: "2026-10-15", event: "Teszt", why: "Mert.", ...extra }];
  return validateDigestBody(b).upcoming[0];
};

describe("the upcoming events of a digest: follow-up fields", () => {
  it("an old digest (no new fields) stays valid and gets none", () => {
    expect(upcomingOf({})).toEqual({ date: "2026-10-15", event: "Teszt", why: "Mert." });
  });

  it("the model's nulls (strict output) are dropped", () => {
    expect(
      upcomingOf({ time: null, followUp: false, kind: null, pressTime: null, expected: null }),
    ).toEqual({ date: "2026-10-15", event: "Teszt", why: "Mert." });
  });

  it("a good follow-up is kept, trimmed", () => {
    expect(
      upcomingOf({ time: " 14:30 ", followUp: true, kind: "US_CPI", pressTime: "15:45", expected: " 3,0% " }),
    ).toMatchObject({ time: "14:30", followUp: true, kind: "US_CPI", pressTime: "15:45", expected: "3,0%" });
  });

  it.each(["14:3", "25:00", "14.30", "dél", "14:30:00", ""])("a bad time %j is dropped, not an error", (t) => {
    const u = upcomingOf({ time: t, pressTime: t, followUp: true });
    expect(u.time).toBeUndefined();
    expect(u.pressTime).toBeUndefined();
  });

  it("an unknown kind becomes OTHER", () => {
    expect(upcomingOf({ kind: "UFO_SIGHTING" }).kind).toBe("OTHER");
  });

  it("the model's schema asks for every field (strict output) and knows the kinds", () => {
    const item = NEWS_JSON_SCHEMA.properties.upcoming.items;
    expect(item.required).toEqual(
      expect.arrayContaining(["date", "event", "why", "time", "followUp", "kind", "pressTime", "expected"]),
    );
    expect(item.properties.kind.enum).toEqual([...EVENT_KINDS, null]);
  });
});

describe("news/events.json", () => {
  it("round-trips", () => {
    const f = fixtureEventsFile();
    expect(validateEventsFile(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it("refuses a non-object and a newer version", () => {
    expect(() => validateEventsFile("x")).toThrow(/nem objektum/);
    expect(() => validateEventsFile({ ...fixtureEventsFile(), version: 2 })).toThrow(/újabb/);
  });

  it("drops damaged entries and keeps the good ones", () => {
    const f = fixtureEventsFile();
    const raw = {
      ...f,
      results: [{ nonsense: true }, { ...f.results[0], time: "dél" }, f.results[0]],
      subscriptions: [{ ...f.subscriptions[0], status: "sleeping" }, f.subscriptions[0]],
      latency: { US_CPI: { samples: 4, delayMin: 7 }, BAD: "x" },
    };
    const v = validateEventsFile(raw);
    expect(v.results).toEqual([f.results[0]]);
    expect(v.subscriptions).toEqual([f.subscriptions[0]]);
    expect(v.latency).toEqual({ US_CPI: { samples: 4, delayMin: 7 } });
  });

  it("an empty or minimal file is fine", () => {
    expect(validateEventsFile({ version: 1 })).toEqual(emptyEventsFile());
  });

  it("an http-less source is dropped from a result", () => {
    const f = fixtureEventsFile();
    f.results[0].sources = [{ title: "x", url: "javascript:alert(1)" }];
    expect(validateEventsFile(f).results[0].sources).toEqual([]);
  });
});

describe("withEventResult", () => {
  const result = (n: number, day = "2026-10-14", time = "14:30") => ({
    ...fixtureEventsFile().results[0],
    key: `release|${day}|${time}#${n}`,
    date: day,
    time,
  });

  it("newest first; a rerun of the same slot replaces its result", () => {
    let f = withEventResult(null, result(0, "2026-10-14"));
    f = withEventResult(f, result(0, "2026-10-15"));
    f = withEventResult(f, { ...result(0, "2026-10-14"), actual: "újra" });
    expect(f.results.map((r) => `${r.date} ${r.actual}`)).toEqual(["2026-10-15 3,2% é/é", "2026-10-14 újra"]);
  });

  it("keeps the subscriptions and the learned delays, and trims the old results", () => {
    let f = fixtureEventsFile();
    for (let i = 0; i < EVENT_RESULTS_SIZE + 5; i++) f = withEventResult(f, result(i, "2026-09-01", "10:00"));
    expect(f.results).toHaveLength(EVENT_RESULTS_SIZE);
    expect(f.subscriptions).toEqual(fixtureEventsFile().subscriptions);
    expect(f.latency).toEqual(fixtureEventsFile().latency);
  });
});
