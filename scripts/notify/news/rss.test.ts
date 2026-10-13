import { describe, expect, it } from "vitest";
import { coverageUrl, parseRss, probeCoverage } from "./rss";

const feed = (...items: [string, string][]) =>
  `<?xml version="1.0"?><rss><channel><title>Google News</title>${items
    .map(([title, date]) => `<item><title>${title}</title><link>https://example.com</link><pubDate>${date}</pubDate></item>`)
    .join("")}</channel></rss>`;

const response = (body: string, ok = true) => ({ ok, text: async () => body }) as Response;
const since = new Date("2026-10-14T12:30:00Z");

describe("parseRss", () => {
  it("reads titles and dates; CDATA and entities are undone; broken items skipped", () => {
    const items = parseRss(
      feed(
        ["<![CDATA[US CPI rises &amp; falls]]>", "Wed, 14 Oct 2026 12:34:00 GMT"],
        ["Dátum nélkül", "nem dátum"],
        ["Rendes &quot;cím&quot;", "Wed, 14 Oct 2026 12:40:00 GMT"],
      ),
    );
    expect(items).toEqual([
      { title: "US CPI rises & falls", published: Date.parse("2026-10-14T12:34:00Z") },
      { title: 'Rendes "cím"', published: Date.parse("2026-10-14T12:40:00Z") },
    ]);
  });

  it("not a feed → nothing", () => {
    expect(parseRss("<html>nope</html>")).toEqual([]);
  });
});

describe("coverageUrl", () => {
  it("English search for the US/EU kinds, Hungarian for the Hungarian ones; the event's name for the rest", () => {
    expect(decodeURIComponent(coverageUrl("US_CPI", "bármi"))).toContain("q=US CPI inflation when:1d&hl=en-US");
    expect(decodeURIComponent(coverageUrl("MNB_RATE", "bármi"))).toContain("q=MNB kamatdöntés when:1d&hl=hu&gl=HU");
    expect(decodeURIComponent(coverageUrl("OTHER", "ÁKK aukció"))).toContain("q=ÁKK aukció when:1d&hl=hu");
  });
});

describe("probeCoverage", () => {
  it("counts the articles since the announcement and finds the first", async () => {
    const fetchFn = (async () =>
      response(
        feed(
          ["Előzetes: mire számítsunk", "Wed, 14 Oct 2026 11:00:00 GMT"],
          ["CPI kint van", "Wed, 14 Oct 2026 12:36:00 GMT"],
          ["CPI elemzés", "Wed, 14 Oct 2026 12:41:00 GMT"],
        ),
      )) as unknown as typeof fetch;
    expect(await probeCoverage("US_CPI", "US CPI", since, fetchFn)).toEqual({
      count: 2,
      earliest: "2026-10-14T12:36:00.000Z",
    });
  });

  it("only older articles → zero coverage", async () => {
    const fetchFn = (async () =>
      response(feed(["Előzetes", "Wed, 14 Oct 2026 08:00:00 GMT"]))) as unknown as typeof fetch;
    expect(await probeCoverage("US_CPI", "US CPI", since, fetchFn)).toEqual({ count: 0, earliest: "" });
  });

  it("a failing feed is unknown (null), never an error", async () => {
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const blocked = (async () => response("", false)) as unknown as typeof fetch;
    expect(await probeCoverage("US_CPI", "US CPI", since, down)).toBeNull();
    expect(await probeCoverage("US_CPI", "US CPI", since, blocked)).toBeNull();
  });
});
