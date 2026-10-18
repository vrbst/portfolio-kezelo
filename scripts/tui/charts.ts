// The terminal charts: each builder turns the bot's Context into plain data
// (lines / bars + captions) that ChartsView draws. Pure, so it is testable.
// Personal amounts go through `money`, which prints a mask in privacy mode;
// shapes and percentages stay visible, like the web app's masked axes.

import type { Context } from "../notify/data";
import { forecastFor, ft, mft, pct, px, sft } from "../notify/reports";
import { addDaysIso, toLocalDay, todayLocal, txDay } from "../../src/lib/day";
import { latestConfig, loadGlideVersions } from "../../src/lib/glidePath";
import { liveGlideVersions } from "../../src/lib/flowPath";
import { checkDays, positionsFromSummary, weightHistory } from "../../src/lib/rebalance";
import { reservedCashByAccount, loadSavingsGoals } from "../../src/lib/savings";
import { summariesOnDays } from "../../src/lib/series";
import { consolidatedHoldings } from "../../src/lib/portfolio";
import {
  BENCHMARK,
  benchmarkIndex,
  computeReturns,
  monthlyPerformance,
} from "../../src/lib/returns";
import { detailByAccount, detailByClass, detailByCurrency } from "../../src/lib/allocationDetail";
import { CHART_RANGES } from "./ranges";
import { name, HIDDEN, MASK } from "./text";
import type { Bar, HBar, LineSeries } from "./plot";

export const CHART_IDS = [
  "value",
  "accounts",
  "profit",
  "twr",
  "drawdown",
  "monthly",
  "deposits",
  "payouts",
  "daily",
  "forecast",
  "glide",
  "alloc",
  "price",
] as const;
export type ChartId = (typeof CHART_IDS)[number];

export const CHART_TITLES: Record<ChartId, string> = {
  value: "Vagyon",
  accounts: "Számlák",
  profit: "Eredmény",
  twr: "Hozam",
  drawdown: "Esés",
  monthly: "Havi hozam",
  deposits: "Befizetés",
  payouts: "Kifizetés",
  daily: "Napi",
  forecast: "Előrejelzés",
  glide: "Pálya",
  alloc: "Allokáció",
  price: "Árfolyam",
};

/** Which controls a chart answers to (shown in the help line). */
export const CHART_CONTROLS: Record<ChartId, string> = {
  value: "t: időszak",
  accounts: "t: időszak",
  profit: "t: időszak",
  twr: "t: időszak",
  drawdown: "t: időszak",
  monthly: "",
  deposits: "",
  payouts: "",
  daily: "",
  forecast: "t: horizont",
  glide: "t: időszak",
  alloc: "m: nézet",
  price: "t: időszak · ↑/↓: papír",
};

export const FORECAST_YEARS = [1, 3, 5, 10, 20] as const;
export const ALLOC_MODES = ["class", "currency", "account"] as const;
const ALLOC_LABEL = { class: "eszköztípus", currency: "deviza", account: "számla" } as const;

export interface ChartOptions {
  /** Index into CHART_RANGES (time series) or FORECAST_YEARS (forecast). */
  range: number;
  /** Index into ALLOC_MODES. */
  mode: number;
  /** Which holding the price chart shows. */
  pick: number;
  hide: boolean;
  /** Characters available for bars (monthly / daily). */
  columns: number;
}

export interface Legend {
  name: string;
  color: string;
}

export type ChartData =
  | { kind: "empty"; title: string; message: string }
  | {
      kind: "line";
      title: string;
      series: LineSeries[];
      legend: Legend[];
      /** Axis label for a value (masked in privacy mode when it is an amount). */
      yLabel: (v: number) => string;
      domain?: [number, number];
      xFirst: string;
      xLast: string;
      summary: string[];
    }
  | {
      kind: "vbars";
      title: string;
      bars: Bar[];
      xFirst: string;
      xLast: string;
      summary: string[];
    }
  | { kind: "hbars"; title: string; items: HBar[]; summary: string[] };

const empty = (title: string, message = "Nincs elég adat ehhez a grafikonhoz."): ChartData => ({
  kind: "empty",
  title,
  message,
});

