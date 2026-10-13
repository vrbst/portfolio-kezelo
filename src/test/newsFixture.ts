// Invented market-news digests for the tests (no real news, no real data).

import type { EventsFile, NewsDigest, NewsDigestBody, NewsEdition } from "../lib/newsSchema";

export function fixtureNewsBody(): NewsDigestBody {
  return {
    headline: "Teszt-nap: gyengült a forint, a világindex emelkedett, az MNB kivárást jelzett.",
    items: [
      {
        category: "geopolitics",
        region: "global",
        importance: 1,
        title: "Kitalált háttérhír a kereskedelmi tárgyalásokról",
        summary: "Háttér, a portfóliót közvetlenül nem mozgatja.",
        impact: "neutral",
        affects: [],
        sources: [{ title: "Példa Hírügynökség", url: "https://example.com/hatter" }],
      },
      {
        category: "fx",
        region: "hu",
        importance: 3,
        title: "Gyengült a forint <az euróval> szemben",
        summary: "A gyengébb forint a devizás eszközök forintértékét növeli.",
        impact: "up",
        affects: ["EUR/HUF", "VWCE", "WBIT"],
        sources: [{ title: "Példa Portál", url: "https://example.com/forint" }],
      },
      {
        category: "rates",
        region: "hu",
        importance: 2,
        title: "Az MNB kivárást jelzett",
        summary: "A változatlan kamat a DKJ-hozamokat tartja.",
        impact: "neutral",
        affects: ["DKJ"],
        sources: [{ title: "Példa Jegybank", url: "https://example.com/mnb" }],
      },
      {
        category: "equities",
        region: "us",
        importance: 2,
        title: "Emelkedtek a nagy amerikai indexek",
        summary: "A világindex-ETF legnagyobb súlya amerikai.",
        impact: "up",
        affects: ["VWCE"],
        sources: [{ title: "Példa Tőzsde", url: "https://example.com/indexek" }],
      },
      {
        category: "crypto",
        region: "global",
        importance: 2,
        title: "Esett a bitcoin",
        summary: "A WBIT a bitcoint követi.",
        impact: "down",
        affects: ["WBIT"],
        sources: [{ title: "Példa Kripto", url: "https://example.com/btc" }],
      },
      {
        category: "hu_bonds",
        region: "hu",
        importance: 2,
        title: "Új lakossági állampapír-sorozat",
        summary: "Összevethető a meglévő FixMÁP kamatával.",
        impact: "neutral",
        affects: ["FixMÁP"],
        sources: [{ title: "Példa Adósságkezelő", url: "https://example.com/akk" }],
      },
      {
        category: "macro",
        region: "eu",
        importance: 2,
        title: "Lassult az eurózóna inflációja",
        summary: "Az EKB kamatvágási esélyeit növeli.",
        impact: "mixed",
        affects: ["EUR/HUF"],
        sources: [{ title: "Példa Statisztika", url: "https://example.com/hicp" }],
      },
    ],
    upcoming: [
      { date: "2026-10-20", event: "Teszt kamatdöntés", why: "A forintot mozgathatja." },
      {
        date: "2026-10-15",
        event: "Teszt inflációs adat",
        why: "A PMÁP kamatát befolyásolja.",
        time: "14:30",
        followUp: true,
        kind: "US_CPI",
        expected: "3,0% é/é",
      },
      { date: "2026-10-14", event: "Teszt aukció", why: "A DKJ-hozamokat mutatja." },
      { date: "2026-10-16", event: "Teszt GDP-adat", why: "Háttér." },
    ],
  };
}

export function fixtureDigest(day = "2026-10-14", edition: NewsEdition = "evening"): NewsDigest {
  return {
    version: 1,
    day,
    edition,
    generatedAt: "2026-10-14T16:20:00.000Z",
    engine: "claude-code",
    model: "opus",
    costUsd: 0.42,
    ...fixtureNewsBody(),
  };
}

/** The followed announcements: one waiting, one done with its result (invented). */
export function fixtureEventsFile(): EventsFile {
  return {
    version: 1,
    results: [
      {
        key: "release|2026-10-14|14:30#0",
        phase: "release",
        date: "2026-10-14",
        time: "14:30",
        kind: "US_CPI",
        event: "Teszt amerikai infláció",
        actual: "3,2% é/é",
        expected: "3,0% é/é",
        surprise: "above",
        reaction: "A dollár erősödött, a hozamok emelkedtek.",
        outlook: "Kisebb az esély a kamatvágásra, ami a forintot gyengítheti.",
        impact: "mixed",
        affects: ["EUR/HUF"],
        sources: [{ title: "Példa Hírügynökség", url: "https://example.com/cpi" }],
        latencyMin: 4,
        generatedAt: "2026-10-14T12:40:00.000Z",
        engine: "claude-code",
        model: "opus",
      },
    ],
    subscriptions: [
      {
        key: "release|2026-10-20|14:00",
        phase: "release",
        date: "2026-10-20",
        time: "14:00",
        kind: "MNB_RATE",
        events: [{ event: "Teszt kamatdöntés", expected: "6,50%" }],
        status: "waiting",
        expectedRunAt: "2026-10-20T13:00:00.000Z",
        tries: 0,
      },
    ],
    latency: { US_CPI: { samples: 4, delayMin: 7 } },
  };
}
