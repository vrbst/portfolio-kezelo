// Message texts (Telegram HTML) built from a loaded Context.

import { accountLabel } from "../../src/lib/accountRules";
import type { Alert } from "../../src/lib/alerts";
import type { UpcomingEvent } from "../../src/lib/events";
import {
  asOf,
  consolidatedHoldings,
  type ValuePoint,
} from "../../src/lib/portfolio";
import {
  detectRecurringSavings,
  forecastMilestones,
  loadForecastSettings,
  loadForecastSnapshots,
  monthlyBudgetHuf,
  projectForecast,
  type PlannedExpense,
} from "../../src/lib/forecast";
import {
  bandBaseNote,
  bandRule,
  freeCashHuf,
  positionsFromSummary,
  suggestionText,
} from "../../src/lib/rebalance";
import { benchmarkIndex, BENCHMARK, computeReturns, monthlyPerformance } from "../../src/lib/returns";
import { computeIncomeByYear } from "../../src/lib/income";
import { tbszExitScenarios, tbszStatus } from "../../src/lib/tbsz";
import { addDaysIso, toLocalDay, txDay } from "../../src/lib/day";
import {
  NEWS_EDITION_LABEL,
  rankedItems,
  type NewsDigest,
  type NewsEdition,
  type NewsImpact,
} from "../../src/lib/newsSchema";
import { quotedToday } from "../../src/lib/prices";
import {
  buildMonthlyPlan,
  computePlanNeeds,
  defaultPlanAmount,
  planLineText,
  planTextLines,
  type MonthlyPlan,
} from "../../src/lib/monthlyPlan";
import { loadLeftoverSettings, loadPlanOrder } from "../../src/lib/planPrefs";
import {
  buildLeftoverPlan,
  leftoverNeeds,
  leftoverReply,
  leftoverStatusLines,
  recordedLeftover,
  type LeftoverMonth,
  type LeftoverNeeds,
} from "../../src/lib/leftover";
import { effectiveMonthLabel } from "../../src/lib/goals";
import { loadSavingsGoals } from "../../src/lib/savings";
import { portfolioLiquidation } from "../../src/lib/liquidation";
import type { Context } from "./data";
import type { NightlyAnalysis } from "../../src/lib/aiAnalysis";
import { weeklyAiLine } from "./aiUsage";

// ---- formatting -----------------------------------------------------------

/** Escape user/data text for Telegram's HTML. */
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const nf = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 0 });
export const ft = (n: number) => `${nf.format(Math.round(n))} Ft`;
/**
 * Compact amount for list lines on a phone screen: millions as "35,93 M Ft",
 * smaller amounts in full. Headline totals keep the exact ft().
 */
export const mft = (n: number) =>
  Math.abs(n) >= 1e6
    ? `${(n / 1e6).toFixed(2).replace(".", ",")} M Ft`
    : ft(n);

// Long official names → the short forms used day to day, so a list line
// (name + amount) fits one phone-width row.
const NAME_SHORT: [RegExp, string][] = [
  [/Fix Magyar Állampapír/i, "FixMÁP"],
  [/Prémium Magyar Állampapír/i, "PMÁP"],
  [/Bónusz Magyar Állampapír/i, "BMÁP"],
  [/Magyar Állampapír Plusz/i, "MÁP Plusz"],
  [/Diszkont Kincstárjegy/i, "DKJ"],
];
/** Short display name (escaped for HTML). */
export function shortName(name: string): string {
  let s = name;
  for (const [re, short] of NAME_SHORT) s = s.replace(re, short);
  // Trailing "(LY-8WRK5A8)"-style account refs add nothing on a phone.
  return esc(s.replace(/\s*\([^)]*\)\s*$/, "").trim());
}

export const sft = (n: number) => `${n >= 0 ? "+" : "−"}${ft(Math.abs(n))}`;
export const pct = (x: number | undefined, d = 1) =>
  x == null || !Number.isFinite(x)
    ? "—"
    : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d).replace(".", ",")}%`;
/** Plain percent with a decimal comma: 0.06 → "6,0%". */
const rate = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")}%`;
const arrow = (x: number) => (x > 0 ? "📈" : x < 0 ? "📉" : "➖");

const MONTHS = [
  "január", "február", "március", "április", "május", "június",
  "július", "augusztus", "szeptember", "október", "november", "december",
];
export const dayLabel = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${y}. ${MONTHS[m - 1].slice(0, 3)}. ${d}.`;
};
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${y}. ${MONTHS[m - 1]}`;
};
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const SEVERITY_ICON: Record<Alert["severity"], string> = {
  high: "🔴",
  medium: "🟠",
  info: "🔵",
};
const EVENT_ICON: Record<UpcomingEvent["kind"], string> = {
  coupon: "💰",
  maturity: "🏁",
  tbsz: "🗓",
};

/** Last series point on/before `day` (YYYY-MM-DD). */
function pointAt(series: ValuePoint[], day: string): ValuePoint | undefined {
  let p: ValuePoint | undefined;
  for (const x of series) {
    if (x.date <= day) p = x;
    else break;
  }
  return p;
}

/** Market result between two points: value change minus net flows. */
const marketDelta = (a: ValuePoint, b: ValuePoint) =>
  b.value - b.invested - (a.value - a.invested);

// ---- pieces ---------------------------------------------------------------

export function alertLine(a: Alert): string {
  return `${SEVERITY_ICON[a.severity]} <b>${esc(a.title)}</b>${a.detail ? `\n${esc(a.detail)}` : ""}`;
}

export function eventLine(e: UpcomingEvent): string {
  const when =
    e.daysUntil === 0
      ? "ma"
      : e.daysUntil === 1
        ? "holnap"
        : `${e.daysUntil} nap múlva`;
  const amt = e.amountHuf ? ` – <b>${ft(e.amountHuf)}</b>` : "";
  return `${EVENT_ICON[e.kind]} ${dayLabel(e.date)} (${when}): ${esc(e.title)}${amt}`;
}

// ---- commands -------------------------------------------------------------

