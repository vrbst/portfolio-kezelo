import { afterEach, describe, expect, it, vi } from "vitest";
import type { BondRatesFile, InterestPeriod } from "../../src/lib/bondRates";
import type { PortfolioSnapshot } from "../../src/lib/sync";
import { DKJ1, FIX } from "../../src/test/fixture";
import { bondNoticeMessages } from "./bondNotices";
import { contextAt } from "./testContext";
import { tickMessages } from "./tg-app";
import type { State } from "./state";

afterEach(() => vi.useRealTimers());

const env = { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 };
const fresh = (): State => ({ sentAlerts: {}, warned: {} });

type Clock = [number, number, number, number, number?];

const pmap = (rate: number, start: string, end: string): InterestPeriod => ({
  type: "PMÁP",
  series: "2030/I",
  rate,
  periodStart: start,
  periodEnd: end,
  paymentDate: end,
  maturity: "2030-03-15",
  currency: "HUF",
});

const rates = (over: Partial<BondRatesFile> = {}): Omit<BondRatesFile, "updatedAt"> & { updatedAt?: string } => ({
  retail: [
    { type: "FixMÁP", series: "2029/Q2", rateText: "5.50", rateMin: 5.5, rateMax: 5.5, ehm: 5.62, maturity: "2029-10-25", currency: "HUF", validFrom: "2026-10-01", validTo: null },
    { type: "MÁP Plusz", series: "2031/M6", rateText: "5.00 - 6.00", rateMin: 5, rateMax: 6, ehm: 5.47, maturity: "2031-11-27", currency: "HUF", validFrom: "2026-10-01", validTo: null },
    { type: "BABA", series: "2045/S_BABA", rateText: "7.40", rateMin: 7.4, rateMax: 7.4, ehm: null, maturity: "2045-02-01", currency: "HUF", validFrom: "2026-02-01", validTo: null },
  ],
  periods: [pmap(6.5, "2026-03-15", "2027-03-15")],
  dkj: [
    { auctionDate: "2025-11-18", series: "D261118", isin: DKJ1, maturity: "2026-11-18", avgYield: 4.1 },
    { auctionDate: "2026-10-07", series: "D270428", isin: "HU0000525282", maturity: "2027-04-28", avgYield: 5.15 },
  ],
  ...over,
});

const at = (clock: Clock, tweak?: (s: PortfolioSnapshot) => void, over: Partial<BondRatesFile> = {}) => {
  const [y, m, d] = clock;
  const file = { updatedAt: new Date(y, m - 1, d - 1, 18).toISOString(), ...rates(over) };
  return contextAt(clock, tweak, file);
};

const asPmap = (s: PortfolioSnapshot) => {
  s.instruments.find((i) => i.key === FIX)!.name = "Prémium Magyar Állampapír 2030/I";
};

describe("maturity notices", () => {
  it("nothing yet 35 days before the DKJ matures", () => {
    expect(bondNoticeMessages(at([2026, 10, 14, 10]), fresh())).toEqual([]);
  });

  it("30 days before: once, with what can be bought now", () => {
    const st = fresh();
    const [m, ...rest] = bondNoticeMessages(at([2026, 10, 20, 10]), st);
    expect(rest).toEqual([]);
    expect(m).toContain("Lejár 29 nap múlva: DKJ D261118");
    expect(m).toContain("2026. nov. 18.");
    expect(m).toContain("A sorozat legutóbbi aukciós átlaghozama: 4,10%");
    expect(m).toContain("• FixMÁP 2029/Q2: 5,50% (EHM 5,62%), lejár 2029. okt. 25.");
    expect(m).toContain("• MÁP Plusz 2031/M6: 5,00%–6,00% (EHM 5,47%)");
    expect(m).toContain("• DKJ D270428: 5,15% (aukció okt. 7., lejár 2027. ápr. 28.)");
    expect(m).not.toContain("BABA");
    expect(bondNoticeMessages(at([2026, 10, 21, 10]), st)).toEqual([]);
  });

  it("7 days before: once more", () => {
    const st = fresh();
    bondNoticeMessages(at([2026, 10, 20, 10]), st);
    const [m] = bondNoticeMessages(at([2026, 11, 12, 10]), st);
    expect(m).toContain("Lejár 6 nap múlva: DKJ D261118");
    expect(bondNoticeMessages(at([2026, 11, 13, 10]), st)).toEqual([]);
  });

  it("first seen inside 7 days: one notice, not two", () => {
    const st = fresh();
    const ms = bondNoticeMessages(at([2026, 11, 16, 10]), st);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toContain("Lejár 2 nap múlva");
    expect(bondNoticeMessages(at([2026, 11, 17, 10]), st)).toEqual([]);
  });

  it("no notice without the rate file", () => {
    expect(bondNoticeMessages(contextAt([2026, 10, 20, 10]), fresh())).toEqual([]);
  });
});

