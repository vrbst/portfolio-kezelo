import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { computeReturns } from "../../src/lib/returns";
import { portfolioLiquidation } from "../../src/lib/liquidation";
import { tbszStatus } from "../../src/lib/tbsz";
import type { Context } from "./data";
import { contextAt } from "./testContext";
import {
  alertsText,
  eventsText,
  forecastText,
  glideText,
  goalsText,
  leftoverAnswer,
  leftoverPromptText,
  liquidationText,
  monthlyText,
  planText,
  quotesText,
  returnsText,
  statusText,
  tbszText,
  weeklyText,
} from "./reports";

// End-to-end snapshot of the whole calculation pipeline on the invented
// portfolio in src/test/fixture.ts: portfolio valuation, value series, day
// change, returns, TBSZ, liquidation, savings goals, glide path, monthly plan,
// month-end leftover, incoming money, alerts, forecast — and the bot's texts
// built from them. Any change to a number shows up as a diff in
// __snapshots__/*.txt. A change you intended: review the diff, then run
// `npm run test:update` and commit the updated snapshot with the change.

const r0 = (n: number) => Math.round(n);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const pad2 = (n: number) => String(n).padStart(2, "0");
/** An ISO instant as LOCAL wall-clock time, so the snapshot is the same in every time zone. */
const localTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const json = (v: unknown, round: (n: number) => number) =>
  JSON.stringify(v, (_k, x) =>
    typeof x === "number"
      ? round(x)
      : typeof x === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(x)
        ? localTime(x)
        : x,
  );

/** The numbers behind the texts, rounded so float noise is not a diff. */
function numbers(ctx: Context) {
  const s = ctx.summary;
  const ret = computeReturns(
    s.accounts.map((a) => a.account),
    ctx.transactions,
    ctx.instMap,
    ctx.prices,
    ctx.fx,
    undefined,
    ctx.at,
  );
  const liq = portfolioLiquidation(s, ctx.at);
  const lines: string[] = [
    `összérték ${r0(s.totalValueHuf)} | papírok ${r0(s.holdingsValueHuf)} | készpénz ${r0(s.cashValueHuf)}`,
    `nettó befizetés ${r0(s.netDepositedHuf)} | bekerülés ${r0(s.costBasisHuf)} | nem realizált ${r0(s.unrealizedPlHuf)} | realizált ${r0(s.realizedPlHuf)} | kamat ${r0(s.interestHuf)}`,
    ...s.accounts.map(
      (a) =>
        `  számla ${a.account.id}: érték ${r0(a.holdingsValueHuf + a.cashValueHuf)}, készpénz ${r0(a.cashValueHuf)}, ` +
        a.holdings.map((h) => `${h.instrumentKey}×${r4(h.quantity)}=${r0(h.marketValueHuf ?? NaN)}`).join(", "),
    ),
    `hozam: ${json(ret, r4)}`,
    `eladás most: bruttó ${r0(liq.grossHuf)}, költség ${r0(liq.saleCostHuf)}, adó ${r0(liq.taxHuf)}, nettó ${r0(liq.netHuf)}`,
    `TBSZ 2025: ${json(tbszStatus(2025, ctx.at), r4)}`,
    `értékgörbe: ${ctx.series.length} pont, utolsó ${json(ctx.series.at(-1), r0)}`,
    `napi változás: ${json(ctx.dayChange, r4)}`,
    ...ctx.savings.map(
      (p) => `cél ${json(p, r0)}`,
    ),
    `célpálya: ${json(ctx.glide, r4)}`,
    `riasztások: ${ctx.alerts.map((a) => `[${a.severity}] ${a.id} – ${a.title}`).join("\n  ")}`,
  ];
  return lines.join("\n");
}

function fullReport(ctx: Context): string {
  const section = (title: string, body: string) => `==== ${title} ====\n${body}\n`;
  return [
    section("számok", numbers(ctx)),
    section("/allapot", statusText(ctx)),
    section("/arfolyam", quotesText(ctx)),
    section("/eladas", liquidationText(ctx)),
    section("/esemenyek", eventsText(ctx, 60)),
    section("/riasztasok", alertsText(ctx)),
    section("/celok", goalsText(ctx)),
    section("/elorejelzes", forecastText(ctx)),
    section("/terv", planText(ctx)),
    section("/palya", glideText(ctx)),
    section("/hozam", returnsText(ctx)),
    section("/tbsz", tbszText(ctx)),
    section("heti", weeklyText(ctx)),
    section("havi", monthlyText(ctx)),
    section("maradék kérdés", leftoverPromptText(ctx)),
    section("/maradek 80000", leftoverAnswer(ctx, "80000").html),
    section("/maradek 900000", leftoverAnswer(ctx, "900000").html),
  ].join("\n");
}

// The numbers are the ones a Budapest user sees: pinned to that zone even in
// the CI runs with another TZ (the unit tests cover the other zones). Bond
// accrual counts milliseconds, so a DST hour moves it by a few forints.
const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Budapest";
});
afterAll(() => {
  process.env.TZ = savedTz;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("full pipeline on the invented portfolio", () => {
  it("mid-month (2026-10-14, Wednesday)", async () => {
    await expect(fullReport(contextAt([2026, 10, 14, 10]))).toMatchFileSnapshot(
      "__snapshots__/pipeline-2026-10-14.txt",
    );
  });

  it("payday: the month's last working day (2026-10-30, Friday)", async () => {
    await expect(fullReport(contextAt([2026, 10, 30, 10]))).toMatchFileSnapshot(
      "__snapshots__/pipeline-2026-10-30.txt",
    );
  });

  it("after a DKJ matured (2026-11-20) and just past midnight", async () => {
    await expect(fullReport(contextAt([2026, 11, 20, 0]))).toMatchFileSnapshot(
      "__snapshots__/pipeline-2026-11-20.txt",
    );
  });
});
