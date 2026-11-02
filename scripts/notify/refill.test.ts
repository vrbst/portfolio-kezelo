import { afterEach, describe, expect, it, vi } from "vitest";
import { contextAt } from "./testContext";
import { goalsText, planText } from "./reports";
import { portfolioViewHtml } from "./assistantView";
import { buildFullAiContext } from "../../src/lib/aiContext";
import { FIX } from "../../src/test/fixture";
import type { RefillGoal } from "../../src/lib/refill";
import type { PortfolioSnapshot } from "../../src/lib/sync";

// The bot side of a refill goal (Visszapótlás), on the invented portfolio: a
// planned FixMÁP withdrawal shows in /celok and the assistant view; once the
// day has passed it leads the /terv plan, its money going along the glide path.

const GOAL: RefillGoal = {
  id: "rf",
  name: "Teszt-kivét",
  createdAt: "2026-10-01T08:00:00.000Z",
  withdrawal: {
    day: "2026-10-20",
    source: { kind: "holding", instrumentKey: FIX, accountId: "mak" },
    amountHuf: 300_000,
    faceHuf: 301_000,
    costHuf: 3_010,
  },
  target: { kind: "glide" },
  pace: { kind: "asap" },
};

const withRefill = (s: PortfolioSnapshot) => {
  s.prefs = { ...s.prefs, refill: { updatedAt: "2026-10-01T08:00:00.000Z", value: [GOAL] } };
};

afterEach(() => vi.useRealTimers());

describe("refill goal in the bot", () => {
  it("/celok lists it as planned before the day", () => {
    const ctx = contextAt([2026, 10, 14, 10], withRefill);
    expect(ctx.refills.map((p) => p.status)).toEqual(["planned"]);
    const text = goalsText(ctx);
    expect(text).toContain("Visszapótlás");
    expect(text).toContain("Teszt-kivét");
    expect(text).toContain("névérték");
    expect(text).toContain("a havi terv először ezt pótolja vissza");
  });

  it("after the day without the import: an alert, and /terv puts it first along the glide path", () => {
    const ctx = contextAt([2026, 10, 22, 10], withRefill);
    expect(ctx.refills[0].status).toBe("awaiting");
    expect(ctx.alerts.some((a) => a.id === "refill-import:rf")).toBe(true);
    const plan = planText(ctx);
    const first = plan.indexOf("Teszt-kivét");
    expect(first).toBeGreaterThan(-1);
    expect(plan).toContain("a célpálya szerint");
    // The DCA goal comes after it.
    expect(plan.indexOf("VWCE")).toBeGreaterThan(first);
  });

  it("the assistant view and the AI context mention it (escaped, no script)", () => {
    const ctx = contextAt([2026, 10, 14, 10], (s) => {
      withRefill(s);
      (s.prefs!.refill!.value as RefillGoal[])[0].name = "<b>Teszt</b>";
    });
    const html = portfolioViewHtml(ctx, "https://example.invalid/app/");
    expect(html).toContain("&lt;b&gt;Teszt&lt;/b&gt;");
    expect(html).toContain("visszapótlás");
    const ai = buildFullAiContext({
      summary: ctx.summary,
      accounts: ctx.snapshot.accounts,
      transactions: ctx.transactions,
      instruments: ctx.instruments,
      prices: ctx.prices,
      fx: ctx.fx,
      historyFile: ctx.history,
      bondRates: null,
      series: ctx.series,
      dayChange: ctx.dayChange,
      goals: ctx.goalProgress,
      alerts: ctx.alerts,
      savingsGoals: [],
      dcaGoals: ctx.snapshot.goals ?? [],
      glide: ctx.glide,
      now: ctx.at,
    });
    expect(ai).toContain("Visszapótlás");
    expect(ai).toContain("tervezett kivét");
  });
});