const money = (hide: boolean) => (n: number, f: (n: number) => string = ft) => (hide ? HIDDEN : f(n));
const signed = (hide: boolean, n: number) => (hide ? MASK : sft(n));

const from = (range: number) => {
  const days = CHART_RANGES[range % CHART_RANGES.length].days;
  return days ? addDaysIso(todayLocal(), -days) : "";
};
const rangeLabel = (range: number) => CHART_RANGES[range % CHART_RANGES.length].label;

const colors = {
  value: "cyan",
  invested: "yellow",
  good: "green",
  bad: "red",
  muted: "gray",
  bench: "yellow",
} as const;
const PALETTE = ["cyan", "green", "yellow", "magenta", "blue", "red", "white"] as const;

/** "YYYY-MM" of a local "YYYY-MM-DD" day. */
const monthOf = (day: string) => day.slice(0, 7);

/** A share, without a sign: 0.523 -> "52,3%". */
const share = (x: number, d = 1) => `${(x * 100).toFixed(d).replace(".", ",")}%`;

const sign = (x: number) => (x >= 0 ? colors.good : colors.bad);

function twrWindow(ctx: Context, range: number) {
  const r = computeReturns(
    ctx.summary.accounts.map((a) => a.account),
    ctx.transactions,
    ctx.instMap,
    ctx.prices,
    ctx.fx,
    ctx.history,
    ctx.at,
  );
  const dates = r.twrIndex.map((p) => p.date);
  const bench = benchmarkIndex(ctx.history, dates);
  const cutoff = from(range);
  const idx = r.twrIndex.map((_, i) => i).filter((i) => r.twrIndex[i].date >= cutoff);
  return { r, bench, idx };
}

const rebase = (cum: number[]) => {
  const base = 1 + cum[0];
  return cum.map((c) => (1 + c) / base - 1);
};

function valueChart(ctx: Context, o: ChartOptions): ChartData {
  const title = `Vagyon és befektetett tőke – ${rangeLabel(o.range)}`;
  const pts = ctx.series.filter((p) => p.date >= from(o.range));
  if (pts.length < 2) return empty(title);
  const m = money(o.hide);
  const last = pts[pts.length - 1];
  const first = pts[0];
  return {
    kind: "line",
    title,
    series: [
      { values: pts.map((p) => p.invested), color: colors.invested },
      { values: pts.map((p) => p.value), color: colors.value },
    ],
    legend: [
      { name: "érték", color: colors.value },
      { name: "befektetett tőke", color: colors.invested },
    ],
    yLabel: (v) => (o.hide ? MASK : mft(v)),
    xFirst: first.date,
    xLast: last.date,
    summary: [
      `Most: ${m(last.value)} · befektetve: ${m(last.invested)}`,
      `Piaci eredmény az időszakban: ${signed(o.hide, last.value - last.invested - (first.value - first.invested))} (a befizetések nélkül)`,
    ],
  };
}

/** Each account's value over the range (sampled, at most ~90 points). */
function accountsChart(ctx: Context, o: ChartOptions): ChartData {
  const title = `Számlák értéke – ${rangeLabel(o.range)}`;
  const days = ctx.series.map((p) => p.date).filter((d) => d >= from(o.range));
  if (days.length < 2) return empty(title);
  const step = Math.ceil(days.length / 90);
  const sampled = days.filter((_, i) => i % step === 0 || i === days.length - 1);
  const accounts = ctx.summary.accounts.map((a) => a.account);
  const samples = summariesOnDays(accounts, ctx.transactions, ctx.instMap, ctx.fx, ctx.history, sampled);
  const live = ctx.summary.accounts.filter((a) => Math.abs(a.totalValueHuf) >= 1);
  if (!live.length) return empty(title);
  // The last point is today at live prices (like the value series), the rest day-end marks.
  const valueOf = (day: number, id: string) =>
    (day === samples.length - 1 ? ctx.summary : samples[day].summary).accounts.find((a) => a.account.id === id)
      ?.totalValueHuf ?? 0;
  const m = money(o.hide);
  return {
    kind: "line",
    title,
    series: live.map((a, i) => ({
      values: samples.map((_, d) => valueOf(d, a.account.id)),
      color: PALETTE[i % PALETTE.length],
    })),
    legend: live.map((a, i) => ({ name: name(a.account.name), color: PALETTE[i % PALETTE.length] })),
    yLabel: (v) => (o.hide ? MASK : mft(v)),
    xFirst: sampled[0],
    xLast: sampled[sampled.length - 1],
    summary: live.map((a) => `${name(a.account.name)}: ${m(a.totalValueHuf, mft)}`),
  };
}