export function statusText(ctx: Context): string {
  const s = ctx.summary;
  const lines = [`💼 <b>Portfólió – ${ft(s.totalValueHuf)}</b>`];
  if (ctx.dayChange)
    lines.push(
      `${arrow(ctx.dayChange.abs)} ${ctx.dayChange.note}: ${sft(ctx.dayChange.abs)} (${pct(ctx.dayChange.pct, 2)})`,
    );
  lines.push(
    `Összes eredmény: ${sft(s.totalPlHuf)} (${pct(s.totalReturnPct)})`,
    `Befektetett tőke: ${ft(s.netDepositedHuf)}`,
    "",
  );
  for (const a of s.accounts) {
    if (Math.abs(a.totalValueHuf) < 1) continue;
    lines.push(`• ${shortName(a.account.name)}: ${mft(a.totalValueHuf)}`);
  }
  const top = consolidatedHoldings(s)
    .sort((a, b) => b.marketValueHuf - a.marketValueHuf)
    .slice(0, 6);
  if (top.length) {
    lines.push("", "<b>Legnagyobb pozíciók</b>");
    for (const h of top) {
      const q = ctx.liveQuotes[h.instrumentKey];
      const day =
        q?.prevClose && q.price ? ` (ma ${pct(q.price / q.prevClose - 1)})` : "";
      lines.push(
        `• ${shortName(h.instrument?.name ?? h.instrumentKey)}: ${mft(h.marketValueHuf)}${day}`,
      );
    }
  }
  if (ctx.alerts.length)
    lines.push("", `⚠️ ${ctx.alerts.length} aktív teendő – /teendok`);
  return lines.join("\n");
}

/** Price in its own currency: "123,45 EUR" (HUF without decimals). */
export const px = (n: number, ccy: string) =>
  ccy === "HUF"
    ? ft(n)
    : `${n.toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })} ${esc(ccy)}`;

/** Daily change of a live quote, " (ma +0,4%)", or "" without a base. */
const quoteDay = (q: { price: number; prevClose?: number } | undefined) =>
  q?.prevClose && q.price ? ` (ma ${pct(q.price / q.prevClose - 1, 2)})` : "";

/**
 * /arfolyam: current prices — EUR/HUF (and any other currency held) first,
 * then every held stock / ETF / fund with its daily change (largest position
 * first). Prices without a live quote come from the
 * committed price file (last close), marked as such.
 */
export function quotesText(ctx: Context): string {
  const lines = ["💱 <b>Árfolyamok</b>", ""];
  const held = consolidatedHoldings(ctx.summary).filter(
    (h) =>
      h.quantity > 1e-9 &&
      ["etf", "stock", "fund"].includes(h.instrument?.type ?? ""),
  );
  const closeMark = " <i>(záró)</i>";

  const ccys = [
    "EUR",
    ...new Set(held.map((h) => h.currency).filter((c) => c !== "HUF" && c !== "EUR")),
  ];
  for (const c of ccys) {
    const r = ctx.fx[c];
    if (!r) continue;
    const q = ctx.liveQuotes[c];
    lines.push(
      `<b>${esc(c)}/HUF: ${r.toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>${q ? quoteDay(q) : closeMark}`,
    );
  }

  if (!held.length) {
    lines.push("", "Nincs részvény- vagy ETF-pozíció.");
    return lines.join("\n");
  }
  lines.push("");
  for (const h of held.sort((a, b) => b.marketValueHuf - a.marketValueHuf)) {
    const price = ctx.prices.get(h.instrumentKey);
    const name = shortName(h.instrument?.name ?? h.instrumentKey);
    if (price == null) {
      lines.push(`• ${name}: nincs árfolyam`);
      continue;
    }
    const q = ctx.liveQuotes[h.instrumentKey];
    lines.push(`• ${name}: <b>${px(price, h.currency)}</b>${q ? quoteDay(q) : closeMark}`);
  }
  if (ctx.priceFile?.updatedAt && held.some((h) => !ctx.liveQuotes[h.instrumentKey]))
    lines.push("", `<i>záró = az árfolyamfájl szerint (${dayLabel(ctx.priceFile.updatedAt)})</i>`);
  return lines.join("\n");
}

/** /eladas: what selling everything today would net (fees and TBSZ tax off). */
export function liquidationText(ctx: Context): string {
  const l = portfolioLiquidation(ctx.summary, ctx.at);
  const lines = [
    `💸 <b>Ha most eladnál mindent: ${ft(l.netHuf)}</b>`,
    `Bruttó érték: ${ft(l.grossHuf)}`,
  ];
  if (l.saleCostHuf > 0.5) lines.push(`Visszaváltási díj: −${ft(l.saleCostHuf)}`);
  if (l.taxHuf > 0.5) lines.push(`TBSZ-adó: −${ft(l.taxHuf)}`);
  lines.push("");
  for (const a of l.accounts) {
    if (Math.abs(a.grossHuf) < 1) continue;
    const off: string[] = [];
    if (a.saleCostHuf > 0.5) off.push(`díj −${mft(a.saleCostHuf)}`);
    if (a.taxRate != null)
      off.push(
        a.taxHuf > 0.5
          ? `adó ${Math.round(a.taxRate * 100)}% −${mft(a.taxHuf)}`
          : a.taxRate === 0
            ? "adómentes"
            : "nincs adóköteles hozam",
      );
    lines.push(
      `• ${shortName(a.account.name)}: <b>${mft(a.netHuf)}</b>${off.length ? ` (${off.join(", ")})` : ""}`,
    );
  }
  lines.push(
    "",
    "<i>Mai árakon. A TBSZ-en csak a hozam adózik (a jelenlegi szakasz kulcsával); a kötvények lejárat előtti visszaváltási díja (alapból a névérték 1%-a) levonva.</i>",
  );
  return lines.join("\n");
}

export function eventsText(ctx: Context, days = 30): string {
  const evs = ctx.events.filter((e) => e.daysUntil <= days);
  if (!evs.length) return `🗓 A következő ${days} napban nincs esemény.`;
  return [`🗓 <b>Események – következő ${days} nap</b>`, ...evs.map(eventLine)].join(
    "\n",
  );
}

