import { describe, expect, it, vi } from "vitest";
import {
  altCandidates,
  fetchLiveFx,
  fetchLivePrices,
  pickOffHours,
  fxMarketOpen,
  intradaySwing,
  lastSessionLabel,
  lastTradeTime,
  quotedToday,
} from "./prices";

// Local times throughout, so the assertions hold in every test time zone.

describe("intradaySwing", () => {
  const now = new Date(2026, 9, 14, 15, 0);
  const bars = [100, 94, 97];
  const t = bars.map((_, i) => new Date(2026, 9, 14, 9, i * 5).getTime());
  const quote = { price: 97, prevClose: 100, intraday: bars, intradayT: t };

  it("the rise from the low and the fall from the high, as fractions", () => {
    const sw = intradaySwing(quote, now)!;
    expect(sw.up).toBeCloseTo(97 / 94 - 1, 6);
    expect(sw.down).toBeCloseTo(97 / 100 - 1, 6);
  });

  it("the live price counts as a bar", () => {
    const sw = intradaySwing({ ...quote, price: 90 }, now)!;
    expect(sw.up).toBe(0);
    expect(sw.down).toBeCloseTo(-0.1, 6);
  });

  it("no evidence: a borrowed, a yesterday's or a missing curve", () => {
    expect(intradaySwing({ ...quote, intradayFrom: "BTC-USD" }, now)).toBeUndefined();
    expect(intradaySwing(quote, new Date(2026, 9, 15, 9, 0))).toBeUndefined();
    expect(intradaySwing({ price: 97 }, now)).toBeUndefined();
    expect(intradaySwing(undefined, now)).toBeUndefined();
  });
});

describe("quotedToday", () => {
  // Friday 2026-10-02, Xetra close; Saturday the 3rd; Monday the 5th.
  const fridayClose = new Date(2026, 9, 2, 17, 35).getTime();
  const quote = { price: 171.14, prevClose: 169.38, marketTime: fridayClose };

  it("a quote from the same local day is today's", () => {
    expect(quotedToday(quote, new Date(2026, 9, 2, 20, 0))).toBe(true);
  });

  it("the weekend and Monday before the open replay Friday's move", () => {
    expect(quotedToday(quote, new Date(2026, 9, 3, 9, 0))).toBe(false);
    expect(quotedToday(quote, new Date(2026, 9, 4, 18, 0))).toBe(false);
    expect(quotedToday(quote, new Date(2026, 9, 5, 7, 30))).toBe(false);
  });

  it("no known trade time counts as today; no quote does not", () => {
    expect(quotedToday({ price: 400 }, new Date(2026, 9, 3))).toBe(true);
    expect(quotedToday(undefined, new Date(2026, 9, 3))).toBe(false);
  });
});

describe("lastSessionLabel", () => {
  const fri = new Date(2026, 9, 2, 17, 35).getTime(); // Fri, local
  it("names the last session's day when the quote did not trade today", () => {
    expect(lastSessionLabel({ price: 1, prevClose: 1, marketTime: fri }, new Date(2026, 9, 4, 12))).toBe("péntek");
  });
  it("is undefined for today's move or an unknown trade time", () => {
    expect(lastSessionLabel({ price: 1, marketTime: fri }, new Date(2026, 9, 2, 20))).toBeUndefined();
    expect(lastSessionLabel({ price: 1 }, new Date(2026, 9, 4, 12))).toBeUndefined();
  });
  it("an older quote shows its date", () => {
    expect(lastSessionLabel({ price: 1, marketTime: fri }, new Date(2026, 9, 20, 12))).toBe("2026-10-02");
  });
});

describe("lastTradeTime", () => {
  const friLastBar = Date.UTC(2026, 9, 2, 22, 55); // Fri 22:55 UTC
  const sunNow = Date.UTC(2026, 9, 4, 21, 59, 50); // what Yahoo reports for EURHUF=X on Sunday

  it("a currency pair's 'now' market time on a weekend is capped by its last bar (Friday)", () => {
    const t = lastTradeTime(sunNow, friLastBar);
    expect(t).toBe(friLastBar + 5 * 60 * 1000);
    expect(quotedToday({ price: 368.13, prevClose: 368.36, marketTime: t }, new Date(2026, 9, 4, 23, 59))).toBe(false);
  });

  it("keeps the market time when it is within the last bar", () => {
    expect(lastTradeTime(friLastBar + 60_000, friLastBar)).toBe(friLastBar + 60_000);
  });

  it("falls back to whichever is known", () => {
    expect(lastTradeTime(undefined, friLastBar)).toBe(friLastBar + 5 * 60 * 1000);
    expect(lastTradeTime(sunNow, undefined)).toBe(sunNow);
  });
});