function profitChart(ctx: Context, o: ChartOptions): ChartData {
  const title = `Összes eredmény (érték − befektetett tőke) – ${rangeLabel(o.range)}`;
  const pts = ctx.series.filter((p) => p.date >= from(o.range));
  if (pts.length < 2) return empty(title);
  const v = pts.map((p) => p.value - p.invested);
  const last = v[v.length - 1];
  return {
    kind: "line",
    title,
    series: [{ values: v, color: sign(last - v[0]) }],
    legend: [{ name: "eredmény", color: sign(last - v[0]) }],
    yLabel: (x) => (o.hide ? MASK : mft(x)),
    xFirst: pts[0].date,
    xLast: pts[pts.length - 1].date,
    summary: [
      `Most: ${signed(o.hide, last)} · az időszak elején: ${signed(o.hide, v[0])}`,
      `Változás az időszakban: ${signed(o.hide, last - v[0])}`,
    ],
  };
}

function twrChart(ctx: Context, o: ChartOptions): ChartData {
  const title = `Idősúlyozott hozam (TWR) a mércével – ${rangeLabel(o.range)}`;
  const { r, bench, idx } = twrWindow(ctx, o.range);
  if (idx.length < 2) return empty(title);
  const port = rebase(idx.map((i) => r.twrIndex[i].cum));
  const b = bench ? rebase(idx.map((i) => bench[i])) : null;
  const benchOk = b && b.every(Number.isFinite);
  const series: LineSeries[] = [];
  const legend: Legend[] = [];
  if (benchOk) {
    series.push({ values: b, color: colors.bench });
    legend.push({ name: BENCHMARK.label, color: colors.bench });
  }
  series.push({ values: port, color: colors.value });
  legend.push({ name: "portfólió", color: colors.value });
  return {
    kind: "line",
    title,
    series,
    legend,
    yLabel: (v) => pct(v, 1),
    xFirst: r.twrIndex[idx[0]].date,
    xLast: r.twrIndex[idx[idx.length - 1]].date,
    summary: [
      `Portfólió: ${pct(port[port.length - 1], 1)}${benchOk ? ` · ${BENCHMARK.label}: ${pct(b[b.length - 1], 1)}` : ""}`,
    ],
  };
}

function drawdownChart(ctx: Context, o: ChartOptions): ChartData {
  const title = `Esés az addigi csúcstól (TWR-ből, a befizetések nélkül) – ${rangeLabel(o.range)}`;
  const { r, idx } = twrWindow(ctx, o.range);
  if (idx.length < 2) return empty(title);
  const index = rebase(idx.map((i) => r.twrIndex[i].cum)).map((c) => 1 + c);
  let peak = 0;
  const dd = index.map((x) => {
    peak = Math.max(peak, x);
    return x / peak - 1;
  });
  const worst = Math.min(...dd);
  return {
    kind: "line",
    title,
    series: [{ values: dd, color: colors.bad }],
    legend: [{ name: "esés", color: colors.bad }],
    yLabel: (v) => pct(v, 1),
    domain: [Math.min(worst, -0.005), 0],
    xFirst: r.twrIndex[idx[0]].date,
    xLast: r.twrIndex[idx[idx.length - 1]].date,
    summary: [`Legnagyobb esés: ${pct(worst, 1)} · most: ${pct(dd[dd.length - 1], 1)} a csúcs alatt`],
  };
}

