// The tabs of the terminal view. Every personal amount goes through `money`
// and every goal name through `priv`, so the privacy toggle hides them all.

import { Box, Text } from "ink";
import type { Context } from "../notify/data";
import { dayLabel, ft, mft, pct, sft, shortName } from "../notify/reports";
import { consolidatedHoldings } from "../../src/lib/portfolio";
import { addDaysIso, todayLocal } from "../../src/lib/day";
import { sparkline } from "./spark";
import { CHART_RANGES } from "./ranges";

const HIDDEN = "•••• Ft";
const MASK = "••••";

const name = (s: string) =>
  shortName(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const makeMoney = (hide: boolean) => (n: number, f: (n: number) => string = ft) =>
  hide ? HIDDEN : f(n);
const makePriv = (hide: boolean) => (s: string) => (hide ? MASK : s);

const dayColor = (x: number) => (x >= 0 ? "green" : "red");

export function Overview({ ctx, hide }: { ctx: Context; hide: boolean }) {
  const s = ctx.summary;
  const money = makeMoney(hide);
  const top = consolidatedHoldings(s)
    .sort((a, b) => b.marketValueHuf - a.marketValueHuf)
    .slice(0, 8);
  const dc = ctx.dayChange;
  return (
    <Box flexDirection="column">
      <Text bold>Portfólió – {money(s.totalValueHuf)}</Text>
      {dc && (
        <Text color={dayColor(dc.abs)}>
          {dc.note}: {hide ? MASK : sft(dc.abs)} ({pct(dc.pct, 2)})
        </Text>
      )}
      <Text>
        Összes eredmény: {hide ? MASK : sft(s.totalPlHuf)} ({pct(s.totalReturnPct)})
      </Text>
      <Text>Befektetett tőke: {money(s.netDepositedHuf)}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Számlák</Text>
        {s.accounts
          .filter((a) => Math.abs(a.totalValueHuf) >= 1)
          .map((a) => (
            <Text key={a.account.id}>
              • {name(a.account.name)}: {money(a.totalValueHuf, mft)}
            </Text>
          ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Legnagyobb pozíciók</Text>
        {top.map((h) => {
          const q = ctx.liveQuotes[h.instrumentKey];
          const day = q?.prevClose && q.price ? q.price / q.prevClose - 1 : undefined;
          return (
            <Text key={h.instrumentKey}>
              • {name(h.instrument?.name ?? h.instrumentKey)}: {money(h.marketValueHuf, mft)}
              {day != null && <Text color={dayColor(day)}> (ma {pct(day)})</Text>}
            </Text>
          );
        })}
      </Box>
      {ctx.alerts.length > 0 && (
        <Box marginTop={1}>
          <Text color="yellow">⚠ {ctx.alerts.length} aktív teendő (3. fül)</Text>
        </Box>
      )}
    </Box>
  );
}

/** All positions, scrollable: `offset` is the first visible row. */
export function Positions({
  ctx,
  hide,
  offset,
  rows,
}: {
  ctx: Context;
  hide: boolean;
  offset: number;
  rows: number;
}) {
  const money = makeMoney(hide);
  const all = consolidatedHoldings(ctx.summary).sort(
    (a, b) => b.marketValueHuf - a.marketValueHuf,
  );
  const total = ctx.summary.holdingsValueHuf || 1;
  const visible = all.slice(offset, offset + rows);
  return (
    <Box flexDirection="column">
      <Text bold>
        Pozíciók ({all.length}){" "}
        {all.length > rows && `– ${offset + 1}–${offset + visible.length}, ↑/↓ görgetés`}
      </Text>
      {visible.map((h) => {
        const q = ctx.liveQuotes[h.instrumentKey];
        const day = q?.prevClose && q.price ? q.price / q.prevClose - 1 : undefined;
        return (
          <Text key={h.instrumentKey}>
            {name(h.instrument?.name ?? h.instrumentKey).slice(0, 28).padEnd(28)}{" "}
            {money(h.marketValueHuf, mft).padStart(14)}{" "}
            {`${((h.marketValueHuf / total) * 100).toFixed(1).replace(".", ",")}%`.padStart(7)}{" "}
            {day != null ? (
              <Text color={dayColor(day)}>{pct(day).padStart(8)}</Text>
            ) : (
              <Text dimColor>{"—".padStart(8)}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}

export function Todos({ ctx, hide }: { ctx: Context; hide: boolean }) {
  const money = makeMoney(hide);
  const color = { high: "red", medium: "yellow", info: "blue" } as const;
  const events = ctx.events.filter((e) => e.daysUntil <= 30);
  return (
    <Box flexDirection="column">
      <Text bold>Teendők ({ctx.alerts.length})</Text>
      {ctx.alerts.length === 0 && <Text dimColor>Nincs aktív teendő.</Text>}
      {ctx.alerts.map((a) => (
        <Box key={a.id} flexDirection="column">
          <Text color={color[a.severity]}>● {hide ? MASK : a.title}</Text>
          {a.detail && <Text dimColor>  {hide ? MASK : a.detail}</Text>}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Következő 30 nap eseményei</Text>
        {events.length === 0 && <Text dimColor>Nincs közelgő esemény.</Text>}
        {events.map((e, i) => (
          <Text key={`${e.date}-${i}`}>
            {dayLabel(e.date)} ({e.daysUntil === 0 ? "ma" : `${e.daysUntil} nap`}):{" "}
            {hide ? MASK : e.title}
            {e.amountHuf ? ` – ${money(e.amountHuf)}` : ""}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

const bar = (ratio: number, width = 20) => {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
};

export function Goals({ ctx, hide }: { ctx: Context; hide: boolean }) {
  const money = makeMoney(hide);
  const priv = makePriv(hide);
  const none = ctx.goalProgress.length === 0 && ctx.savings.length === 0;
  return (
    <Box flexDirection="column">
      {none && <Text dimColor>Még nincs beállított cél.</Text>}
      {ctx.goalProgress.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Rendszeres vásárlások</Text>
          {ctx.goalProgress.map((g) => (
            <Box key={`${g.goal.id}-${g.periodKey}`} flexDirection="column">
              <Text>
                {g.done ? "✅" : "⏳"} {priv(name(g.instrumentName))} ({g.periodLabel})
              </Text>
              <Text>
                {"   "}
                <Text color={g.done ? "green" : "cyan"}>{bar(g.ratio)}</Text>{" "}
                {money(g.investedHuf)} / {money(g.targetHuf)}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      {ctx.savings.length > 0 && (
        <Box flexDirection="column" marginTop={ctx.goalProgress.length ? 1 : 0}>
          <Text bold>Középtávú célok</Text>
          {ctx.savings.map((p) => (
            <Box key={p.goal.id} flexDirection="column">
              <Text>
                {p.reached ? "✅" : "⏳"} {priv(p.goal.name)} – {money(p.targetHuf)},{" "}
                {dayLabel(p.goal.targetDate)}
              </Text>
              <Text>
                {"   "}
                <Text color={p.reached ? "green" : "cyan"}>{bar(p.progressPct)}</Text>{" "}
                most {Math.round(p.progressPct * 100)}%, határidőre várhatóan{" "}
                {Math.round(p.projectedPct * 100)}%
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Value sparkline for the chosen range; the amounts hide with the toggle. */
export function Chart({
  ctx,
  hide,
  range,
  width,
}: {
  ctx: Context;
  hide: boolean;
  range: number;
  width: number;
}) {
  const money = makeMoney(hide);
  const r = CHART_RANGES[range];
  const from = r.days ? addDaysIso(todayLocal(), -r.days) : "";
  const pts = ctx.series.filter((p) => p.date >= from);
  if (pts.length < 2) return <Text dimColor>Nincs elég adat ehhez az időszakhoz.</Text>;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const values = pts.map((p) => p.value);
  // Market result: value change minus the net flows in the window.
  const result = last.value - last.invested - (first.value - first.invested);
  const change = first.value ? last.value / first.value - 1 : undefined;
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  const drawn = Math.min(width, pts.length);
  return (
    <Box flexDirection="column">
      <Text bold>Vagyon – {r.label}</Text>
      <Text color={dayColor(result)}>{sparkline(values, width)}</Text>
      <Text dimColor>
        {first.date}
        {" ".repeat(Math.max(1, drawn - 20))}
        {last.date}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Most: {money(last.value)} · érték-változás: {pct(change, 1)}
        </Text>
        <Text>
          Piaci eredmény az időszakban:{" "}
          <Text color={dayColor(result)}>{hide ? MASK : sft(result)}</Text>
        </Text>
        <Text dimColor>
          Minimum: {money(lo)} · maximum: {money(hi)}
        </Text>
      </Box>
    </Box>
  );
}

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// A Ft amount as the report formatters print it (hu-HU grouping uses no-break
// spaces): "1 234 567 Ft", "−35,93 M Ft".
const FT_AMOUNT = /[+−-]?\d[\d\s.,]*\s?(?:M\s)?Ft/g;

/** A bot report (Hozam, Előrejelzés, TBSZ) as plain text; amounts hide with the toggle. */
export function Report({ text, hide }: { text: string; hide: boolean }) {
  const body = plain(text);
  return <Text>{hide ? body.replace(FT_AMOUNT, HIDDEN) : body}</Text>;
}
