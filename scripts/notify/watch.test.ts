import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortfolioSnapshot } from "../../src/lib/sync";
import { local, VWCE } from "../../src/test/fixture";
import type { Context } from "./data";
import type { State } from "./state";
import { contextAt } from "./testContext";
import { runHandler, type Deps, type HubResponse } from "./tg-app";
import { goalMilestoneMessages, stalePriceMessage, wealthMessages } from "./watch";
import { ft } from "./reports";

let dir: string;
let stateFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-watch-"));
  stateFile = join(dir, "state.json");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const env = { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 };
const fresh = (): State => ({ sentAlerts: {}, warned: {} });
const WED: [number, number, number, number] = [2026, 10, 14, 10];

const base = { v: 1, id: "r1", app: "portfolio", now: "" };
const commandReq = (command: string, args = "") =>
  JSON.stringify({ ...base, type: "command", command, args, argv: args.split(" ").filter(Boolean), chat: { id: 1 }, message: { id: 1, date: "" } });
const tickReq = () =>
  JSON.stringify({ ...base, type: "job", job: "tick", scheduledFor: null, catchUp: false, manual: false, lastSuccessAt: null });
const call = async (input: string, deps: Deps): Promise<HubResponse> =>
  JSON.parse(await runHandler(input, deps)) as HubResponse;
const depsFor = (ctx: () => Context): Deps => ({ load: async () => ctx(), stateFile, env });
const readState = () => JSON.parse(readFileSync(stateFile, "utf8")) as State;
const html = (r: HubResponse) => (r.messages ?? []).map((m) => m.html);

describe("goal milestones", () => {
  it("the first sighting is silent; a crossed 25% step is sent once; 100% says the goal is full", () => {
    const st = fresh();
    const ctx = contextAt(WED);
    expect(goalMilestoneMessages(ctx, st)).toEqual([]);
    expect(st.goalLevels).toEqual({ "g-babavaro": 3, "g-auto": 0, "g-nyaralas": 2 });

    const goal = (id: string) => ctx.savings.find((p) => p.goal.id === id)!;
    goal("g-auto").progressPct = 0.3;
    expect(goalMilestoneMessages(ctx, st)).toEqual([expect.stringContaining("Autó: 25%-nál jár")]);
    expect(goalMilestoneMessages(ctx, st)).toEqual([]);

    goal("g-auto").progressPct = 0.1;
    expect(goalMilestoneMessages(ctx, st)).toEqual([]);
    goal("g-auto").progressPct = 0.3;
    expect(goalMilestoneMessages(ctx, st)).toEqual([]);

    goal("g-babavaro").progressPct = 1;
    expect(goalMilestoneMessages(ctx, st)).toEqual([expect.stringContaining("🏁 <b>Babakocsi: összegyűlt a teljes összeg</b>")]);
  });

  it("a deleted goal is forgotten", () => {
    const st: State = { ...fresh(), goalLevels: { "g-regi": 2 } };
    goalMilestoneMessages(contextAt(WED), st);
    expect(st.goalLevels).not.toHaveProperty("g-regi");
  });
});

describe("wealth: round amounts, drawdown from the peak", () => {
  it("first run silent, then each step and drawdown level once, and the recovery", () => {
    const st = fresh();
    const ctx = contextAt(WED);
    const s = ctx.summary;
    expect(wealthMessages(ctx, st, env)).toEqual([]);
    const peakPl = s.totalPlHuf;

    s.totalValueHuf = 12_050_000;
    expect(wealthMessages(ctx, st, env)).toEqual([expect.stringContaining(`Átlépted a ${ft(12_000_000)}-ot`)]);
    s.totalValueHuf = 11_950_000;
    expect(wealthMessages(ctx, st, env)).toEqual([]);
    s.totalValueHuf = 12_100_000;
    expect(wealthMessages(ctx, st, env)).toEqual([]);
    const peakValue = s.totalValueHuf;

    s.totalPlHuf = peakPl - 0.06 * peakValue;
    expect(wealthMessages(ctx, st, env)).toEqual([expect.stringContaining("Visszaesés a csúcstól: −6,0%")]);
    expect(wealthMessages(ctx, st, env)).toEqual([]);
    s.totalPlHuf = peakPl - 0.11 * peakValue;
    expect(wealthMessages(ctx, st, env)).toEqual([expect.stringContaining("Visszaesés a csúcstól: −11,0%")]);

    s.totalPlHuf = peakPl + 1;
    expect(wealthMessages(ctx, st, env)).toEqual([expect.stringContaining("Visszajött a visszaesés")]);
    s.totalPlHuf = peakPl - 0.03 * peakValue;
    expect(wealthMessages(ctx, st, env)).toEqual([]);
  });

  it("deposits raise the value, not the market result: no drawdown from a withdrawal", () => {
    const st = fresh();
    const ctx = contextAt(WED);
    wealthMessages(ctx, st, env);
    ctx.summary.totalValueHuf -= 3_000_000;
    expect(wealthMessages(ctx, st, env)).toEqual([]);
  });

  it("an unknown FX rate (absurd totals) is skipped", () => {
    const st = fresh();
    const ctx = contextAt(WED);
    ctx.summary.missingFxCcys = ["USD"];
    expect(wealthMessages(ctx, st, env)).toEqual([]);
    expect(st.wealth).toBeUndefined();
  });
});