export function alertsText(ctx: Context): string {
  if (!ctx.alerts.length) return "✅ Nincs aktív teendő.";
  return [
    `⚠️ <b>Aktív teendők (${ctx.alerts.length})</b>`,
    ...ctx.alerts.map(alertLine),
  ].join("\n\n");
}

/** "félretéve: 137 297 Ft (Államkincstár) · automatikusan (kamat, lejárat): 700 000 Ft". */
function reserveLine(ctx: Context, p: Context["savings"][number]): string {
  const parts: string[] = [];
  if (p.reservedHuf >= 1) {
    const where = [
      ...new Set(
        (p.goal.reserves ?? [])
          .filter((r) => r.amountHuf > 0)
          .map((r) => {
            const a = ctx.snapshot.accounts.find((x) => x.id === r.accountId);
            return a ? accountLabel(a) : "bankszámla / máshol";
          }),
      ),
    ].join(", ");
    parts.push(`félretéve: ${ft(p.reservedHuf)}${where ? ` – ${esc(where)}` : ""}`);
  }
  if (p.autoCashHuf >= 1) parts.push(`automatikusan (kamat, lejárat): ${ft(p.autoCashHuf)}`);
  return parts.length ? `\n   ${parts.join(" · ")}` : "";
}

export function goalsText(ctx: Context): string {
  const lines: string[] = [];
  if (ctx.goalProgress.length) {
    lines.push("🎯 <b>Rendszeres vásárlások</b>");
    for (const g of ctx.goalProgress)
      lines.push(
        `${g.done ? "✅" : "⏳"} ${shortName(g.instrumentName)} (${esc(g.periodLabel)}): ${ft(g.investedHuf)} / ${ft(g.targetHuf)}${g.done ? "" : ` – még ${ft(g.remainingHuf)}`}`,
      );
  }
  if (ctx.savings.length) {
    if (lines.length) lines.push("");
    lines.push("🏦 <b>Középtávú célok</b>");
    for (const p of ctx.savings) {
      lines.push(
        `${p.reached ? "✅" : "⏳"} <b>${esc(p.goal.name)}</b> – ${ft(p.targetHuf)}, ${dayLabel(p.goal.targetDate)}`,
        `   most ${Math.round(p.progressPct * 100)}%, a határidőre várhatóan ${Math.round(p.projectedPct * 100)}%` +
          reserveLine(ctx, p) +
          // No monthly line before a later saving start (nothing asked yet).
          (p.reached || (p.savingStartsOn && Math.abs(p.thisMonthNetHuf) < 1)
            ? ""
            : `\n   ${p.monthAdjective} keret: ${ft(p.monthlyNeededHuf)}, ebből teljesítve ${ft(p.thisMonthNetHuf)}`),
      );
    }
  }
  return lines.length ? lines.join("\n") : "Még nincs beállított cél.";
}

/** Same projection the Forecast page runs (settings + goals as expenses). */
function forecastFor(ctx: Context) {
  const settings = loadForecastSettings();
  const detected = detectRecurringSavings(ctx.transactions, ctx.fx, ctx.at);
  const monthly = settings.monthlySavingOverride ?? detected.monthlyHuf;
  const goalExpenses: PlannedExpense[] = loadSavingsGoals()
    .filter((g) => /^\d{4}-\d{2}-\d{2}/.test(g.targetDate) && g.targetHuf > 0)
    .map((g) => ({
      id: `goal:${g.id}`,
      date: g.targetDate,
      amountHuf: g.targetHuf,
      note: g.name,
    }));
  const result = projectForecast(
    ctx.summary,
    {
      annualReturn: settings.annualReturn,
      monthlySavingHuf: monthly,
      savingGrowth: settings.savingGrowth,
      reinvestTarget: settings.reinvestTarget,
      reinvestBondRate: settings.reinvestBondRate,
      months: Math.max(settings.months, 120),
      withdrawal: settings.withdrawal,
      withdrawalIndex: settings.inflationPct,
    },
    [...settings.expenses, ...goalExpenses],
    ctx.at,
  );
  return { settings, monthly, result };
}

export function forecastText(ctx: Context): string {
  const { settings, monthly, result } = forecastFor(ctx);
  const r = settings.annualReturn;
  const lines = [
    "🔮 <b>Előrejelzés</b> (névleges Ft)",
    `Havi megtakarítás: ${ft(monthly)}${settings.savingGrowth ? `, évente +${rate(settings.savingGrowth)}` : ""}`,
    `Hozam: ${rate(r.pess)} / ${rate(r.real)} / ${rate(r.opt)} (pessz. / reális / opt.)`,
    "",
  ];
  for (const m of forecastMilestones(result).filter((m) =>
    [1, 3, 5, 10, 20].includes(m.years),
  ))
    lines.push(
      `+${m.years} év: <b>${ft(m.point.real)}</b>\n   sáv ${ft(m.point.pess)} – ${ft(m.point.opt)}`,
    );
  const short = result.shortfall.real ?? result.shortfall.pess;
  if (short)
    lines.push(
      "",
      `⚠️ ${monthLabel(short)}-ban elfogy a likvid pénz (kötvényeken kívül).`,
    );
  return lines.join("\n");
}

/** "2,2 év" / "14 hónap" / "35 nap": a span on a phone line. */
function spanLabel(days: number): string {
  if (days < 60) return `${Math.max(0, days)} nap`;
  if (days < 730) return `${Math.round(days / 30.4)} hónap`;
  return `${(days / 365).toFixed(1).replace(".", ",")} év`;
}

/** /terv: this month's Havi terv (the same split the Teendők panel shows). */
export function planText(ctx: Context): string {
  const lines = monthlyPlanLines(ctx).slice(1);
  if (!lines.length) return "💶 Ebben a hónapban nincs mit tervezni (nincs cél és célpálya).";
  lines.push("", "<i>Az appban: Teendők → Havi terv.</i>");
  return lines.join("\n");
}

