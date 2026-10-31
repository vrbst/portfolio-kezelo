// The assistant's HTML view of the portfolio (asszisztens.app.json "view", command assistant_view):
// the same loaded Context the Telegram reports use, drawn as one HTML fragment. The assistant wraps it
// (style variables, strict CSP, no scripts) and shows it in a sandboxed iframe, so this is plain HTML + CSS + inline SVG only.
// Contract for the fragment: ../../../asszisztens/docs/app-view.md. Interaction is declarative (data-act / data-open).
//
// Pure: Context in, string out (the tests run it on the invented portfolio). Every piece of data text goes through esc().

import { consolidatedHoldings } from "../../src/lib/portfolio";
import type { ValuePoint } from "../../src/lib/series";
import type { Context } from "./data";
import { dayLabel, esc, ft, mft, pct, sft, shortName } from "./reports";

/** The action id in asszisztens.app.json (the button below asks for it). */
export const NEWS_ACTION = "hirkereses";

const SERIES_DAYS = 365;
const MAX_POINTS = 140;
const EVENT_ICON: Record<string, string> = { coupon: "💰", maturity: "🏁", tbsz: "🗓" };
const SEVERITY_CLASS: Record<string, string> = { high: "bad", medium: "warn", info: "muted" };

const STYLE = `<style>
.pv{display:grid;gap:14px}
.pv-top{display:grid;grid-template-columns:minmax(260px,1.2fr) repeat(auto-fit,minmax(150px,1fr));gap:14px}
.pv-top .card{display:flex;flex-direction:column;justify-content:center}
.pv small{display:block;color:var(--muted);font-size:.8rem}
.pv ul{list-style:none;margin:0;padding:0}.pv li{padding:5px 0;border-bottom:1px solid var(--line)}.pv li:last-child{border-bottom:0}
.pv-bar{height:8px;border-radius:4px;background:var(--card-2);overflow:hidden;margin:6px 0 2px}
.pv-bar>span{display:block;height:100%;background:var(--accent);border-radius:4px}
.pv-bar.done>span{background:var(--good)}
.spark{width:100%;height:auto;display:block}
.spark .val{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round}
.spark .area{fill:var(--accent);opacity:.12;stroke:none}
.spark .inv{fill:none;stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 4}
.spark text{fill:var(--muted);font-size:11px;font-family:inherit}
.spark .grid{stroke:var(--line);stroke-width:1}
.pv-row{display:flex;justify-content:space-between;gap:12px}
.pv-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
</style>`;

