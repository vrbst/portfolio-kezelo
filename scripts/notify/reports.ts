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
import { bandBaseNote, positionsFromSummary } from "../../src/lib/rebalance";
import {
  buildMonthlyPlan,
  computePlanNeeds,
  defaultPlanAmount,
  planTextLines,
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
import type { Context } from "./data";
import { esc } from "./telegram";

// ---- formatting -----------------------------------------------------------

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
const dayLabel = (iso: string) => {
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
          (p.reached
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
  return lines.join("\n");
}

/**
 * This month's plan for the saving — the same Havi terv the Teendők panel
 * shows (default amount: the monthly budget minus what goals already got).
 */
function monthlyPlanLines(ctx: Context): string[] {
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
  const plan = buildMonthlyPlan({
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

  // Glide path: bucket weights vs. today's path target and band.
  if (ctx.glide?.buckets.length) {
    const icon = { within: "✅", below: "⬇️", above: "⬆️", empty: "▫️" };
    const p = (v: number) => `${Math.round(v * 100)}%`;
    lines.push("", "<b>Célpálya (tény / pálya, sáv)</b>");
    for (const b of ctx.glide.buckets)
      lines.push(
        `${icon[b.status]} ${esc(b.bucket.name)}: ${p(b.weight)} / ${p(b.target)} (${p(b.low)}–${p(b.high)}${bandBaseNote(b) ? `, ${esc(bandBaseNote(b))}` : ""}; ${sft(b.valueHuf - b.target * ctx.glide.totalHuf)})`,
      );
  }
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

export const HELP = [
  "🤖 <b>Portfolio Tracker</b>",
  "",
  "/allas – aktuális vagyon, napi változás",
  "/teendok – aktív figyelmeztetések",
  "/esemenyek – következő 30 nap (kupon, lejárat, TBSZ)",
  "/cel – célok állása",
  "/elorejelzes – 1–20 éves előrejelzés",
  "/heti – heti összefoglaló most",
  "/havi – előző havi zárás most",
  "/maradek 50000 – hová menjen a hónapban megmaradt pénz",
  "",
  "Magamtól szólok: új teendőnél, nagy napi mozgásnál, vasárnap este heti, a hónap elején havi jelentéssel, a hónap utolsó munkanapján a maradékért.",
].join("\n");