/** Glide path buckets: actual / path target (band; HUF off the path). */
function glideBucketLines(ctx: Context): string[] {
  const g = ctx.glide!;
  const icon = { within: "✅", below: "⬇️", above: "⬆️", empty: "▫️" };
  const p = (v: number) => `${Math.round(v * 100)}%`;
  return g.buckets.map(
    (b) =>
      `${icon[b.status]} ${esc(b.bucket.name)}: ${p(b.weight)} / ${p(b.target)} (${p(b.low)}–${p(b.high)}${bandBaseNote(b) ? `, ${esc(bandBaseNote(b))}` : ""}; ${sft(b.valueHuf - b.target * g.totalHuf)})`,
  );
}

/**
 * /palya: the glide path today — bucket weights vs. path and band, each
 * bucket's final weight, and the band rule's steps for a bucket out of band
 * (the same plan the Teendők panel suggests, free cash used first).
 */
export function glideText(ctx: Context): string {
  const g = ctx.glide;
  const cfg = ctx.glideConfig;
  if (!g?.buckets.length || !cfg) return "🧭 Még nincs beállított célpálya.";
  const p = (v: number) => `${Math.round(v * 100)}%`;
  const free = freeCashHuf(g);
  const lines = [
    `🧭 <b>Célpálya – ${dayLabel(g.day)}</b>`,
    `Kezelt érték: ${ft(g.totalHuf)}${free >= 1 ? ` · szabad készpénz: ${ft(free)}` : ""}`,
    "",
    "<b>Tény / pálya (sáv; eltérés a pályától)</b>",
    ...glideBucketLines(ctx),
    "",
    "<b>Végcél</b>",
    ...g.buckets.map(
      (b) => `• ${esc(b.bucket.name)}: ${p(b.bucket.finalWeight)} (${dayLabel(b.bucket.endDate)})`,
    ),
    "",
  ];
  if (!g.buckets.some((b) => b.status === "below" || b.status === "above")) {
    lines.push("✅ Minden csoport a sávon belül – nincs teendő, az új pénz a havi terv szerint megy.");
    return lines.join("\n");
  }
  const plan = bandRule(cfg, g, free, ctx.accountCtx);
  const ok = plan.suggestions.filter((s) => s.status === "ok");
  lines.push("⚠️ <b>Sávon kívül – javasolt lépések</b>");
  if (ok.length) lines.push(...ok.map((s) => `→ ${esc(suggestionText(s))}`));
  else lines.push("Nincs most megtehető lépés (minimum alatti vagy túl drága kötések).");
  lines.push(...plan.notes.map((n) => `<i>${esc(n)}</i>`));
  return lines.join("\n");
}

/**
 * /hozam: the Hozam page's numbers — XIRR and TWR (cumulative first under a
 * year, where annualizing would inflate them), the benchmark over the same
 * days, then market results by period and per account.
 */
export function returnsText(ctx: Context): string {
  const s = ctx.summary;
  const r = computeReturns(
    s.accounts.map((a) => a.account),
    ctx.transactions,
    ctx.instMap,
    ctx.prices,
    ctx.fx,
    ctx.history,
    ctx.at,
  );
  const short = r.days < 365;
  const both = (annual?: number, cum?: number) =>
    short
      ? `${pct(cum)}${annual != null ? ` (évesítve ${pct(annual)})` : ""}`
      : `${pct(annual)}/év (összesen ${pct(cum)})`;
  const lines = [
    `📈 <b>Hozam</b> – ${spanLabel(r.days)} óta`,
    `Pénzsúlyozott (XIRR): <b>${both(r.xirrPct, r.xirrCumulativePct)}</b>`,
    `Idősúlyozott (TWR): <b>${both(r.twrPct, r.twrCumulativePct)}</b>`,
  ];
  const bench = benchmarkIndex(ctx.history, r.twrIndex.map((x) => x.date));
  const lastBench = bench && [...bench].reverse().find((v) => Number.isFinite(v));
  if (lastBench != null)
    lines.push(`${esc(BENCHMARK.label)} ugyanezalatt: ${pct(lastBench)} (Ft-ban)`);
  lines.push(
    `Összes eredmény: ${sft(s.totalPlHuf)} (${pct(r.simplePct)} a befektetett tőkére)`,
  );

  const last = ctx.series[ctx.series.length - 1];
  const yearAgo = new Date(ctx.at);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const monthAgo = new Date(ctx.at);
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  const periods: [string, ValuePoint | undefined][] = [
    ["Elmúlt 1 hónap", pointAt(ctx.series, localDay(monthAgo))],
    ["Idén", pointAt(ctx.series, `${ctx.at.getFullYear() - 1}-12-31`) ?? ctx.series[0]],
    ["Elmúlt 12 hónap", pointAt(ctx.series, localDay(yearAgo))],
  ];
  const periodLines = periods
    .filter(([, a]) => a && last && a !== last)
    .map(([label, a]) => {
      const d = marketDelta(a!, last);
      return `${arrow(d)} ${label}: ${sft(d)} (${pct(a!.value ? d / a!.value : undefined)})`;
    });
  if (periodLines.length) lines.push("", "<b>Piaci eredmény</b>", ...periodLines);

  const accs = s.accounts.filter((a) => Math.abs(a.totalValueHuf) >= 1);
  if (accs.length > 1) {
    lines.push("", "<b>Számlánként</b> (érték − befizetett tőke)");
    for (const a of accs) {
      const gain = a.totalValueHuf - a.capitalBasisHuf;
      lines.push(
        `• ${shortName(a.account.name)}: ${sft(gain)}${a.capitalBasisHuf > 0 ? ` (${pct(gain / a.capitalBasisHuf)})` : ""}`,
      );
    }
  }
  lines.push(
    "",
    "<i>XIRR: a saját pénzed hozama a befizetések időzítésével; TWR: a befektetések teljesítménye, időzítés nélkül.</i>",
  );
  return lines.join("\n");
}

/**
 * /tbsz: every TBSZ account (oldest first) — its phase and tax rate, the next
 * milestone, and what selling would net now vs. after each later milestone
 * (the account page's TbszTimeline + TbszExitValue).
 */
