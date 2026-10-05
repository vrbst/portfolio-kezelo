import { describe, expect, it } from "vitest";
import {
  NEWS_INDEX_SIZE,
  digestKey,
  rankedItems,
  validateDigest,
  validateDigestBody,
  validateNewsIndex,
  withIndexEntry,
} from "./newsSchema";
import { fixtureDigest, fixtureNewsBody } from "../test/newsFixture";

describe("validateDigestBody", () => {
  it("accepts a good answer and trims it", () => {
    const body = fixtureNewsBody();
    body.headline = "  Fej  ";
    const v = validateDigestBody(body);
    expect(v.headline).toBe("Fej");
    expect(v.items).toHaveLength(7);
  });

  it.each([
    ["not an object", () => "szöveg"],
    ["no items", () => ({ ...fixtureNewsBody(), items: [] })],
    ["unknown category", () => {
      const b = fixtureNewsBody();
      (b.items[0] as { category: string }).category = "sport";
      return b;
    }],
    ["importance out of range", () => {
      const b = fixtureNewsBody();
      (b.items[0] as { importance: number }).importance = 5;
      return b;
    }],
    ["no source", () => {
      const b = fixtureNewsBody();
      b.items[0].sources = [];
      return b;
    }],
    ["a source without http(s)", () => {
      const b = fixtureNewsBody();
      b.items[0].sources = [{ title: "x", url: "javascript:alert(1)" }];
      return b;
    }],
    ["an upcoming event without a proper date", () => {
      const b = fixtureNewsBody();
      b.upcoming[0].date = "október 20.";
      return b;
    }],
  ])("refuses %s", (_name, make) => {
    expect(() => validateDigestBody(make())).toThrow();
  });
});

describe("validateDigest", () => {
  it("round-trips a stored digest", () => {
    const d = fixtureDigest();
    expect(validateDigest(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it("refuses a newer version and an unknown edition", () => {
    expect(() => validateDigest({ ...fixtureDigest(), version: 2 })).toThrow(/újabb/);
    expect(() => validateDigest({ ...fixtureDigest(), edition: "noon" })).toThrow(/kiadás/);
  });
});

describe("the index", () => {
  it("orders by day, the evening edition after the morning one, and replaces a rerun", () => {
    let idx = withIndexEntry(null, fixtureDigest("2026-10-13", "evening"));
    idx = withIndexEntry(idx, fixtureDigest("2026-10-14", "evening"));
    idx = withIndexEntry(idx, fixtureDigest("2026-10-14", "morning"));
    idx = withIndexEntry(idx, { ...fixtureDigest("2026-10-14", "morning"), headline: "újra" });
    expect(idx.entries.map((e) => `${e.day} ${e.edition}`)).toEqual([
      "2026-10-14 evening",
      "2026-10-14 morning",
      "2026-10-13 evening",
    ]);
    expect(idx.entries[1].headline).toBe("újra");
    expect(idx.entries[0].titles).toHaveLength(7);
    expect(digestKey({ day: "2026-10-14", edition: "morning" }) < digestKey({ day: "2026-10-14", edition: "evening" })).toBe(true);
  });

  it("keeps the newest NEWS_INDEX_SIZE entries", () => {
    let idx = null;
    for (let i = 0; i < NEWS_INDEX_SIZE + 5; i++) {
      const d = new Date(2026, 0, 1 + i);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      idx = withIndexEntry(idx, fixtureDigest(day));
    }
    expect(idx!.entries).toHaveLength(NEWS_INDEX_SIZE);
    expect(idx!.entries.at(-1)!.day).toBe("2026-01-06");
  });

  it("drops malformed index entries", () => {
    const idx = validateNewsIndex({
      version: 1,
      entries: [{ day: "2026-10-14", edition: "evening", headline: "h", count: 1, titles: ["a"] }, { day: "rossz" }],
    });
    expect(idx.entries).toHaveLength(1);
  });
});

it("rankedItems: most important first, the model's order breaks ties", () => {
  const titles = rankedItems(fixtureNewsBody().items).map((i) => i.title);
  expect(titles[0]).toMatch(/forint/);
  expect(titles[1]).toBe("Az MNB kivárást jelzett");
  expect(titles.at(-1)).toMatch(/háttérhír/);
});
