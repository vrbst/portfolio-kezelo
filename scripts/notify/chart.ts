// /chart: the dashboard's price cards as text — a two-session sparkline (the
// previous session, then today) in a <pre> block, picked from buttons.

import { consolidatedHoldings } from "../../src/lib/portfolio";
import { formatMoney } from "../../src/lib/format";
import { isCurveLive, lastSessionLabel, type LiveQuote } from "../../src/lib/prices";
import type { ChartCard } from "./chartImage";
import type { Context } from "./data";
import { esc, pct, px, shortName } from "./reports";

const LEVELS = "▁▂▃▄▅▆▇█";
/** Characters per session half; a phone's monospace row fits ~40. */
const HALF = 18;
const BAR_MS = 5 * 60_000;
/** Telegram's limit for a button's callback data. */
const MAX_DATA_BYTES = 64;

export const CHART_PREFIX = "chart:";

export interface ChartTarget {
  /** Instrument key, or the currency code ("EUR") for an FX card. */
  key: string;
  label: string;
}

export interface ChartButton {
  text: string;
  data: string;
}

/** Mean of `vals` in `n` equal slices (n is capped at vals.length). */
function resample(vals: number[], n: number): number[] {
  const m = Math.min(n, vals.length);
  const out: number[] = [];
  for (let i = 0; i < m; i++) {
    const slice = vals.slice(Math.floor((i * vals.length) / m), Math.floor(((i + 1) * vals.length) / m));
    out.push(slice.reduce((s, v) => s + v, 0) / slice.length);
  }
  return out;
}

const bars = (vals: number[], min: number, max: number) =>
  vals
    .map((v) => LEVELS[max === min ? 3 : Math.round(((v - min) / (max - min)) * (LEVELS.length - 1))])
    .join("");

/** The curve line: previous session │ today, on one shared scale. */
export function sparkline(q: LiveQuote): string {
  const today = q.intraday ?? [];
  const prev = q.prevDay ?? [];
  const all = [...prev, ...today];
  if (today.length < 2) return "";
  const min = Math.min(...all);
  const max = Math.max(...all);
  // Today fills its half by time: a half-finished day stays short. A borrowed
  // (24 h) curve or an unknown session counts as a whole day.
  const session = q.intradayFrom ? undefined : (q.chartSession ?? q.session);
  const fullDay = session
    ? Math.max(2, Math.round((session.end - session.start) / BAR_MS))
    : Math.max(prev.length, 288);
  const todayLen = Math.max(2, Math.round(HALF * Math.min(1, today.length / fullDay)));
  const left = prev.length >= 2 ? `${bars(resample(prev, HALF), min, max)}│` : "";
  return left + bars(resample(today, todayLen), min, max);
}

/** FX cards and the held securities that have an intraday curve. */
export function chartTargets(ctx: Context): ChartTarget[] {
  const held = consolidatedHoldings(ctx.summary)
    .filter((h) => h.quantity > 1e-9 && ["etf", "stock", "fund"].includes(h.instrument?.type ?? ""))
    .sort((a, b) => b.marketValueHuf - a.marketValueHuf);
  const fx = [
    "EUR",
    ...new Set(held.map((h) => h.currency).filter((c) => c !== "HUF" && c !== "EUR")),
  ].map((c): ChartTarget => ({ key: c, label: `${c}/HUF` }));
  const securities = held.map(
    (h): ChartTarget => ({
      key: h.instrumentKey,
      label: h.instrument?.ticker ?? h.instrument?.name ?? h.instrumentKey,
    }),
  );
  return [...fx, ...securities].filter(
    (t) =>
      (ctx.liveQuotes[t.key]?.intraday?.length ?? 0) >= 2 &&
      new TextEncoder().encode(CHART_PREFIX + t.key).length <= MAX_DATA_BYTES,
  );
}

/** Target by button key, or by what was typed (ticker / label / key, any case). */
export function findTarget(targets: ChartTarget[], query: string): ChartTarget | undefined {
  const q = query.trim().toLowerCase().replace(/\/huf$/, "");
  if (!q) return undefined;
  return targets.find((t) =>
    [t.key, t.label, t.label.replace(/\/HUF$/, "")].some((s) => s.toLowerCase() === q),
  );
}

