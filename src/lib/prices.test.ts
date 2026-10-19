import { describe, expect, it, vi } from "vitest";
import {
  altCandidates,
  fetchLiveFx,
  fetchLivePrices,
  offHoursKind,
  mergeOffHoursBars,
  pickOffHours,
  fxMarketOpen,
  intradaySwing,
  isCurveLive,
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

  it("prefers a listing with intraday bars over a fresher one without", () => {
    const bars = [171, 171.1, 171.2];
    const picked = pickOffHours(primary, [alt({ exchange: "daily", marketTime: today(9, 5) }), alt({ exchange: "bars", intraday: bars })], "EUR");
    expect(picked?.exchange).toBe("bars");
  });

  it("prefers the most recent trade", () => {
    const picked = pickOffHours(primary, [alt({ exchange: "A" }), alt({ exchange: "B", marketTime: today(9, 5) })], "EUR");
    expect(picked?.exchange).toBe("B");
  });

  const chart = (price: number, exchange: string, tradeAt: number, currency = "EUR", session?: [number, number], bars = 0) => ({
    chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: Math.floor(tradeAt / 1000), currency, previousClose: 170.94, fullExchangeName: exchange, gmtoffset: 7200, ...(session && { currentTradingPeriod: { regular: { start: Math.floor(session[0] / 1000), end: Math.floor(session[1] / 1000) } } }) }, timestamp: Array.from({ length: bars }, (_, i) => Math.floor(tradeAt / 1000) - (bars - 1 - i) * 300), indicators: { quote: [{ close: Array.from({ length: bars }, () => price) }] } }] },
  });
  const load = async (at: Date, isin = "IE00PRE0000X", primary?: ReturnType<typeof chart>, altAt = today(8, 52), altPrice = 171.16, altBars = 4, calls: string[] = []) => {
    vi.stubGlobal("fetch", async (url: string) => {
      const target = new URL(url).searchParams.get("url")!;
      calls.push(target);
      if (target.includes("/search")) return { ok: true, json: async () => ({ quotes: [{ symbol: "AAA.DE", quoteType: "ETF" }] }) };
      if (!target.includes("AAA.DE") && !target.includes("AAA.MU")) return { ok: false, json: async () => ({}) };
      const json = target.includes("AAA.DE") ? (primary ?? chart(170.94, "XETRA", at.getTime() - 20 * 3_600_000)) : chart(altPrice, "Munich", altAt, "EUR", undefined, altBars);
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

  it("a venue without enough bars changes nothing: price and chart stay the primary's", async () => {
    const q = await load(now, "IE00NOBARS0X", undefined, today(8, 52), 171.16, 1);
    expect(q.offHours).toBeUndefined();
    expect(q.price).toBe(170.94);
  });

  it("the cross-check is reused for a few minutes instead of refetching every poll", async () => {
    const calls: string[] = [];
    await load(now, "IE00CACHE00X", undefined, today(8, 52), 171.16, 4, calls);
    const first = calls.length;
    // a second refresh 1 minute later, same ISIN: the alternatives come from the cache
    const calls2: string[] = [];
    await load(new Date(now.getTime() + 60_000), "IE00CACHE00X", undefined, today(8, 52), 171.16, 4, calls2);
    expect(first).toBeGreaterThan(2);
    expect(calls2.filter((c) => c.includes("AAA.MU") || c.includes("/search"))).toHaveLength(0);
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

describe("isCurveLive: off-hours venue", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 19, h, m).getTime();
  const q = {
    price: 170,
    session: { start: at(9, 0), end: at(17, 30) },
    intraday: [170, 170.2],
    intradayT: [at(8, 15), at(8, 20)],
    marketTime: at(8, 24),
    offHours: { exchange: "Hamburg", kind: "pre" as const },
  };
  it("a fresh trade on another venue before the open counts as live", () => {
    expect(isCurveLive(q, at(8, 40))).toBe(true);
  });
  it("a stale one (last trade long ago) does not", () => {
    expect(isCurveLive(q, at(9, 0) - 1)).toBe(false);
    expect(isCurveLive({ ...q, marketTime: at(7, 0) }, at(8, 40))).toBe(false);
  });
  it("without an off-hours venue the closed market is still not live", () => {
    expect(isCurveLive({ ...q, offHours: undefined }, at(8, 40))).toBe(false);
  });
});

describe("mergeOffHoursBars", () => {
  const BAR = 5 * 60_000;
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
  const bars = (d: number, from: [number, number], n: number, v: (i: number) => number) => ({
    t: Array.from({ length: n }, (_, i) => at(d, from[0], from[1]) + i * BAR),
    v: Array.from({ length: n }, (_, i) => v(i)),
  });

  it("after the close: the primary's bars, then the other venue's, on one grid", () => {
    const xetra = bars(16, [9, 0], 4, () => 170); // 9:00–9:15
    const mu = bars(16, [8, 50], 8, () => 171); // 8:50–9:25
    const primary = { price: 170, intraday: xetra.v, intradayT: xetra.t, prevDay: [169, 169.5], prevDayT: [1, 2], session: { start: at(16, 9, 0), end: at(16, 17, 30) } };
    const alt = { price: 171, intraday: mu.v, intradayT: mu.t, session: { start: at(16, 8, 0), end: at(16, 22, 0) } };
    const m = mergeOffHoursBars(primary, alt)!;
    expect(m.intradayT![0]).toBe(at(16, 8, 50));
    expect(m.intraday!.slice(0, 2)).toEqual([171, 171]); // before the primary: the other venue
    expect(m.intraday!.slice(2, 6)).toEqual([170, 170, 170, 170]); // the primary where it traded
    expect(m.intraday!.slice(6)).toEqual([171, 171]); // after: the other venue
    expect(m.intradayT!.every((t, i) => i === 0 || t - m.intradayT![i - 1] === BAR)).toBe(true);
    expect(m.prevDay).toBeUndefined(); // the primary's own previous day stays
    expect(m.chartSession).toEqual({ start: at(16, 8, 50), end: at(16, 22, 0) });
  });

  it("before the open: the other venue's bars are today, the primary's last session is the previous day", () => {
    const xetra = bars(15, [9, 0], 3, () => 170); // yesterday's session
    const mu = bars(16, [8, 0], 4, () => 171);
    const primary = { price: 170, intraday: xetra.v, intradayT: xetra.t, prevDay: [1, 2], prevDayT: [1, 2], session: { start: at(16, 9, 0), end: at(16, 17, 30) } };
    const alt = { price: 171, intraday: mu.v, intradayT: mu.t, session: { start: at(16, 8, 0), end: at(16, 22, 0) } };
    const m = mergeOffHoursBars(primary, alt)!;
    expect(m.intraday).toEqual([171, 171, 171, 171]);
    expect(m.prevDay).toEqual(xetra.v);
    expect(m.prevDayT).toEqual(xetra.t);
    expect(m.chartSession!.end).toBe(at(16, 22, 0));
  });

  it("the empty slots between two trades of a thin venue are on a straight line", () => {
    const mu = { t: [at(16, 8, 0), at(16, 8, 20)], v: [170, 172] }; // 3 empty slots → 170.5, 171, 171.5
    const alt = { price: 172, intraday: mu.v, intradayT: mu.t, session: { start: at(16, 8, 0), end: at(16, 22, 0) } };
    const m = mergeOffHoursBars({ price: 170 }, alt)!;
    expect(m.intraday).toEqual([170, 170.5, 171, 171.5, 172]);
    expect(mergeOffHoursBars({ price: 170 }, alt, false)!.intraday).toEqual([170, 170, 170, 170, 172]);
  });

  it("a venue with a single 5-minute slot so far (two trades in one bucket) still gives a chart", () => {
    const t1 = at(19, 8, 5);
    const alt = { price: 171, intraday: [171.2, 171.1], intradayT: [t1 + 1000, t1 + 18_000], session: { start: at(19, 8, 0), end: at(19, 22, 0) } };
    const m = mergeOffHoursBars({ price: 170, intraday: [170, 170], intradayT: [at(16, 17, 25), at(16, 17, 30)] }, alt)!;
    expect(m.intraday).toEqual([171.1, 171.1]); // the one slot, held one bar back
    expect(m.intradayT).toEqual([t1 - BAR, t1]);
  });

  it("no bars on the other venue: nothing to merge", () => {
    expect(mergeOffHoursBars({ price: 1 }, { price: 1 })).toBeUndefined();
  });
});

describe("offHoursKind", () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
  it("post: the other venue traded on the primary's last trading day", () => {
    expect(offHoursKind(at(16, 17, 35), at(16, 20), at(16, 21), at(16, 17, 30))).toBe("post");
    expect(offHoursKind(at(16, 17, 35), at(16, 20), at(17, 11), at(17, 17, 30))).toBe("post"); // weekend
  });
  it("pre: today, the primary still to open", () => {
    expect(offHoursKind(at(15, 17, 35), at(16, 8, 52), at(16, 9, 11), at(16, 17, 30))).toBe("pre");
  });
  it("closed: the primary was silent all day (holiday evening)", () => {
    expect(offHoursKind(at(15, 17, 35), at(16, 20), at(16, 21), at(16, 17, 30))).toBe("closed");
  });
});

describe("mergeOffHoursBars: the primary's own holes", () => {
  const BAR = 5 * 60_000;
  const at = (h: number, m: number) => new Date(2026, 9, 16, h, m).getTime();
  it("a hole inside the primary's bars is held, the venue's gap is a straight line", () => {
    const primary = { price: 170, intraday: [170, 174], intradayT: [at(9, 0), at(9, 20)], session: { start: at(9, 0), end: at(17, 30) } };
    const alt = { price: 171, intraday: [172, 176], intradayT: [at(17, 40), at(18, 0)] };
    const m = mergeOffHoursBars(primary, alt)!;
    expect(m.intraday!.slice(0, 5)).toEqual([170, 170, 170, 170, 174]); // held: no invented trades
    const i = m.intradayT!.indexOf(at(17, 40));
    expect(m.intraday!.slice(i, i + 5)).toEqual([172, 173, 174, 175, 176]); // interpolated
    expect(BAR).toBe(300_000);
  });
});