export function tbszText(ctx: Context): string {
  const accs = ctx.summary.accounts
    .filter((a) => a.account.kind === "tbsz" && a.account.tbszYear)
    .map((a) => ({ a, st: tbszStatus(a.account.tbszYear!, ctx.at) }))
    // An empty account still matters while it takes deposits.
    .filter(({ a, st }) => Math.abs(a.totalValueHuf) >= 1 || st.phase === "collecting")
    .sort((x, y) => x.st.year - y.st.year);
  if (!accs.length) return "🗓 Nincs TBSZ-számla.";
  const p = (v: number) => `${Math.round(v * 100)}%`;
  const lines = ["🗓 <b>TBSZ-számlák</b>"];
  for (const { a, st } of accs) {
    const gain = a.totalValueHuf - a.capitalBasisHuf;
    const day = (iso: string) => dayLabel(txDay(iso));
    const rateText =
      st.taxRate === 0
        ? "adómentes"
        : `${p(st.taxRate)} adó a hozamra${st.hasSzocho ? ` (${p(st.szjaRate)} szja + ${p(st.szochoRate)} szocho)` : ""}`;
    lines.push(
      "",
      `<b>${shortName(a.account.name)}</b> – gyűjtőév ${st.year}`,
      `${esc(st.phaseLabel)} · ${rateText}`,
    );
    if (st.next && st.daysToNext != null)
      lines.push(`Következő: ${esc(st.next.label)} – ${day(st.next.date)} (${spanLabel(st.daysToNext)} múlva)`);
    lines.push(`Érték: ${mft(a.totalValueHuf)} · hozam: ${sft(gain)}`);
    if (gain <= 0) {
      lines.push("Nincs adóköteles hozam – most adó nélkül vehető ki.");
      continue;
    }
    for (const sc of tbszExitScenarios(st, a.totalValueHuf, gain)) {
      if (sc.state === "past") continue;
      const tax = sc.taxHuf >= 1 ? ` (adó −${mft(sc.taxHuf)})` : " (adómentes)";
      if (sc.state === "current") {
        lines.push(`Ha most eladnád: <b>${mft(sc.netHuf)}</b>${tax}`);
        continue;
      }
      const m = st.milestones.find((x) => x.key === sc.key);
      lines.push(
        `${m ? `${day(m.date)} után` : esc(sc.label)}: ${mft(sc.netHuf)}${tax}, +${mft(sc.savedVsNowHuf)} a mostanihoz képest`,
      );
    }
  }
  lines.push(
    "",
    "<i>A mai hozamra vetítve; a kötvények lejárat előtti visszaváltási díja nincs benne (az /eladas számolja).</i>",
  );
  return lines.join("\n");
}

// ---- scheduled reports ----------------------------------------------------

export function weeklyText(ctx: Context): string {
  const today = localDay(ctx.at);
  const weekAgo = new Date(ctx.at);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const last = ctx.series[ctx.series.length - 1];
  const prev = pointAt(ctx.series, localDay(weekAgo));
  const lines = [`📊 <b>Heti összefoglaló – ${dayLabel(today)}</b>`, ""];
  lines.push(`Vagyon: <b>${ft(ctx.summary.totalValueHuf)}</b>`);
  if (last && prev) {
    const d = marketDelta(prev, last);
    const flows = last.invested - prev.invested;
    lines.push(
      `${arrow(d)} Heti piaci eredmény: ${sft(d)} (${pct(prev.value ? d / prev.value : undefined)})`,
    );
    if (Math.abs(flows) >= 1) lines.push(`Nettó befizetés a héten: ${sft(flows)}`);
  }

  // Per-position weekly move (securities with a price history).
  const moves = consolidatedHoldings(ctx.summary)
    .map((h) => {
      const then = asOf(ctx.history?.prices[h.instrumentKey], localDay(weekAgo));
      const now = ctx.prices.get(h.instrumentKey);
      return then && now
        ? { name: h.instrument?.name ?? h.instrumentKey, ch: now / then - 1 }
        : null;
    })
    .filter((x): x is { name: string; ch: number } => x != null)
    .sort((a, b) => b.ch - a.ch);
  if (moves.length) {
    lines.push("", "<b>Pozíciók a héten</b>");
    for (const m of moves) lines.push(`• ${shortName(m.name)}: ${pct(m.ch)}`);
  }

  const next = ctx.events.filter((e) => e.daysUntil <= 7);
  if (next.length) lines.push("", "<b>Jövő hét</b>", ...next.map(eventLine));
  const open = ctx.goalProgress.filter((g) => !g.done);
  if (open.length)
    lines.push(
      "",
      "<b>Még hiányzó vásárlások</b>",
      ...open.map(
        (g) => `⏳ ${shortName(g.instrumentName)}: még ${ft(g.remainingHuf)}`,
      ),
    );
  if (ctx.alerts.length)
    lines.push("", `⚠️ ${ctx.alerts.length} aktív teendő – /teendok`);
  const ai = weeklyAiLine(ctx.aiUsage, ctx.at);
  if (ai) lines.push("", ai);
  return lines.join("\n");
}

/**
 * This month's plan for the saving — the same Havi terv the Teendők panel
 * shows (default amount: the monthly budget minus what goals already got).
 */
function monthlyPlanLines(ctx: Context): string[] {
  const plan = monthlyPlanOf(ctx);
  if (plan.lines.length === 0 && !plan.glidePlan) return [];
  const out = [
    "",
    `💶 <b>Havi terv – ${esc(effectiveMonthLabel(ctx.at))}</b> (${ft(plan.amountHuf)})`,
    ...planTextLines(plan).map((l) => `→ ${esc(l)}`),
  ];
  if (plan.shortHuf >= 1)
    out.push(`⚠️ Nem elég a pénz minden célra — összesen ${ft(plan.shortHuf)} hiányzik.`);
  return out;
}