/** Buttons for every target, three to a row; the open one is marked. */
export function chartButtons(targets: ChartTarget[], current?: string): ChartButton[][] {
  const rows: ChartButton[][] = [];
  targets.forEach((t, i) => {
    if (i % 3 === 0) rows.push([]);
    rows[rows.length - 1].push({
      text: `${t.key === current ? "▸ " : ""}${t.label}`,
      data: CHART_PREFIX + t.key,
    });
  });
  return rows;
}

export function chartMenuText(targets: ChartTarget[]): string {
  return targets.length
    ? "📈 <b>Melyik grafikont kéred?</b>"
    : "Most egyik papírnak sincs napközbeni görbéje (zárva a piac, vagy nem érhető el az élő adat).";
}

/** One card as text: title, change, the two-session curve, high / low. */
export function chartText(ctx: Context, target: ChartTarget): string {
  const q = ctx.liveQuotes[target.key];
  if (!q?.intraday || q.intraday.length < 2) return `Nincs napközbeni görbe: ${esc(target.label)}`;
  const inst = ctx.instMap.get(target.key);
  const isFx = !inst;
  const title = isFx ? target.label : shortName(inst?.ticker ?? inst?.name ?? target.key);
  const price = isFx
    ? `${q.price.toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Ft`
    : px(q.price, inst?.currency ?? "");
  const day = lastSessionLabel(q, ctx.at);
  const change = q.prevClose ? `${day ? `${day}: ` : "ma "}${pct(q.price / q.prevClose - 1, 2)}` : "";

  const today = q.intraday;
  const hi = Math.max(...today);
  const lo = Math.min(...today);
  const num = (n: number) => n.toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lines = [`📈 <b>${title}</b>  ${esc(price)}${change ? ` (${esc(change)})` : ""}`];
  const curve = sparkline(q);
  lines.push(`<pre>${q.prevDay && q.prevDay.length >= 2 ? "tegnap" + " ".repeat(HALF - 5) + "ma\n" : ""}${curve}</pre>`);
  const facts = [`max ${num(hi)}`, `min ${num(lo)}`];
  if (q.prevClose) facts.push(`előző zárás ${num(q.prevClose)}`);
  lines.push(facts.join(" · "));
  if (q.intradayFrom) lines.push(`<i>A görbe a(z) ${esc(q.intradayFrom)} alapján készült (ennek nincs napközbeni adata).</i>`);
  return lines.join("\n");
}

/** What the enlarged chart shows for a target — the same strings as the dashboard card. */
export function chartCard(ctx: Context, target: ChartTarget): ChartCard | undefined {
  const quote = ctx.liveQuotes[target.key];
  if (!quote?.intraday || quote.intraday.length < 2) return undefined;
  const inst = ctx.instMap.get(target.key);
  const live = isCurveLive(quote, ctx.at.getTime());
  const now = ctx.at;
  if (!inst) {
    const rate = ctx.fx[target.key] ?? quote.price;
    return {
      title: target.label,
      value: formatMoney(rate, "HUF", { decimals: 2 }),
      sub: target.key === "EUR" ? "Euró árfolyam" : undefined,
      quote,
      live,
      now,
    };
  }
  const price = ctx.prices.get(target.key) ?? quote.price;
  const label = inst.ticker ?? inst.name;
  const sub = inst.ticker ? inst.name : undefined;
  const rate = inst.currency === "HUF" ? 1 : ctx.fx[inst.currency];
  return {
    title: sub && sub !== label ? `${label} · ${sub}` : label,
    value: formatMoney(price, inst.currency, { decimals: 2 }),
    sub: inst.currency !== "HUF" && rate ? `≈ ${formatMoney(price * rate, "HUF")}` : undefined,
    quote,
    live,
    now,
  };
}

/** The image's caption: title, price and the day's change (the chart has the rest). */
export function chartCaption(card: ChartCard): string {
  const q = card.quote;
  const day = lastSessionLabel(q, card.now);
  const change = q.prevClose ? ` (${day ? `${day}: ` : "ma "}${pct(q.price / q.prevClose - 1, 2)})` : "";
  return `📈 <b>${esc(card.title)}</b>\n${esc(card.value)}${esc(change)}`;
}