describe("new interest period", () => {
  it("the first sighting is only remembered, a later period is announced once", () => {
    const st = fresh();
    expect(bondNoticeMessages(at([2026, 10, 14, 10], asPmap), st)).toEqual([]);
    expect(st.bondNotices?.periods?.[FIX]).toEqual({ start: "2026-03-15", rate: 6.5 });
    const next = { periods: [pmap(7.25, "2027-03-15", "2028-03-15")] };
    const [m] = bondNoticeMessages(at([2027, 3, 16, 10], asPmap, next), st);
    expect(m).toContain("PMÁP 2030/I: új kamatperiódus");
    expect(m).toContain("6,50% → <b>7,25%</b>");
    expect(m).toContain("következő kamatfizetés: 2028. márc. 15.");
    expect(bondNoticeMessages(at([2027, 3, 17, 10], asPmap, next), st)).toEqual([]);
  });

  it("a FixMÁP's quarterly periods are not announced", () => {
    const st = fresh();
    const fixPeriods = { periods: [{ ...pmap(6.5, "2026-09-15", "2026-12-15"), type: "FixMÁP" }] };
    bondNoticeMessages(at([2026, 10, 14, 10], undefined, fixPeriods), st);
    expect(st.bondNotices?.periods ?? {}).toEqual({});
  });
});

describe("stale rate file", () => {
  it("warns once a week while the file is older than 7 days", () => {
    const st = fresh();
    const old = { updatedAt: new Date(2026, 9, 1, 18).toISOString() };
    const [m] = bondNoticeMessages(at([2026, 10, 14, 10], undefined, old), st);
    expect(m).toContain("állampapír-kamatfájl 7+ napja nem frissült");
    expect(bondNoticeMessages(at([2026, 10, 15, 10], undefined, old), st)).toEqual([]);
    bondNoticeMessages(at([2026, 10, 16, 10]), st);
    expect(st.warned.bondRates).toBeUndefined();
  });
});

describe("tick", () => {
  it("sends the maturity notice once through the tick", () => {
    const st = fresh();
    const first = tickMessages(at([2026, 10, 20, 10]), st, env);
    expect(first.filter((m) => m.html.includes("Lejár 29 nap múlva"))).toHaveLength(1);
    const again = tickMessages(at([2026, 10, 20, 10, 5]), st, env);
    expect(again.filter((m) => m.html.includes("Lejár"))).toEqual([]);
  });
});

describe("switch suggestions", () => {
  const better = {
    retail: [
      ...rates().retail,
      { type: "FixMÁP", series: "2031/T", rateText: "7.60", rateMin: 7.6, rateMax: 7.6, ehm: 7.75, maturity: "2031-09-20", currency: "HUF", validFrom: "2026-10-01", validTo: null },
    ],
  };
  const isSwitch = (m: string) => m.includes("Csere-lehetőség");

  it("no suggestion while nothing pays more than the held bond", () => {
    expect(bondNoticeMessages(at([2026, 10, 14, 10]), fresh()).filter(isSwitch)).toEqual([]);
  });

  it("a better buyable bond is suggested once, with fee, payback and gain", () => {
    const st = fresh();
    const ms = bondNoticeMessages(at([2026, 10, 14, 10], undefined, better), st).filter(isSwitch);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toContain("Csere-lehetőség: FixMÁP 2030/I");
    expect(ms[0]).toContain("6,50% → <b>FixMÁP 2031/T: 7,75%</b>, lejár 2031. szept. 20.");
    expect(ms[0]).toMatch(/A visszaváltási díj \(.+ Ft\) \d+ hónap alatt térül meg; \d+,\d év alatt kb\. \+.+ Ft\./);
    expect(st.bondNotices?.switches).toEqual({ [`${FIX}|FixMÁP 2031/T`]: "2026-10-14" });
    expect(bondNoticeMessages(at([2026, 10, 15, 10], undefined, better), st).filter(isSwitch)).toEqual([]);
  });

  it("reminds again after 90 days if it still pays", () => {
    const st = fresh();
    bondNoticeMessages(at([2026, 10, 14, 10], undefined, better), st);
    expect(bondNoticeMessages(at([2027, 1, 11, 10], undefined, better), st).filter(isSwitch)).toEqual([]);
    expect(bondNoticeMessages(at([2027, 1, 12, 10], undefined, better), st).filter(isSwitch)).toHaveLength(1);
  });

  it("forgets the suggestion once the bond is sold", () => {
    const st = fresh();
    bondNoticeMessages(at([2026, 10, 14, 10], undefined, better), st);
    const sold = (s: PortfolioSnapshot) => {
      s.transactions = s.transactions.filter((t) => t.instrumentKey !== FIX);
    };
    bondNoticeMessages(at([2026, 10, 15, 10], sold, better), st);
    expect(st.bondNotices?.switches).toEqual({});
  });

  it("a new interest period carries the suggestion instead of a separate message", () => {
    const st = fresh();
    bondNoticeMessages(at([2026, 10, 14, 10], asPmap), st);
    const next = { ...better, periods: [pmap(5.25, "2027-03-15", "2028-03-15")] };
    const ms = bondNoticeMessages(at([2027, 3, 16, 10], asPmap, next), st);
    expect(ms.filter(isSwitch)).toEqual([]);
    const [m] = ms.filter((x) => x.includes("új kamatperiódus"));
    expect(m).toContain("6,50% → <b>5,25%</b>");
    expect(m).toContain("💡 Csere-jelölt: 5,25% → <b>FixMÁP 2031/T: 7,75%</b>");
  });

  it("the maturity notice names the best yield now", () => {
    const [m] = bondNoticeMessages(at([2026, 10, 20, 10]), fresh());
    expect(m).toContain("Legmagasabb hozam most: FixMÁP 2029/Q2 (5,62%)");
  });
});