/** The value line over the last year against the invested capital (dashed). Empty without enough data. */
export function trendSvg(series: ValuePoint[], w = 720, h = 170): string {
  const last = series.at(-1);
  if (!last || series.length < 2) return "";
  const to = Date.parse(last.date);
  const from = to - SERIES_DAYS * 86_400_000;
  let pts = series.filter((p) => Date.parse(p.date) >= from);
  if (pts.length < 2) pts = series.slice(-2);
  const stride = Math.max(1, Math.ceil(pts.length / MAX_POINTS));
  pts = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);

  const t0 = Date.parse(pts[0].date);
  const t1 = Date.parse(pts[pts.length - 1].date);
  const lo = Math.min(...pts.map((p) => Math.min(p.value, p.invested)));
  const hi = Math.max(...pts.map((p) => Math.max(p.value, p.invested)));
  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 22;
  const x = (d: string) => padL + (t1 === t0 ? 0 : ((Date.parse(d) - t0) / (t1 - t0)) * (w - padL - padR));
  const y = (v: number) => padT + (hi === lo ? 0.5 : 1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const line = (f: (p: ValuePoint) => number) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)} ${y(f(p)).toFixed(1)}`).join("");
  const val = line((p) => p.value);
  const area = `${val}L${x(pts[pts.length - 1].date).toFixed(1)} ${h - padB}L${x(pts[0].date).toFixed(1)} ${h - padB}Z`;
  return (
    `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="A portfólió értéke és a befektetett tőke az elmúlt évben">` +
    `<line class="grid" x1="${padL}" x2="${w - padR}" y1="${h - padB}" y2="${h - padB}"/>` +
    `<path class="area" d="${area}"/><path class="inv" d="${line((p) => p.invested)}"/><path class="val" d="${val}"/>` +
    `<text x="${padL}" y="12">${esc(mft(hi))}</text><text x="${padL}" y="${h - 6}">${esc(dayLabel(pts[0].date))}</text>` +
    `<text x="${w - padR}" y="${h - 6}" text-anchor="end">${esc(dayLabel(pts[pts.length - 1].date))}</text>` +
    `<text x="${w - padR}" y="12" text-anchor="end">${esc(mft(lo))} (min.)</text></svg>`
  );
}

const signClass = (n: number) => (n > 0 ? "good" : n < 0 ? "bad" : "muted");

/**
 * The whole view. `appUrl` is the real app's address (the "Megnyitás" link); it must be an origin listed in the descriptor's
 * view.open (the app's own url always is).
 */
export function portfolioViewHtml(ctx: Context, appUrl: string): string {
  const s = ctx.summary;
  const d = ctx.dayChange;

  const hero =
    `<div class="card"><h3>Portfólió értéke</h3><div class="kpi">${esc(ft(s.totalValueHuf))}</div>` +
    (d
      ? `<div class="${signClass(d.abs)}">${esc(sft(d.abs))} (${esc(pct(d.pct, 2))})<small>${esc(d.note)}${d.eurPct != null ? ` · EUR-ban ${esc(pct(d.eurPct, 2))}` : ""}</small></div>`
      : "") +
    `</div>`;
  const tiles =
    `<div class="card"><h3>Összes eredmény</h3><div class="kpi ${signClass(s.totalPlHuf)}">${esc(sft(s.totalPlHuf))}</div><small>${esc(pct(s.totalReturnPct))}</small></div>` +
    `<div class="card"><h3>Befektetett tőke</h3><div class="kpi">${esc(mft(s.netDepositedHuf))}</div><small>nettó befizetés</small></div>`;

  const trend = trendSvg(ctx.series);
  const trendCard = trend ? `<div class="card"><h3>Az elmúlt év</h3>${trend}<small>Narancs: az érték, szaggatott: a befektetett tőke.</small></div>` : "";

  const total = Math.max(1, s.totalValueHuf);
  const accounts = s.accounts.filter((a) => Math.abs(a.totalValueHuf) >= 1);
  const accountsCard = accounts.length
    ? `<div class="card"><h3>Számlák</h3><table><tbody>${accounts
        .map((a) => `<tr><td>${shortName(a.account.name)}</td><td class="num">${esc(mft(a.totalValueHuf))}</td><td class="num muted">${Math.round((a.totalValueHuf / total) * 100)}%</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";

  const top = consolidatedHoldings(s).sort((a, b) => b.marketValueHuf - a.marketValueHuf).slice(0, 8);
  const holdingsCard = top.length
    ? `<div class="card"><h3>Legnagyobb pozíciók</h3><table><tbody>${top
        .map((h) => {
          const q = ctx.liveQuotes[h.instrumentKey];
          const move = q?.prevClose && q.price ? q.price / q.prevClose - 1 : undefined;
          return `<tr><td>${shortName(h.instrument?.name ?? h.instrumentKey)}</td><td class="num">${esc(mft(h.marketValueHuf))}</td><td class="num ${move === undefined ? "muted" : signClass(move)}">${move === undefined ? "" : esc(pct(move))}</td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : "";

  const goalRows = [
    ...ctx.savings.map(
      (p) =>
        `<li><div class="pv-row"><strong>${esc(p.goal.name)}</strong><span class="muted">${esc(ft(p.targetHuf))} · ${esc(dayLabel(p.goal.targetDate))}</span></div>` +
        `<div class="pv-bar${p.reached ? " done" : ""}"><span style="width:${Math.min(100, Math.round(p.progressPct * 100))}%"></span></div>` +
        `<small>most ${Math.round(p.progressPct * 100)}%, a határidőre várhatóan ${Math.round(p.projectedPct * 100)}%</small></li>`,
    ),
    ...ctx.goalProgress.map(
      (g) =>
        `<li><div class="pv-row"><strong>${shortName(g.instrumentName)}</strong><span class="muted">${esc(g.periodLabel)}</span></div>` +
        `<div class="pv-bar${g.done ? " done" : ""}"><span style="width:${Math.min(100, Math.round(g.ratio * 100))}%"></span></div>` +
        `<small>${esc(ft(g.investedHuf))} / ${esc(ft(g.targetHuf))}${g.done ? "" : ` · még ${esc(ft(g.remainingHuf))}`}</small></li>`,
    ),
  ];
  const goalsCard = goalRows.length ? `<div class="card"><h3>Célok</h3><ul>${goalRows.join("")}</ul></div>` : "";

  const events = ctx.events.slice(0, 8);
  const eventsCard = events.length
    ? `<div class="card"><h3>Közelgő események</h3><ul>${events
        .map((e) => {
          const when = e.daysUntil === 0 ? "ma" : e.daysUntil === 1 ? "holnap" : `${e.daysUntil} nap múlva`;
          return `<li><div class="pv-row"><span>${EVENT_ICON[e.kind] ?? "•"} ${esc(e.title)}</span><span class="num">${e.amountHuf ? esc(ft(e.amountHuf)) : ""}</span></div><small>${esc(dayLabel(e.date))} · ${when}</small></li>`;
        })
        .join("")}</ul></div>`
    : "";

  const alerts = ctx.alerts.slice(0, 5);
  const alertsCard = alerts.length
    ? `<div class="card"><h3>Teendők (${ctx.alerts.length})</h3><ul>${alerts
        .map((a) => `<li class="${SEVERITY_CLASS[a.severity] ?? ""}"><strong>${esc(a.title)}</strong>${a.detail ? `<small>${esc(a.detail)}</small>` : ""}</li>`)
        .join("")}</ul></div>`
    : "";

  const actions =
    `<div class="pv-actions"><button class="accent" data-act="${NEWS_ACTION}">🔎 Friss hírkeresés</button>` +
    `<a href="#" data-open="${esc(appUrl)}">Megnyitás az appban ↗</a></div>`;

  return (
    `${STYLE}<div class="pv"><div class="pv-top">${hero}${tiles}</div>${trendCard}` +
    `<div class="grid">${accountsCard}${holdingsCard}</div><div class="grid">${goalsCard}${eventsCard}${alertsCard}</div>${actions}</div>`
  );
}