describe("a held security without a fresh price", () => {
  const freshFile = (at: [number, number, number, number]) => {
    const ctx = contextAt(at);
    ctx.priceFile!.updatedAt = new Date(at[0], at[1] - 1, at[2] - 1, 18).toISOString();
    return ctx;
  };
  const stale = (at: [number, number, number, number] = WED) => {
    const ctx = freshFile(at);
    delete ctx.liveQuotes[VWCE];
    ctx.history!.prices[VWCE] = ctx.history!.prices[VWCE].filter(([d]) => d <= "2026-10-02");
    return ctx;
  };

  it("is reported once a week, and forgotten when the price is back", () => {
    const st = fresh();
    const text = stalePriceMessage(stale(), st);
    expect(text).toContain("❓ <b>Elavult árfolyam</b>");
    expect(text).toContain("VWCE: 12 napja nincs új ár (utolsó: 2026. okt. 2.");
    expect(stalePriceMessage(stale(), st)).toBeNull();
    expect(stalePriceMessage(stale([2026, 10, 21, 11]), st)).toContain("VWCE");

    expect(stalePriceMessage(freshFile([2026, 10, 22, 10]), st)).toBeNull();
    expect(Object.keys(st.warned)).toEqual([]);
  });

  it("a few days without a price (a long weekend) is not news", () => {
    const ctx = freshFile(WED);
    delete ctx.liveQuotes[VWCE];
    ctx.history!.prices[VWCE] = ctx.history!.prices[VWCE].filter(([d]) => d <= "2026-10-09");
    expect(stalePriceMessage(ctx, fresh())).toBeNull();
  });

  it("is left to the price-file warning when the whole file is old", () => {
    const ctx = stale();
    ctx.priceFile!.updatedAt = new Date(2026, 9, 5).toISOString();
    expect(stalePriceMessage(ctx, fresh())).toBeNull();
  });
});

describe("/riasztas", () => {
  it("sets, lists and deletes alerts", async () => {
    const deps = depsFor(() => contextAt(WED));
    expect(html(await call(commandReq("riasztas"), deps))[0]).toContain("Nincs beállított árriasztás");
    expect(html(await call(commandReq("riasztas", "VWCE 150 alatt"), deps))[0]).toBe(
      "🔔 Rendben: szólok, ha a(z) VWCE 150,00 EUR alá megy (most 176,76 EUR).",
    );
    await call(commandReq("riasztas", "EUR/HUF > 400"), deps);
    const list = html(await call(commandReq("riasztas"), deps))[0];
    expect(list).toContain("1. VWCE 150,00 EUR alá (most 176,76 EUR)");
    expect(list).toContain("2. EUR/HUF 400,00 fölé (most 394,42)");
    expect(html(await call(commandReq("riasztas", "torol 1"), deps))[0]).toContain("Töröltem: VWCE");
    expect(readState().priceAlerts!.map((a) => a.label)).toEqual(["EUR/HUF"]);
    await call(commandReq("riasztas", "torol mind"), deps);
    expect(readState().priceAlerts).toEqual([]);
  });

  it("refuses what it can't watch or what is already true", async () => {
    const deps = depsFor(() => contextAt(WED));
    expect(html(await call(commandReq("riasztas", "XYZ 5 alatt"), deps))[0]).toContain("Nem ismerem");
    expect(html(await call(commandReq("riasztas", "VWCE 200 alatt"), deps))[0]).toContain("már most is teljesül");
    expect(html(await call(commandReq("riasztas", "VWCE 200"), deps))[0]).toContain("Ezt nem értem");
    expect(html(await call(commandReq("riasztas", "Kincstárjegy 5 alatt"), deps))[0]).toContain("nincs árfolyama");
    expect(readState().priceAlerts).toEqual([]);
  });

  it("fires once on the tick and is removed", async () => {
    const at = () => {
      const ctx = contextAt(WED);
      ctx.prices.set(VWCE, 149.5);
      return ctx;
    };
    await call(commandReq("riasztas", "VWCE 150 alatt"), depsFor(() => contextAt(WED)));
    await call(commandReq("riasztas", "EUR 400 felett"), depsFor(() => contextAt(WED)));
    const r = await call(tickReq(), depsFor(at));
    expect(html(r)).toContainEqual(expect.stringContaining("🔔 <b>VWCE 150,00 EUR alá ment</b>: most 149,50 EUR"));
    expect(readState().priceAlerts!.map((a) => a.label)).toEqual(["EUR/HUF"]);
    expect(html(await call(tickReq(), depsFor(at)))).toEqual([]);
  });

  it("an alert set while the tick was loading survives the tick", async () => {
    const deps: Deps = {
      ...depsFor(() => contextAt(WED)),
      load: async () => {
        const ctx = contextAt(WED);
        await call(commandReq("riasztas", "WBIT 1 alatt"), depsFor(() => ctx));
        return ctx;
      },
    };
    writeFileSync(stateFile, JSON.stringify(fresh()));
    await call(tickReq(), deps);
    expect(readState().priceAlerts!.map((a) => a.label)).toEqual(["WBIT"]);
  });
});

