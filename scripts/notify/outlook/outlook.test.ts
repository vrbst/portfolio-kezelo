import { describe, expect, it } from "vitest";
import { classifyForOutlook } from "./profile";
import { impliedBand, normCdf, pickExpiry } from "./implied";
import { classifyAiFailure, isoWeekKey, recordAttempt, shouldRunOutlookAi } from "./aiState";

describe("classifyForOutlook", () => {
  const c = (name: string, type: "etf" | "stock" | "fund" | "gov_bond" | "tbill" | "cash", f?: { quoteType?: string }) =>
    classifyForOutlook({ name, type }, f);

  it("a single stock is an equity", () => {
    expect(c("Példa Bank Nyrt.", "stock")).toEqual({ assetClass: "equity" });
    expect(c("Példa Bank Nyrt.", "etf", { quoteType: "EQUITY" })).toEqual({ assetClass: "equity" });
  });

  it("a physical bitcoin / ether product is crypto with its underlying", () => {
    expect(c("Példa Physical Bitcoin ETP", "etf")).toEqual({ assetClass: "crypto", underlying: "BTC" });
    expect(c("Példa Staked Ethereum ETP", "etf")).toEqual({ assetClass: "crypto", underlying: "ETH" });
  });

  it("gold, bond and equity funds", () => {
    expect(c("Példa Physical Gold ETC", "etf")).toEqual({ assetClass: "commodity", underlying: "XAU" });
    expect(c("Példa Global Aggregate Bond UCITS ETF", "etf")).toEqual({ assetClass: "bond_fund" });
    expect(c("Példa FTSE All-World UCITS ETF", "etf")).toEqual({ assetClass: "equity_fund" });
  });

  it("government bonds, T-bills and cash are not looked at; unknown stays undecided", () => {
    expect(c("MÁP Plusz 2031/J", "gov_bond")).toBeNull();
    expect(c("DKJ", "tbill")).toBeNull();
    expect(c("Készpénz", "cash")).toBeNull();
    expect(classifyForOutlook({ name: "Valami", type: "fund" as never }, null)).toEqual({ assetClass: "equity_fund" });
  });
});

describe("normCdf", () => {
  it("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.2815515655)).toBeCloseTo(0.9, 5);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 4);
  });
});

describe("impliedBand", () => {
  const nowMs = new Date(2026, 9, 13, 12).getTime();
  const yearMs = 365 * 86_400_000;

  it("lognormal quantiles around the forward", () => {
    const b = impliedBand({ underlying: "BTC", spot: 100, forward: 100, iv: 0.5, expiryMs: nowMs + yearMs, nowMs })!;
    expect(b.horizonDays).toBe(365);
    expect(b.p50).toBeCloseTo(88.25, 1);
    expect(b.p10).toBeCloseTo(46.5, 1);
    expect(b.p90).toBeCloseTo(167.5, 0);
    expect(b.probUp).toBeCloseTo(0.4013, 3);
    expect(b.p10).toBeLessThan(b.p50);
    expect(b.p50).toBeLessThan(b.p90);
  });

  it("a forward above spot makes a rise more likely", () => {
    const flat = impliedBand({ underlying: "BTC", spot: 100, forward: 100, iv: 0.5, expiryMs: nowMs + yearMs, nowMs })!;
    const up = impliedBand({ underlying: "BTC", spot: 100, forward: 110, iv: 0.5, expiryMs: nowMs + yearMs, nowMs })!;
    expect(up.probUp).toBeGreaterThan(flat.probUp);
  });

  it("a shorter horizon is a narrower band", () => {
    const short = impliedBand({ underlying: "BTC", spot: 100, forward: 100, iv: 0.5, expiryMs: nowMs + yearMs / 4, nowMs })!;
    const long = impliedBand({ underlying: "BTC", spot: 100, forward: 100, iv: 0.5, expiryMs: nowMs + yearMs, nowMs })!;
    expect(short.p90 - short.p10).toBeLessThan(long.p90 - long.p10);
  });

  it("refuses nonsense inputs and gives a local-day expiry", () => {
    const base = { underlying: "BTC", spot: 100, forward: 100, iv: 0.5, expiryMs: nowMs + yearMs, nowMs };
    expect(impliedBand({ ...base, iv: 0 })).toBeNull();
    expect(impliedBand({ ...base, forward: -1 })).toBeNull();
    expect(impliedBand({ ...base, expiryMs: nowMs - 1 })).toBeNull();
    expect(impliedBand(base)!.expiry).toBe("2027-10-13");
    expect(impliedBand(base)!.asOf).toBe("2026-10-13");
  });
});

describe("pickExpiry", () => {
  const nowMs = new Date(2026, 9, 13, 12).getTime();
  const at = (days: number) => ({ expiryMs: nowMs + days * 86_400_000, days });

  it("takes the expiry closest to the horizon, skipping past and same-day ones", () => {
    const list = [at(-5), at(0.2), at(30), at(80), at(120), at(400)];
    expect(pickExpiry(list, nowMs, 90)?.days).toBe(80);
    expect(pickExpiry(list, nowMs, 365)?.days).toBe(400);
  });

  it("is null when nothing is in the future", () => {
    expect(pickExpiry([at(-1)], nowMs, 90)).toBeNull();
  });
});

describe("weekly AI schedule", () => {
  const sat0430 = new Date(2026, 9, 17, 4, 30);
  const sat0815 = new Date(2026, 9, 17, 8, 15);
  const sun = new Date(2026, 9, 18, 9, 0);
  const nextSat = new Date(2026, 9, 24, 4, 30);

  it("Saturday and Sunday are the same ISO week, the next Saturday is not", () => {
    expect(isoWeekKey(sat0430)).toBe("2026-W42");
    expect(isoWeekKey(sun)).toBe("2026-W42");
    expect(isoWeekKey(nextSat)).toBe("2026-W43");
  });

  it("ISO week at the year boundary", () => {
    expect(isoWeekKey(new Date(2026, 11, 31))).toBe("2026-W53");
    expect(isoWeekKey(new Date(2027, 0, 1))).toBe("2026-W53");
    expect(isoWeekKey(new Date(2027, 0, 4))).toBe("2027-W01");
  });

  it("a successful 04:30 run makes the 08:15 retry a no-op", () => {
    const state = recordAttempt(null, sat0430, { ok: true });
    expect(shouldRunOutlookAi(state, sat0815)).toBe(false);
    expect(shouldRunOutlookAi(state, sun)).toBe(false);
  });

  it("a usage-limit failure at 04:30 lets the retry run, and keeps the old success", () => {
    const ok = recordAttempt(null, new Date(2026, 9, 10, 4, 30), { ok: true });
    const failed = recordAttempt(ok, sat0430, { ok: false, message: "Claude usage limit reached. Your limit will reset at 8am" });
    expect(failed.lastAttempt).toMatchObject({ ok: false, reason: "limit" });
    expect(failed.lastSuccessWeek).toBe("2026-W41");
    expect(shouldRunOutlookAi(failed, sat0815)).toBe(true);
  });

  it("Saturday off: Sunday catch-up runs; next week it runs again", () => {
    expect(shouldRunOutlookAi(null, sun)).toBe(true);
    const state = recordAttempt(null, sun, { ok: true });
    expect(shouldRunOutlookAi(state, nextSat)).toBe(true);
  });

  it("tells a limit from an ordinary error", () => {
    expect(classifyAiFailure("5-hour limit reached ∙ resets 8am")).toBe("limit");
    expect(classifyAiFailure("HTTP 429")).toBe("limit");
    expect(classifyAiFailure("a válasz nem érvényes JSON")).toBe("error");
  });
});