describe("fxMarketOpen", () => {
  it("is open from Sunday 17:00 to Friday 17:00 New York time", () => {
    expect(fxMarketOpen(Date.UTC(2026, 9, 4, 20, 59))).toBe(false); // Sun 16:59 NY
    expect(fxMarketOpen(Date.UTC(2026, 9, 4, 21, 1))).toBe(true); // Sun 17:01 NY
    expect(fxMarketOpen(Date.UTC(2026, 9, 7, 12))).toBe(true); // Wed
    expect(fxMarketOpen(Date.UTC(2026, 9, 2, 20, 59))).toBe(true); // Fri 16:59 NY
    expect(fxMarketOpen(Date.UTC(2026, 9, 2, 21, 1))).toBe(false); // Fri 17:01 NY
    expect(fxMarketOpen(Date.UTC(2026, 9, 3, 12))).toBe(false); // Sat
  });
});

describe("fetchLiveFx after the Sunday-evening reopen", () => {
  // EURHUF=X as Yahoo served it on Monday 2026-10-05 00:34 Budapest: the
  // price is a fresh tick, the latest 5-minute bars are still Friday's.
  const friBars = [21, 21.0833, 21.1667, 21.25, 21.3333, 21.4167].map((h) =>
    Math.round(Date.UTC(2026, 9, 2, 0, 0) / 1000 + h * 3600),
  );
  const yahoo = (regularMarketTime: number) => ({
    chart: {
      result: [
        {
          meta: {
            instrumentType: "CURRENCY",
            regularMarketPrice: 368.25,
            regularMarketTime,
            previousClose: 368.36,
            gmtoffset: 3600,
          },
          timestamp: friBars,
          indicators: { quote: [{ close: [368.2, 368.15, 368.1, 368.12, 368.13, 368.12] }] },
        },
      ],
    },
  });
  const load = async (now: Date) => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => yahoo(Math.floor(now.getTime() / 1000)) }));
    try {
      return (await fetchLiveFx()).EUR;
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("Monday's live rate is today's move, measured from Friday's last bar", async () => {
    const now = new Date(2026, 9, 5, 0, 34);
    const eur = await load(now);
    expect(quotedToday(eur, now)).toBe(true);
    expect(lastSessionLabel(eur, now)).toBeUndefined();
    expect(eur.prevClose).toBe(368.12);
    expect(eur.intraday).toBeUndefined();
    expect(eur.prevDay).toHaveLength(6);
  });

  it("on Saturday the market is closed: still Friday's move", async () => {
    const now = new Date(2026, 9, 3, 12, 0);
    const eur = await load(now);
    expect(quotedToday(eur, now)).toBe(false);
    expect(eur.prevClose).toBe(368.36);
  });
});