describe("tick: the plan reminder, the yearly report and the tax reminder", () => {
  const seeded = (extra: Partial<State> = {}) =>
    writeFileSync(
      stateFile,
      JSON.stringify({ ...fresh(), lastWeekly: "2026-10-09", lastMonthly: "2026-10", lastYearly: "2026", ...extra }),
    );
  const tick = async (at: [number, number, number, number, number?], tweak?: (s: PortfolioSnapshot) => void) =>
    html(await call(tickReq(), depsFor(() => contextAt(at, tweak))));

  it("the month's plan: from the 10th, once, not after payday", async () => {
    seeded();
    expect((await tick([2026, 10, 9, 10])).filter((h) => h.startsWith("⏰"))).toEqual([]);
    const sent = (await tick([2026, 10, 12, 9])).filter((h) => h.startsWith("⏰"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Havi terv – 2026. október: még");
    expect(sent[0]).toContain("→ Autó: Diszkont Kincstárjegy D270512 vétel");
    expect((await tick([2026, 10, 13, 9])).filter((h) => h.startsWith("⏰"))).toEqual([]);

    seeded();
    expect((await tick([2026, 10, 30, 10])).filter((h) => h.startsWith("⏰"))).toEqual([]);
  });

  it("the yearly report on 1 January from 08:00, once; not on the very first run", async () => {
    seeded({ lastMonthly: "2026-12", lastWeekly: "2026-12-25" });
    expect((await tick([2027, 1, 1, 7, 55])).filter((h) => h.includes("Éves zárás"))).toEqual([]);
    const sent = (await tick([2027, 1, 1, 8])).filter((h) => h.includes("Éves zárás"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("🎆 <b>Éves zárás – 2026</b>");
    expect(sent[0]).toContain("Éves piaci eredmény");
    expect((await tick([2027, 1, 1, 8, 5])).filter((h) => h.includes("Éves zárás"))).toEqual([]);

    seeded({ lastYearly: undefined, lastMonthly: "2026-12", lastWeekly: "2026-12-25" });
    expect((await tick([2027, 1, 1, 9])).filter((h) => h.includes("Éves zárás"))).toEqual([]);
    expect(readState().lastYearly).toBe("2027");
  });

  const cashInterest = (s: PortfolioSnapshot) => {
    s.transactions.push({
      id: "cash-int",
      accountId: "ly-cash",
      date: local(2026, 6, 30),
      type: "interest",
      currency: "HUF",
      grossAmount: 12_000,
      netAmount: 12_000,
    });
  };

  it("the tax reminder in May until the 20th, only with taxable income outside TBSZ", async () => {
    seeded({ lastYearly: "2027", lastMonthly: "2027-05", lastWeekly: "2027-04-30" });
    const sent = (await tick([2027, 5, 3, 10], cashInterest)).filter((h) => h.includes("Szja-bevallás"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("A TBSZ-en kívüli számláidon 2026-ben:");
    expect(sent[0]).toContain(`• Kamat: +${ft(12_000)}`);
    expect((await tick([2027, 5, 4, 10], cashInterest)).filter((h) => h.includes("Szja-bevallás"))).toEqual([]);

    seeded({ lastYearly: "2027", lastMonthly: "2027-05", lastWeekly: "2027-04-30" });
    expect((await tick([2027, 5, 21, 10], cashInterest)).filter((h) => h.includes("Szja-bevallás"))).toEqual([]);

    seeded({ lastYearly: "2027", lastMonthly: "2027-05", lastWeekly: "2027-04-30" });
    expect((await tick([2027, 5, 3, 10])).filter((h) => h.includes("Szja-bevallás"))).toEqual([]);
    expect(readState().taxReminded).toBe("2027");
  });
});
