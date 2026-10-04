import { describe, expect, it, vi } from "vitest";
import {
  fetchLiveFx,
  fxMarketOpen,
  lastSessionLabel,
  lastTradeTime,
  quotedToday,
} from "./prices";

// Local times throughout, so the assertions hold in every test time zone.

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