function monthlyChart(ctx: Context, o: ChartOptions): ChartData {
  const title = "Havi idősúlyozott hozam";
  const { r, bench } = twrWindow(ctx, 3);
  const months = monthlyPerformance(r.twrIndex, ctx.series, bench).slice(-Math.max(1, Math.floor(o.columns / 2)));
  if (months.length < 2) return empty(title);
  const best = months.reduce((a, b) => (b.twr > a.twr ? b : a));
  const worst = months.reduce((a, b) => (b.twr < a.twr ? b : a));
  const up = months.filter((x) => x.twr >= 0).length;
  return {
    kind: "vbars",
    title,
    bars: months.map((x) => ({ value: x.twr, color: sign(x.twr) })),
    xFirst: months[0].month,
    xLast: months[months.length - 1].month,
    summary: [
      `Legjobb: ${best.month} ${pct(best.twr, 1)} · legrosszabb: ${worst.month} ${pct(worst.twr, 1)}`,
      `${up} pozitív hónap a ${months.length}-ből · utolsó: ${pct(months[months.length - 1].twr, 1)}${months[months.length - 1].current ? " (folyamatban)" : ""}`,
    ],
  };
}

function depositsChart(ctx: Context, o: ChartOptions): ChartData {
  const title = "Havi nettó befizetés";
  const endOf = new Map<string, number>();
  for (const p of ctx.series) endOf.set(monthOf(p.date), p.invested);
  const keys = [...endOf.keys()].sort();
  const delta = keys.map((k, i) => ({ month: k, v: endOf.get(k)! - (i ? endOf.get(keys[i - 1])! : 0) }));
  const shown = delta.slice(-Math.max(1, Math.floor(o.columns / 2)));
  if (shown.length < 2) return empty(title);
  const m = money(o.hide);
  const sum = shown.reduce((s, x) => s + x.v, 0);
  return {
    kind: "vbars",
    title,
    bars: shown.map((x) => ({ value: x.v, color: x.v >= 0 ? colors.value : colors.bad })),
    xFirst: shown[0].month,
    xLast: shown[shown.length - 1].month,
    summary: [
      `Az időszakban összesen: ${o.hide ? HIDDEN : ft(sum)} · havi átlag: ${m(sum / shown.length)}`,
      `Utolsó hónap: ${m(shown[shown.length - 1].v)}`,
    ],
  };
}