export function planReminderText(ctx: Context): string | null {
  const open = monthlyPlanOf(ctx).lines.filter((l) => l.need.needHuf >= 1);
  if (!open.length) return null;
  const total = open.reduce((s, l) => s + l.need.needHuf, 0);
  return [
    `⏰ <b>Havi terv – ${esc(effectiveMonthLabel(ctx.at))}: még ${ft(total)} hiányzik</b>`,
    ...open.map((l) => `→ ${esc(planLineText(l))}`),
    "",
    "<i>A teljes terv: /terv · az appban: Teendők → Havi terv.</i>",
  ].join("\n");
}

function monthlyPlanOf(ctx: Context): MonthlyPlan {
  const needs = computePlanNeeds({
    savingsGoals: loadSavingsGoals(),
    dcaGoals: ctx.snapshot.goals ?? [],
    accounts: ctx.snapshot.accounts,
    transactions: ctx.transactions,
    instruments: ctx.instruments,
    prices: ctx.prices,
    fx: ctx.fx,
    order: loadPlanOrder(),
    now: ctx.at,
  });
  const budgetHuf = monthlyBudgetHuf(ctx.transactions, ctx.fx, ctx.at);
  return buildMonthlyPlan({
    amountHuf: defaultPlanAmount(budgetHuf, needs),
    needs,
    glide: ctx.glideConfig,
    state: ctx.glide,
    budgetHuf,
    positions: positionsFromSummary(
      ctx.summary,
      ctx.fx,
      false,
      localDay(ctx.at),
    ),
    instruments: ctx.instMap,
    accounts: ctx.accountCtx,
  });
}

// ---- Month-end leftover ----------------------------------------------------

/** The synced reminders the app shows (the ones deleted there left out). */
function liveReminders(ctx: Context) {
  const deleted = new Set(ctx.snapshot.deletedReminderIds ?? []);
  return (ctx.snapshot.reminders ?? []).filter((r) => !deleted.has(r.id));
}

function leftoverOf(ctx: Context): { ln: LeftoverNeeds; budgetHuf: number } {
  const ln = leftoverNeeds({
    savingsGoals: loadSavingsGoals(),
    dcaGoals: ctx.snapshot.goals ?? [],
    accounts: ctx.snapshot.accounts,
    transactions: ctx.transactions,
    instruments: ctx.instruments,
    prices: ctx.prices,
    fx: ctx.fx,
    order: loadPlanOrder(),
    settings: loadLeftoverSettings(),
    reminders: liveReminders(ctx),
    now: ctx.at,
  });
  return { ln, budgetHuf: monthlyBudgetHuf(ctx.transactions, ctx.fx, ctx.at) };
}

/** The leftover of `ctx.at`'s month recorded in the app (as a plan). */
export function appRecordedLeftover(ctx: Context, m: LeftoverMonth) {
  return recordedLeftover(liveReminders(ctx), m);
}

/**
 * The month-end question: the month's state, then "maradt pénz?" — or, when a
 * leftover is already recorded (`done`: its description), only the state.
 */
export function leftoverPromptText(ctx: Context, done?: string): string {
  const { ln, budgetHuf } = leftoverOf(ctx);
  const lines = [
    `🐷 <b>Hónap vége – ${esc(ln.month.label)}</b>`,
    ...leftoverStatusLines(ln, budgetHuf).map(esc),
    "",
  ];
  if (done) lines.push(`✅ A hónap maradékát már rögzítetted (${esc(done)}).`);
  else
    lines.push(
      "Maradt pénz ebben a hónapban? Írd meg az összeget, pl. <code>/maradek 50000</code>, és megmondom, mire menjen.",
    );
  return lines.join("\n");
}

/** /maradek <összeg>: the split, or the parse error. */
export function leftoverAnswer(ctx: Context, arg: string): { ok: boolean; html: string } {
  const { ln, budgetHuf } = leftoverOf(ctx);
  if (!arg.trim())
    return { ok: false, html: leftoverPromptText(ctx) };
  const positions = positionsFromSummary(ctx.summary, ctx.fx, false, localDay(ctx.at));
  const r = leftoverReply(arg, ln, (amountHuf) =>
    buildLeftoverPlan({
      amountHuf,
      needs: ln.needs,
      glide: ctx.glideConfig,
      state: ctx.glide,
      budgetHuf,
      positions,
      instruments: ctx.instMap,
      accounts: ctx.accountCtx,
    }),
  );
  if (!r.ok) return { ok: false, html: `❌ ${esc(r.lines[0])}` };
  const [head, ...rest] = r.lines;
  return {
    ok: true,
    html: [
      `🐷 <b>${esc(head)}</b>`,
      ...rest.map((l) => `→ ${esc(l)}`),
      "",
      "Az appban (Teendők → Havi terv → „Maradt pénz a hónapból?”) ugyanez tervként rögzíthető.",
    ].join("\n"),
  };
}

