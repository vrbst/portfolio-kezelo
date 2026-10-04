import { describe, expect, it } from "vitest";
import { lastSessionLabel, lastTradeTime, quotedToday } from "./prices";

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