/** Coupons and redemptions the bonds will pay in each of the next 12 months. */
function payoutsChart(ctx: Context, o: ChartOptions): ChartData {
  const title = "Várható kamat- és lejárat-kifizetések, következő 12 hónap";
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(ctx.at.getFullYear(), ctx.at.getMonth() + i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const coupon = new Map<string, number>();
  const maturity = new Map<string, number>();
  for (const e of ctx.events) {
    if (!e.amountHuf || (e.kind !== "coupon" && e.kind !== "maturity")) continue;
    const m = monthOf(e.date);
    const into = e.kind === "coupon" ? coupon : maturity;
    into.set(m, (into.get(m) ?? 0) + e.amountHuf);
  }
  const total = (m: string) => (coupon.get(m) ?? 0) + (maturity.get(m) ?? 0);
  if (!months.some((m) => total(m) > 0)) return empty(title, "Nincs közelgő kamat- vagy lejárat-kifizetés.");
  const money_ = money(o.hide);
  const sum = (mp: Map<string, number>) => months.reduce((a, m) => a + (mp.get(m) ?? 0), 0);
  const top = months.reduce((a, m) => (total(m) > total(a) ? m : a));
  return {
    kind: "vbars",
    title,
    bars: months.map((m) => ({ value: total(m), color: maturity.get(m) ? colors.invested : colors.value })),
    xFirst: months[0],
    xLast: months[months.length - 1],
    summary: [
      `Kamat: ${money_(sum(coupon))} (kék) · lejárat: ${money_(sum(maturity))} (sárga: abban a hónapban lejárat is van)`,
      `Legnagyobb hónap: ${top} ${money_(total(top))}`,
    ],
  };
}

function dailyChart(ctx: Context, o: ChartOptions): ChartData {
  const title = "Napi piaci mozgás (a befizetések nélkül)";
  const s = ctx.series;
  const days: { date: string; v: number }[] = [];
  for (let i = 1; i < s.length; i++) {
    if (!s[i - 1].value) continue;
    days.push({
      date: s[i].date,
      v: (s[i].value - s[i].invested - (s[i - 1].value - s[i - 1].invested)) / s[i - 1].value,
    });
  }
  const shown = days.slice(-Math.max(1, Math.floor(o.columns / 2)));
  if (shown.length < 2) return empty(title);
  const best = shown.reduce((a, b) => (b.v > a.v ? b : a));
  const worst = shown.reduce((a, b) => (b.v < a.v ? b : a));
  return {
    kind: "vbars",
    title,
    bars: shown.map((x) => ({ value: x.v, color: sign(x.v) })),
    xFirst: shown[0].date,
    xLast: shown[shown.length - 1].date,
    summary: [
      `Legjobb nap: ${best.date} ${pct(best.v, 2)} · legrosszabb: ${worst.date} ${pct(worst.v, 2)}`,
      `Utolsó nap: ${pct(shown[shown.length - 1].v, 2)}`,
    ],
  };
}

function forecastChart(ctx: Context, o: ChartOptions): ChartData {
  const years = FORECAST_YEARS[o.range % FORECAST_YEARS.length];
  const title = `Előrejelzés (névleges Ft) – ${years} év`;
  const { result } = forecastFor(ctx);
  const pts = result.points.slice(0, years * 12 + 1);
  if (pts.length < 2) return empty(title);
  const last = pts[pts.length - 1];
  const m = money(o.hide);
  return {
    kind: "line",
    title,
    series: [
      { values: pts.map((p) => p.contributed), color: colors.muted },
      { values: pts.map((p) => p.pess), color: colors.bad },
      { values: pts.map((p) => p.opt), color: colors.good },
      { values: pts.map((p) => p.real), color: colors.value },
    ],
    legend: [
      { name: "reális", color: colors.value },
      { name: "pesszimista", color: colors.bad },
      { name: "optimista", color: colors.good },
      { name: "befizetett tőke", color: colors.muted },
    ],
    yLabel: (v) => (o.hide ? MASK : mft(v)),
    xFirst: pts[0].month,
    xLast: last.month,
    summary: [
      `${last.month}: reális ${m(last.real, mft)} · sáv ${m(last.pess, mft)} – ${m(last.opt, mft)}`,
    ],
  };
}

function glideChart(ctx: Context, o: ChartOptions): ChartData {
  const title = `Célpálya: a súlyok az időben – ${rangeLabel(o.range)}`;
  const versions = loadGlideVersions();
  const cfg = latestConfig(versions);
  if (!cfg || !ctx.transactions.length) return empty(title, "Nincs beállított célpálya.");
  const today = toLocalDay(ctx.at.getTime());
  const accounts = ctx.summary.accounts.map((a) => a.account);
  const live = liveGlideVersions(versions, {
    accounts,
    transactions: ctx.transactions,
    instruments: ctx.instMap,
    fx: ctx.fx,
    history: ctx.history,
    summary: ctx.summary,
    today,
    reserved: reservedCashByAccount(loadSavingsGoals(), today),
  });
  const first = ctx.transactions.reduce((m, t) => (t.date < m ? t.date : m), ctx.transactions[0].date);
  // Month starts over the whole ledger history, then today at live prices.
  const days = checkDays("monthly", txDay(first), today).filter((d) => d < today);
  const samples = new Map(
    summariesOnDays(accounts, ctx.transactions, ctx.instMap, ctx.fx, ctx.history, days).map((x) => [x.day, x]),
  );
  const history = weightHistory(live, [...days, today], (day, atFace) => {
    const x = samples.get(day);
    return x
      ? positionsFromSummary(x.summary, x.fx, atFace, day)
      : positionsFromSummary(ctx.summary, ctx.fx, atFace, day);
  }).filter((p) => p.day >= from(o.range));
  if (history.length < 2) return empty(title);
  const latest = history[history.length - 1];
  const buckets = latestConfig(live)!.buckets.filter((b) => latest.buckets[b.id]);
  if (!buckets.length) return empty(title);
  const statusText = { below: "sáv alatt", within: "sávban", above: "sáv felett", empty: "üres" } as const;
  return {
    kind: "line",
    title,
    series: buckets.map((b, i) => ({
      values: history.map((p) => p.buckets[b.id]?.weight ?? NaN),
      color: PALETTE[i % PALETTE.length],
    })),
    legend: buckets.map((b, i) => ({ name: name(b.name), color: PALETTE[i % PALETTE.length] })),
    yLabel: (v) => share(v, 0),
    xFirst: history[0].day,
    xLast: latest.day,
    summary: buckets.map((b) => {
      const w = latest.buckets[b.id];
      return `${name(b.name)}: ${share(w.weight)} · cél ${share(w.target)} (sáv ${share(w.low)} – ${share(w.high)}) · ${statusText[w.status]}`;
    }),
  };
}

function allocChart(ctx: Context, o: ChartOptions): ChartData {
  const mode = ALLOC_MODES[o.mode % ALLOC_MODES.length];
  const title = `Allokáció – ${ALLOC_LABEL[mode]}`;
  const slices =
    mode === "class"
      ? detailByClass(ctx.summary)
      : mode === "currency"
        ? detailByCurrency(ctx.summary, ctx.fx)
        : detailByAccount(ctx.summary);
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!slices.length || total <= 0) return empty(title);
  const m = money(o.hide);
  const items: HBar[] = [...slices]
    .sort((a, b) => b.value - a.value)
    .map((s, i) => ({
      label: name(s.name),
      value: s.value,
      color: PALETTE[i % PALETTE.length],
      note: `${((s.value / total) * 100).toFixed(1).replace(".", ",")}% · ${m(s.value, mft)}`,
    }));
  return { kind: "hbars", title, items, summary: [`Összesen: ${m(total)}`] };
}