/** Report on the month before `ctx.at`. */
export function monthlyText(ctx: Context): string {
  const endPrev = new Date(ctx.at.getFullYear(), ctx.at.getMonth(), 0);
  const endPrev2 = new Date(ctx.at.getFullYear(), ctx.at.getMonth() - 1, 0);
  const endYear = new Date(endPrev.getFullYear() - 1, 11, 31);
  const ym = `${endPrev.getFullYear()}-${String(endPrev.getMonth() + 1).padStart(2, "0")}`;
  const a = pointAt(ctx.series, localDay(endPrev2));
  const b = pointAt(ctx.series, localDay(endPrev));
  const y0 = pointAt(ctx.series, localDay(endYear)) ?? ctx.series[0];
  const lines = [`🗓 <b>Havi zárás – ${monthLabel(ym)}</b>`, ""];

  if (b) {
    lines.push(`Hónap végi vagyon: <b>${ft(b.value)}</b>`);
    if (a) {
      const d = marketDelta(a, b);
      lines.push(
        `${arrow(d)} Havi piaci eredmény: ${sft(d)} (${pct(a.value ? d / a.value : undefined)})`,
      );
      const flows = b.invested - a.invested;
      const { monthly } = forecastFor(ctx);
      lines.push(
        `Nettó befizetés: ${sft(flows)}` +
          (monthly > 0
            ? ` (havi keret ${ft(monthly)} – ${flows >= monthly ? "✅ teljesítve" : `még ${ft(monthly - flows)} hiányzott`})`
            : ""),
      );
    }
    if (y0 && y0 !== b) {
      const d = marketDelta(y0, b);
      lines.push(`Idei piaci eredmény: ${sft(d)}`);
    }
  }

  if (ctx.glide?.buckets.length)
    lines.push("", "<b>Célpálya (tény / pálya, sáv)</b>", ...glideBucketLines(ctx));
  lines.push(...monthlyPlanLines(ctx));

  // Forecast vs. reality: what earlier snapshots expected for this month.
  const curKey = localDay(ctx.at).slice(0, 7);
  const cmp = loadForecastSnapshots()
    .filter((s) => s.month < curKey)
    .map((s) => ({ s, p: s.points.find((x) => x[0] === curKey) }))
    .filter((x) => x.p)
    .slice(-3);
  if (cmp.length) {
    lines.push("", "<b>Előrejelzés vs. valóság</b>");
    for (const { s, p } of cmp) {
      const diff = ctx.summary.totalValueHuf - p![2];
      const inBand =
        ctx.summary.totalValueHuf >= p![1] && ctx.summary.totalValueHuf <= p![3];
      lines.push(
        `• ${monthLabel(s.month)}-i várakozás: ${ft(p![2])} → eltérés ${sft(diff)}${inBand ? "" : " (sávon kívül)"}`,
      );
    }
  }

  const goals = goalsText(ctx);
  if (!goals.startsWith("Még nincs")) lines.push("", goals);
  return lines.join("\n");
}

function incomeOf(ctx: Context, year: number, kinds?: string[]) {
  const accounts = ctx.summary.accounts
    .map((a) => a.account)
    .filter((a) => !kinds || kinds.includes(a.kind));
  if (!accounts.length) return undefined;
  return computeIncomeByYear(accounts, ctx.transactions, ctx.instMap, ctx.fx).find(
    (y) => y.year === year,
  );
}

const TAXABLE_KINDS = ["regular", "cash"];

export function yearlyText(ctx: Context): string {
  const year = ctx.at.getFullYear() - 1;
  const b = pointAt(ctx.series, `${year}-12-31`);
  const a = pointAt(ctx.series, `${year - 1}-12-31`) ?? ctx.series[0];
  const lines = [`🎆 <b>Éves zárás – ${year}</b>`, ""];
  if (b) {
    lines.push(`Év végi vagyon: <b>${ft(b.value)}</b>`);
    if (a && a !== b) {
      const r = computeReturns(
        ctx.summary.accounts.map((x) => x.account),
        ctx.transactions,
        ctx.instMap,
        ctx.prices,
        ctx.fx,
        ctx.history,
        ctx.at,
      );
      const bench = benchmarkIndex(ctx.history, r.twrIndex.map((x) => x.date));
      const months = monthlyPerformance(r.twrIndex, ctx.series, bench, toLocalDay(ctx.at)).filter(
        (m) => m.month.startsWith(`${year}-`),
      );
      const twr = months.reduce((t, m) => t * (1 + m.twr), 1) - 1;
      const benchYear = months.every((m) => m.benchmark != null)
        ? months.reduce((t, m) => t * (1 + m.benchmark!), 1) - 1
        : undefined;
      const d = marketDelta(a, b);
      lines.push(`${arrow(d)} Éves piaci eredmény: ${sft(d)}${months.length ? ` (TWR ${pct(twr)})` : ""}`);
      if (months.length && benchYear != null)
        lines.push(`${esc(BENCHMARK.label)} ugyanezalatt: ${pct(benchYear)} (Ft-ban)`);
      const flows = b.invested - a.invested;
      if (Math.abs(flows) >= 1) lines.push(`Nettó befizetés: ${sft(flows)}`);
    }
  }
  const inc = incomeOf(ctx, year);
  if (inc) {
    const parts: string[] = [];
    if (Math.abs(inc.realizedPlHuf) >= 1) parts.push(`realizált ${sft(inc.realizedPlHuf)}`);
    if (inc.interestHuf >= 1) parts.push(`kamat ${ft(inc.interestHuf)}`);
    if (inc.dividendHuf >= 1) parts.push(`osztalék ${ft(inc.dividendHuf)}`);
    if (inc.feesHuf >= 1) parts.push(`díjak −${ft(inc.feesHuf)}`);
    if (parts.length) lines.push("", `Az év során: ${parts.join(" · ")}`);
  }
  const tax = taxableIncome(ctx, year);
  if (tax)
    lines.push(
      "",
      `🧾 A TBSZ-en kívüli számlák ${year}-es jövedelme: ${sft(tax.totalHuf)} – szja-bevallás május 20-ig, májusban emlékeztetlek.`,
    );
  return lines.join("\n");
}

function taxableIncome(ctx: Context, year: number) {
  const inc = incomeOf(ctx, year, TAXABLE_KINDS);
  if (!inc) return null;
  const totalHuf = inc.realizedPlHuf + inc.dividendHuf + inc.interestHuf;
  if (
    Math.abs(inc.realizedPlHuf) < 1 &&
    inc.dividendHuf < 1 &&
    Math.abs(inc.interestHuf) < 1
  )
    return null;
  return { ...inc, totalHuf };
}

export function taxReminderText(ctx: Context): string | null {
  const year = ctx.at.getFullYear() - 1;
  const tax = taxableIncome(ctx, year);
  if (!tax) return null;
  const lines = [
    "🧾 <b>Szja-bevallás: május 20.</b>",
    `A TBSZ-en kívüli számláidon ${year}-ben:`,
  ];
  if (Math.abs(tax.realizedPlHuf) >= 1) lines.push(`• Realizált árfolyameredmény: ${sft(tax.realizedPlHuf)}`);
  if (tax.dividendHuf >= 1) lines.push(`• Osztalék: ${ft(tax.dividendHuf)}`);
  if (Math.abs(tax.interestHuf) >= 1) lines.push(`• Kamat: ${sft(tax.interestHuf)}`);
  const accs = ctx.summary.accounts
    .filter((a) => TAXABLE_KINDS.includes(a.account.kind))
    .map((a) => shortName(a.account.name));
  lines.push(
    `Számlák: ${accs.join(", ")}`,
    "",
    "<i>Ahol a bróker nem vonta le az adót (pl. külföldi brókernél), a jövedelmet magadnak kell bevallanod. A TBSZ és az állampapír-kamat nem tartozik ide.</i>",
  );
  return lines.join("\n");
}

