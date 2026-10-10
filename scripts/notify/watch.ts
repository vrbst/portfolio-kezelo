import { consolidatedHoldings } from "../../src/lib/portfolio";
import { toLocalDay } from "../../src/lib/day";
import type { Context } from "./data";
import type { State } from "./state";
import { dayLabel, esc, ft, mft, sft, shortName } from "./reports";

export const GOAL_STEPS = 4;

export function goalMilestoneMessages(ctx: Context, st: State): string[] {
  const prev = st.goalLevels ?? {};
  const next: Record<string, number> = {};
  const out: string[] = [];
  for (const p of ctx.savings) {
    const id = p.goal.id;
    const lv = Math.floor(Math.min(Math.max(p.progressPct, 0), 1) * GOAL_STEPS + 1e-9);
    const sent = prev[id];
    next[id] = Math.max(lv, sent ?? lv);
    if (sent == null || lv <= sent) continue;
    const now = `${Math.round(p.progressPct * 100)}%, ${ft(p.assignedValueHuf)} / ${ft(p.targetHuf)}`;
    out.push(
      lv >= GOAL_STEPS
        ? `🏁 <b>${esc(p.goal.name)}: összegyűlt a teljes összeg</b> (${now})`
        : `🎯 <b>${esc(p.goal.name)}: ${Math.round((lv / GOAL_STEPS) * 100)}%-nál jár</b> (most ${now}; határidő: ${dayLabel(p.goal.targetDate)})`,
    );
  }
  st.goalLevels = next;
  return out;
}

export type WealthKind = "wealthPeak" | "drawdown";

export function wealthMessages(
  ctx: Context,
  st: State,
  env: { wealthStepHuf: number; drawdownStepPct: number },
): string[] {
  return wealthEvents(ctx, st, env).map((e) => e.text);
}

/** The wealth messages with their type (so each can be switched off); advances `st` either way. */
export function wealthEvents(
  ctx: Context,
  st: State,
  env: { wealthStepHuf: number; drawdownStepPct: number },
): { kind: WealthKind; text: string }[] {
  const s = ctx.summary;
  if (s.missingFxCcys.length || !(s.totalValueHuf > 0)) return [];
  const value = s.totalValueHuf;
  const pl = s.totalPlHuf;
  const today = toLocalDay(ctx.at);
  const step = Math.floor(value / env.wealthStepHuf);
  const w = st.wealth;
  if (!w) {
    st.wealth = { step, peakPl: pl, peakValue: value, peakDay: today, drawdown: 0 };
    return [];
  }
  const out: { kind: WealthKind; text: string }[] = [];
  if (step > w.step) {
    w.step = step;
    out.push({
      kind: "wealthPeak",
      text: `🎉 <b>Átlépted a ${ft(step * env.wealthStepHuf)}-ot</b>\nVagyon: ${ft(value)}`,
    });
  }
  if (pl >= w.peakPl) {
    if (w.drawdown > 0)
      out.push({
        kind: "drawdown",
        text: `🏔 <b>Visszajött a visszaesés</b>: az összes eredmény (${sft(pl)}) ismét csúcson van.\nVagyon: ${ft(value)}`,
      });
    Object.assign(w, { peakPl: pl, peakValue: value, peakDay: today, drawdown: 0 });
    return out;
  }
  const lossHuf = w.peakPl - pl;
  const ddPct = lossHuf / w.peakValue;
  const lv = Math.floor((ddPct * 100 + 1e-9) / env.drawdownStepPct);
  if (lv > w.drawdown) {
    w.drawdown = lv;
    out.push({
      kind: "drawdown",
      text: `📉 <b>Visszaesés a csúcstól: −${(ddPct * 100).toFixed(1).replace(".", ",")}%</b> (−${ft(lossHuf)} piaci eredmény a csúcs, ${dayLabel(w.peakDay)} óta)\nVagyon: ${ft(value)}`,
    });
  }
  return out;
}

export const STALE_PRICE_DAYS = 7;
const STALE_REPEAT_HOURS = 24 * 7;

const dayDiff = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function stalePriceMessage(ctx: Context, st: State): string | null {
  const now = ctx.at;
  const today = toLocalDay(now);
  const fileAgeDays = ctx.priceFile?.updatedAt
    ? (now.getTime() - Date.parse(ctx.priceFile.updatedAt)) / 86_400_000
    : Infinity;
  if (fileAgeDays > 4) return null;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const h of consolidatedHoldings(ctx.summary)) {
    if (h.quantity <= 1e-9 || !["etf", "stock", "fund"].includes(h.instrument?.type ?? "")) continue;
    const key = `price:${h.instrumentKey}`;
    seen.add(key);
    const q = ctx.liveQuotes[h.instrumentKey];
    const hist = ctx.history?.prices[h.instrumentKey];
    const days = [
      q ? (q.marketTime != null ? toLocalDay(q.marketTime) : today) : undefined,
      hist?.length ? hist[hist.length - 1][0] : undefined,
    ].filter((d): d is string => d != null);
    const last = days.sort().at(-1);
    const age = last ? dayDiff(last, today) : Infinity;
    if (age <= STALE_PRICE_DAYS) {
      delete st.warned[key];
      continue;
    }
    const warnedAt = st.warned[key];
    if (warnedAt && (now.getTime() - Date.parse(warnedAt)) / 3_600_000 <= STALE_REPEAT_HOURS) continue;
    st.warned[key] = now.toISOString();
    const name = shortName(h.instrument?.name ?? h.instrumentKey);
    lines.push(
      last
        ? `• ${name}: ${age} napja nincs új ár (utolsó: ${dayLabel(last)}; pozíció: ${mft(h.marketValueHuf)})`
        : `• ${name}: nincs árfolyama (pozíció: ${mft(h.marketValueHuf)})`,
    );
  }
  for (const k of Object.keys(st.warned))
    if (k.startsWith("price:") && !seen.has(k)) delete st.warned[k];
  if (!lines.length) return null;
  return [
    "❓ <b>Elavult árfolyam</b>",
    ...lines,
    "",
    "Tickerváltás vagy kivezetés lehet. Az appban szimbólum-felülírást vagy kézi árat állíthatsz be, addig a vagyon ezzel az árral számol.",
  ].join("\n");
}