/** Holdings that have a price history to draw. */
export function priceHoldings(ctx: Context) {
  return consolidatedHoldings(ctx.summary)
    .filter((h) => (ctx.history?.prices[h.instrumentKey]?.length ?? 0) > 1)
    .sort((a, b) => b.marketValueHuf - a.marketValueHuf);
}

function priceChart(ctx: Context, o: ChartOptions): ChartData {
  const list = priceHoldings(ctx);
  if (!list.length) return empty("Árfolyam", "Egyik pozícióhoz sincs árfolyam-előzmény.");
  const at = ((o.pick % list.length) + list.length) % list.length;
  const h = list[at];
  const label = name(h.instrument?.name ?? h.instrumentKey);
  const title = `${label} árfolyama – ${rangeLabel(o.range)} (${at + 1}/${list.length})`;
  const cutoff = from(o.range);
  const pts = (ctx.history?.prices[h.instrumentKey] ?? []).filter(([d]) => d >= cutoff);
  if (pts.length < 2) return empty(title);
  const ccy = h.currency;
  const v = pts.map(([, p]) => p);
  const change = v[v.length - 1] / v[0] - 1;
  return {
    kind: "line",
    title,
    series: [{ values: v, color: sign(change) }],
    legend: [{ name: `${ccy}-ben`, color: sign(change) }],
    yLabel: (x) => px(x, ccy),
    xFirst: pts[0][0],
    xLast: pts[pts.length - 1][0],
    summary: [
      `Utolsó: ${px(v[v.length - 1], ccy)} · változás: ${pct(change, 1)}`,
      `Minimum: ${px(Math.min(...v), ccy)} · maximum: ${px(Math.max(...v), ccy)}`,
    ],
  };
}

export function buildChart(id: ChartId, ctx: Context, o: ChartOptions): ChartData {
  switch (id) {
    case "value":
      return valueChart(ctx, o);
    case "accounts":
      return accountsChart(ctx, o);
    case "profit":
      return profitChart(ctx, o);
    case "twr":
      return twrChart(ctx, o);
    case "drawdown":
      return drawdownChart(ctx, o);
    case "monthly":
      return monthlyChart(ctx, o);
    case "deposits":
      return depositsChart(ctx, o);
    case "payouts":
      return payoutsChart(ctx, o);
    case "daily":
      return dailyChart(ctx, o);
    case "forecast":
      return forecastChart(ctx, o);
    case "glide":
      return glideChart(ctx, o);
    case "alloc":
      return allocChart(ctx, o);
    case "price":
      return priceChart(ctx, o);
  }
}