// ---- news digest -------------------------------------------------------------

const IMPACT_ICON: Record<NewsImpact, string> = {
  up: "📈",
  down: "📉",
  mixed: "↕️",
  neutral: "➖",
};

/** How many items the Telegram digest lists (the app shows all). */
export const NEWS_TG_MAX = 5;
const NEWS_TG_MIN = 3;

/**
 * Today's market moves from the live quotes (not from the AI): EUR/HUF and
 * every held stock / ETF / fund, "EUR/HUF 392,40 (+0,21%) · VWCE +0,60%".
 * Only what traded today: before the open the last session's move is old news.
 */
export function newsMarketLine(ctx: Context): string {
  const parts: string[] = [];
  const eur = ctx.fx.EUR;
  if (eur) {
    const q = ctx.liveQuotes.EUR;
    const ch = q?.prevClose && q.price && quotedToday(q, ctx.at) ? ` (${pct(q.price / q.prevClose - 1, 2)})` : "";
    parts.push(`EUR/HUF ${eur.toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${ch}`);
  }
  const held = consolidatedHoldings(ctx.summary)
    .filter((h) => h.quantity > 1e-9 && ["etf", "stock", "fund"].includes(h.instrument?.type ?? ""))
    .sort((a, b) => b.marketValueHuf - a.marketValueHuf);
  for (const h of held) {
    const q = ctx.liveQuotes[h.instrumentKey];
    if (!q?.prevClose || !q.price || !quotedToday(q, ctx.at)) continue;
    const name = h.instrument?.ticker ? esc(h.instrument.ticker) : shortName(h.instrument?.name ?? h.instrumentKey);
    parts.push(`${name} ${pct(q.price / q.prevClose - 1, 2)}`);
  }
  return parts.join(" · ");
}

const EDITION_ICON: Record<NewsEdition, string> = { morning: "☀️", evening: "📰" };

/**
 * A digest on the phone: the headline, today's moves, the 3–5 most important
 * items (one line each), the coming events (the morning one: today's too), a
 * link to the app.
 */
export function newsText(
  digest: NewsDigest,
  ctx: Context,
  appUrl: string,
  uploadError?: string,
): string {
  const lines = [
    `${EDITION_ICON[digest.edition]} <b>${NEWS_EDITION_LABEL[digest.edition]} – ${dayLabel(digest.day)}</b>`,
    `<i>${esc(digest.headline)}</i>`,
  ];
  const market = newsMarketLine(ctx);
  if (market) lines.push(market);
  lines.push("");

  const ranked = rankedItems(digest.items);
  const important = ranked.filter((i) => i.importance >= 2);
  const shown = (important.length >= NEWS_TG_MIN ? important : ranked).slice(0, NEWS_TG_MAX);
  for (const it of shown) {
    const affects = it.affects.length ? ` <i>(${esc(it.affects.slice(0, 3).join(", "))})</i>` : "";
    lines.push(`${IMPACT_ICON[it.impact]} <b>${esc(it.title)}</b>${affects}`);
  }

  const today = toLocalDay(ctx.at);
  const tomorrow = addDaysIso(today, 1);
  const morning = digest.edition === "morning";
  const next = digest.upcoming
    .filter((u) => (morning ? u.date >= today : u.date > today))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, morning ? 3 : 2);
  if (next.length) {
    lines.push("");
    for (const u of next) {
      const when = u.date === today ? "Ma" : u.date === tomorrow ? "Holnap" : dayLabel(u.date).slice(6);
      lines.push(`🗓 ${when}: ${esc(u.event)}`);
    }
  }

  const more = digest.items.length - shown.length;
  lines.push(
    "",
    `<a href="${esc(appUrl)}#/hirek">Részletek az appban</a>${more > 0 ? ` (+${more} hír)` : ""}`,
  );
  if (uploadError)
    lines.push("", `⚠️ A felhőbe nem sikerült feltölteni, ezért az appban még nem látszik: ${esc(uploadError.slice(0, 200))}`);
  return lines.join("\n");
}

const ANALYSIS_STATUS_ICON = { rendben: "🟢", figyelj: "🟡", teendo: "🔴" } as const;

/**
 * The nightly AI analysis, short: the headline and what changed since the
 * last one. The cards are in the app (AI page).
 */
export function analysisText(a: NightlyAnalysis, appUrl: string, uploadError?: string): string {
  const d = a.data;
  const todo = d.sections.filter((s) => s.status === "teendo").length;
  const watch = d.sections.filter((s) => s.status === "figyelj").length;
  const lines = [
    `🧠 <b>AI-elemzés kész – ${dayLabel(a.day)}</b>`,
    `${ANALYSIS_STATUS_ICON[d.overall]} <i>${esc(d.headline)}</i>`,
    "",
    d.changes
      ? `<b>Mi változott:</b> ${esc(d.changes)}`
      : "<b>Mi változott:</b> nincs előző elemzés, amihez viszonyíthatnánk.",
  ];
  if (todo || watch)
    lines.push(
      "",
      [todo ? `🔴 ${todo} teendő` : "", watch ? `🟡 ${watch} figyelendő` : ""].filter(Boolean).join(" · "),
    );
  lines.push("", `<a href="${esc(appUrl)}#/ai">A teljes elemzés az appban</a>`);
  if (uploadError)
    lines.push("", `⚠️ A felhőbe nem sikerült feltölteni, ezért az appban még nem látszik: ${esc(uploadError.slice(0, 200))}`);
  return lines.join("\n");
}