describe("off-hours stand-in listing", () => {
  const now = new Date(2026, 9, 16, 9, 11); // Friday, Xetra open but no trade yet
  const today = (h: number, m: number) => new Date(2026, 9, 16, h, m).getTime();
  const primary = { price: 170.94, prevClose: 170.94, marketTime: today(0, 0) - 3_600_000 };
  const alt = (o: object) => ({ price: 171.16, currency: "EUR", marketTime: today(8, 52), exchange: "Munich", ...o });

  it("takes the same-currency listing that traded today", () => {
    expect(pickOffHours(primary, [alt({})], "EUR")?.exchange).toBe("Munich");
  });

  it("rejects other currencies, stale trades and off-scale prices", () => {
    expect(pickOffHours(primary, [alt({ currency: "HUF" })], "EUR")).toBeUndefined();
    expect(pickOffHours(primary, [alt({ marketTime: today(0, 0) - 3_600_000 })], "EUR")).toBeUndefined();
    expect(pickOffHours(primary, [alt({ price: 100.86 })], "EUR")).toBeUndefined();
  });

  it("prefers the most recent trade", () => {
    const picked = pickOffHours(primary, [alt({ exchange: "A" }), alt({ exchange: "B", marketTime: today(9, 5) })], "EUR");
    expect(picked?.exchange).toBe("B");
  });

  const chart = (price: number, exchange: string, tradeAt: number, currency = "EUR", session?: [number, number]) => ({
    chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: Math.floor(tradeAt / 1000), currency, previousClose: 170.94, fullExchangeName: exchange, gmtoffset: 7200, ...(session && { currentTradingPeriod: { regular: { start: Math.floor(session[0] / 1000), end: Math.floor(session[1] / 1000) } } }) }, timestamp: [], indicators: { quote: [{ close: [] }] } }] },
  });
  const load = async (at: Date, isin = "IE00PRE0000X", primary?: ReturnType<typeof chart>, altAt = today(8, 52), altPrice = 171.16) => {
    vi.stubGlobal("fetch", async (url: string) => {
      const target = new URL(url).searchParams.get("url")!;
      if (target.includes("/search")) return { ok: true, json: async () => ({ quotes: [{ symbol: "AAA.DE", quoteType: "ETF" }] }) };
      if (!target.includes("AAA.DE") && !target.includes("AAA.MU")) return { ok: false, json: async () => ({}) };
      const json = target.includes("AAA.DE") ? (primary ?? chart(170.94, "XETRA", at.getTime() - 20 * 3_600_000)) : chart(altPrice, "Munich", altAt);
      return { ok: true, json: async () => json };
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    try {
      return (await fetchLivePrices([{ key: isin, isin, currency: "EUR" }]))[isin];
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  };

  it("fetchLivePrices uses the other listing's price, keeping the primary previous close", async () => {
    const q = await load(now);
    expect(q.price).toBe(171.16);
    expect(q.offHours?.exchange).toBe("Munich");
    expect(q.prevClose).toBe(170.94);
    expect(quotedToday(q, now)).toBe(true);
  });

  it("on the weekend Friday evening's venue price stays, still Friday's move", async () => {
    const sat = new Date(2026, 9, 17, 9, 11);
    const q = await load(sat, "IE00PRE0000Y", undefined, new Date(2026, 9, 16, 20, 0).getTime());
    expect(q.price).toBe(171.16);
    expect(q.offHours?.kind).toBe("post");
    expect(quotedToday(q, sat)).toBe(false);
  });

  it("after the primary close the later-trading listing's price is used", async () => {
    const at = new Date(2026, 9, 16, 18, 30);
    const xetra = chart(172, "XETRA", new Date(2026, 9, 16, 17, 35).getTime(), "EUR", [new Date(2026, 9, 16, 9, 0).getTime(), new Date(2026, 9, 16, 17, 30).getTime()]);
    const q = await load(at, "IE00POST000X", xetra, new Date(2026, 9, 16, 18, 20).getTime(), 172.4);
    expect(q.price).toBe(172.4);
    expect(q.offHours).toEqual({ exchange: "Munich", kind: "post" });
  });

  it("while the primary session runs, nothing is replaced", async () => {
    const at = new Date(2026, 9, 16, 12, 0);
    const xetra = chart(172, "XETRA", new Date(2026, 9, 16, 11, 58).getTime(), "EUR", [new Date(2026, 9, 16, 9, 0).getTime(), new Date(2026, 9, 16, 17, 30).getTime()]);
    const q = await load(at, "IE00MID0000X", xetra, new Date(2026, 9, 16, 11, 59).getTime(), 172.4);
    expect(q.offHours).toBeUndefined();
    expect(q.price).toBe(172);
  });

  it("siblings of the primary ticker are candidates even when the ISIN search misses them", () => {
    const c = altCandidates(["VWRA.L"], "VWCE.DE");
    expect(c).toContain("VWCE.MU");
    expect(c).toContain("VWCE.DU");
    expect(c).toContain("VWRA.L");
    expect(c).not.toContain("VWCE.DE");
    expect(altCandidates([], "BTC-EUR")).toEqual([]);
  });
});
