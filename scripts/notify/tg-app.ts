// Portfolio Tracker's tg-hub app: one request in, one response out (protocol:
// C:\Users\vrbst\WORK\tg-hub\README.md "App-protokoll"). The hub polls the
// bot, guards the owner, answers /help and /status, holds back `normal`
// messages in the quiet hours (tg-hub.app.json) and runs the "tick" job every
// 5 minutes. Here:
//   • commands → the reports (reports.ts),
//   • job "tick" → recompute the portfolio with live quotes (like the app) and
//     return what's new: new alerts, big daily moves (portfolio and single
//     positions), stale data, weekly / monthly reports, and on the month's
//     last working day the leftover question (/maradek answers it).
// What has been sent already lives in .notify/state.json (state.ts).

import { resolve } from "node:path";
import { NOTIFY_DIR, loadEnv, type NotifyEnv } from "./env";
import { loadContext, withGlideAlerts, type Context } from "./data";
import { loadState, updateState, type State } from "./state";
import { isDeepGlideAlert, updateGlideSignals } from "../../src/lib/rebalance";
import { bypassesQuietHours, type Alert } from "../../src/lib/alerts";
import { consolidatedHoldings } from "../../src/lib/portfolio";
import { quotedToday } from "../../src/lib/prices";
import { addDaysIso, toLocalDay } from "../../src/lib/day";
import {
  alertLine,
  alertsText,
  appRecordedLeftover,
  eventsText,
  forecastText,
  ft,
  goalsText,
  leftoverAnswer,
  leftoverPromptText,
  liquidationText,
  mft,
  monthlyText,
  pct,
  quotesText,
  sft,
  shortName,
  statusText,
  weeklyText,
} from "./reports";
import { loadLeftoverSettings } from "../../src/lib/planPrefs";
import { leftoverMonth, parseLeftoverAmount } from "../../src/lib/leftover";
import { isLastWorkdayOfMonth } from "../../src/lib/huCalendar";

// ---- protocol (the parts we use) ------------------------------------------

export type HubRequest = { v: number; id: string; app: string; now: string } & (
  | { type: "command"; command: string; args: string }
  | { type: "text"; text: string; context: string | null }
  | { type: "callback"; data: string }
  | { type: "job"; job: string }
);

export interface HubMessage {
  html: string;
  priority: "urgent" | "normal";
}

export interface HubResponse {
  v: 1;
  ok?: false;
  error?: string;
  messages?: HubMessage[];
  expectText?: { context: string; ttl: string };
}

export interface Deps {
  load: () => Promise<Context>;
  stateFile: string;
  env: Pick<NotifyEnv, "bigMovePct" | "positionMovePct">;
}

export function defaultDeps(): Deps {
  const env = loadEnv();
  return {
    load: () => loadContext(env),
    stateFile: resolve(NOTIFY_DIR, "state.json"),
    env,
  };
}

const msg = (html: string, urgent = false): HubMessage => ({
  html,
  priority: urgent ? "urgent" : "normal",
});
const fail = (error: string): HubResponse => ({ v: 1, ok: false, error });

const isAuthError = (e: unknown) =>
  /\b(401|403)\b/.test(e instanceof Error ? e.message : String(e));

/** Text of a load failure; an expired / wrong GitHub token says what to do. */
export function loadErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return isAuthError(e)
    ? "🔑 Nem érem el a szinkron-repót (a GitHub-token lejárt vagy hibás). Frissítsd a .notify/.env-ben a GITHUB_TOKEN-t."
    : `Nem sikerült frissíteni az adatokat: ${m}`;
}

/**
 * How long transient load failures (a GitHub timeout, a network blip) are
 * tolerated silently: the next tick catches up on everything, so a single
 * miss isn't worth a ❌ + ✅ pair on the phone. A token error is reported
 * at once — that one needs the user.
 */
export const LOAD_FAILURE_GRACE_MS = 30 * 60_000;

/** ctx.alerts = base alerts + glide-path alerts from our own re-alert state. */
function composeAlerts(ctx: Context, st: State) {
  ctx.alerts = withGlideAlerts(
    ctx.baseAlerts,
    ctx.glide,
    ctx.glideConfig,
    ctx.alertState,
    st.glideSignals ?? {},
    ctx.accountCtx,
  );
}

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
const hoursSince = (iso: string | undefined, now: Date) =>
  iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : Infinity;

// ---- entry ----------------------------------------------------------------

/** The handler's stdin → stdout, as strings (the process wrapper is tg-handler.ts). */
export async function runHandler(input: string, deps: Deps): Promise<string> {
  let res: HubResponse;
  try {
    res = await handleRequest(JSON.parse(input) as HubRequest, deps);
  } catch (e) {
    console.error((e as Error).stack ?? e);
    res = fail((e as Error).message);
  }
  return JSON.stringify(res);
}

export async function handleRequest(req: HubRequest, deps: Deps): Promise<HubResponse> {
  switch (req.type) {
    case "command":
      console.error(`/${req.command} ${req.args}`.trim());
      return req.command === "maradek"
        ? leftover(req.args, deps)
        : command(req.command, deps);
    case "text":
      // Only the amount after a bare /maradek is expected (expectText).
      if (req.context === "maradek") return leftover(req.text, deps);
      return { v: 1, messages: [msg("Ehhez most nem tudok mit kezdeni. A parancsokat a /help sorolja fel.")] };
    case "job":
      console.error(`job ${req.job}`);
      if (req.job === "tick") return tick(deps);
      return fail(`Ismeretlen job: ${req.job}`);
    default:
      return { v: 1, messages: [] };
  }
}

// ---- commands -------------------------------------------------------------

const COMMANDS: Record<string, (c: Context) => string> = {
  allas: statusText,
  arfolyam: quotesText,
  teendok: alertsText,
  esemenyek: (c) => eventsText(c, 30),
  cel: goalsText,
  elorejelzes: forecastText,
  heti: weeklyText,
  havi: monthlyText,
  eladas: liquidationText,
};

/** Load the context with the alerts as of our state; a failure → its text. */
async function contextFor(deps: Deps): Promise<Context | string> {
  try {
    const ctx = await deps.load();
    composeAlerts(ctx, loadState(deps.stateFile));
    return ctx;
  } catch (e) {
    console.error("load error:", (e as Error).message);
    return loadErrorText(e);
  }
}

async function command(name: string, deps: Deps): Promise<HubResponse> {
  const report = COMMANDS[name];
  if (!report) return fail(`Ismeretlen parancs: /${name}`);
  const ctx = await contextFor(deps);
  if (typeof ctx === "string") return fail(ctx);
  return { v: 1, messages: [msg(report(ctx))] };
}

/**
 * /maradek <összeg>: the split; a valid amount is remembered for the month.
 * Without a (valid) amount the next plain message is taken as the amount.
 */
async function leftover(arg: string, deps: Deps): Promise<HubResponse> {
  const ctx = await contextFor(deps);
  if (typeof ctx === "string") return fail(ctx);
  const r = leftoverAnswer(ctx, arg);
  const parsed = parseLeftoverAmount(arg);
  if (r.ok && "huf" in parsed) {
    const key = leftoverMonth(ctx.at).key;
    updateState(deps.stateFile, (cur) => {
      const answered = { ...cur.leftover?.answered, [key]: parsed.huf };
      // Keep the last few months only.
      const last = Object.fromEntries(Object.entries(answered).sort().slice(-3));
      return { ...cur, leftover: { ...cur.leftover, answered: last } };
    });
    return { v: 1, messages: [msg(r.html)] };
  }
  const hint = arg.trim() ? "" : "\n\nMost elég csak az összeget beírnod, pl. <code>50000</code>.";
  return {
    v: 1,
    messages: [msg(r.html + hint)],
    expectText: { context: "maradek", ttl: "10m" },
  };
}

// ---- the 5-minute tick ----------------------------------------------------

/**
 * New alerts as messages: the normal ones together (urgent if any is high),
 * the deepening glide-path re-alerts apart — those the user let through the
 * quiet hours are urgent, the rest wait for the morning at the hub.
 */
export function alertMessages(fresh: Alert[]): HubMessage[] {
  const out: HubMessage[] = [];
  const normal = fresh.filter((a) => !isDeepGlideAlert(a));
  const deep = fresh.filter(isDeepGlideAlert);
  if (normal.length) {
    const head =
      normal.length === 1 ? "⚠️ <b>Új teendő</b>" : `⚠️ <b>${normal.length} új teendő</b>`;
    out.push(
      msg([head, ...normal.map(alertLine)].join("\n\n"), normal.some((a) => a.severity === "high")),
    );
  }
  const urgent = deep.filter(bypassesQuietHours);
  const later = deep.filter((a) => !bypassesQuietHours(a));
  for (const [group, isUrgent] of [[urgent, true], [later, false]] as const)
    if (group.length)
      out.push(msg(["📉 <b>Tovább mélyült eltérés</b>", ...group.map(alertLine)].join("\n\n"), isUrgent));
  return out;
}

async function tick(deps: Deps): Promise<HubResponse> {
  let ctx: Context;
  try {
    ctx = await deps.load();
  } catch (e) {
    console.error("load error:", (e as Error).message);
    if (isAuthError(e)) return fail(loadErrorText(e));
    const now = new Date();
    const since = updateState(deps.stateFile, (cur) => ({
      ...cur,
      loadFailingSince: cur.loadFailingSince ?? now.toISOString(),
    })).loadFailingSince!;
    const failingMs = now.getTime() - Date.parse(since);
    if (failingMs < LOAD_FAILURE_GRACE_MS) {
      // Counts as a run without news for the hub: no health alert yet.
      console.error(`load error tolerated (failing for ${Math.round(failingMs / 60_000)} min)`);
      return { v: 1, messages: [] };
    }
    // The hub turns this into a health alert, repeated at most every 6 h
    // (tg-hub.app.json), and says when it recovers.
    return fail(`${loadErrorText(e)} (${Math.round(failingMs / 60_000)} perce)`);
  }
  const st = loadState(deps.stateFile);
  delete st.loadFailingSince;
  const messages = tickMessages(ctx, st, deps.env);
  // Save before answering: a kill after this only loses messages, never
  // sends them twice. /maradek may have written meanwhile: keep its answer.
  updateState(deps.stateFile, (cur) => ({
    ...st,
    leftover: { ...st.leftover, answered: cur.leftover?.answered },
  }));
  return { v: 1, messages };
}

/** From this hour on Friday the week's report is due (Xetra closes 17:30). */
export const WEEKLY_REPORT_HOUR = 18;

/**
 * The Friday (YYYY-MM-DD) whose weekly report is due at `now`: that Friday
 * from WEEKLY_REPORT_HOUR through the weekend; Monday–Friday before it none.
 */
export function weeklyReportFriday(now: Date): string | null {
  const back = { 5: 0, 6: 1, 0: 2 }[now.getDay()];
  if (back === undefined || (back === 0 && now.getHours() < WEEKLY_REPORT_HOUR)) return null;
  return addDaysIso(toLocalDay(now), -back);
}

/** What's new since the last tick; advances `st` (pure apart from that). */
export function tickMessages(ctx: Context, st: State, env: Deps["env"]): HubMessage[] {
  const now = ctx.at;
  const out: HubMessage[] = [];
  const today = toLocalDay(now);
  // Very first run: no report for the week we joined halfway.
  st.lastWeekly ??= today;

  // 0) Glide-path re-alert state: advance it to the current weights (the
  //    same rule the app runs), then rebuild the alert list from it.
  const sig = updateGlideSignals(st.glideSignals ?? {}, ctx.glide, ctx.glideConfig);
  if (sig.changed) st.glideSignals = sig.signals;
  composeAlerts(ctx, st);

  // 1) New alerts (the app's own rules, dismissed ones skipped).
  const active = new Set(ctx.alerts.map((a) => a.id));
  const fresh = ctx.alerts.filter((a) => !st.sentAlerts[a.id]);
  out.push(...alertMessages(fresh));
  for (const a of fresh) st.sentAlerts[a.id] = now.toISOString();
  // Resolved alerts are forgotten, so a later re-trigger is new again.
  for (const id of Object.keys(st.sentAlerts))
    if (!active.has(id)) delete st.sentAlerts[id];

  // 2) Big daily moves: the whole portfolio and single positions, each
  //    re-reported only when it crosses the next threshold level.
  if (st.moves?.day !== today) st.moves = { day: today, total: 0, pos: {} };
  const moves = st.moves;
  const level = (x: number, step: number) =>
    Math.floor((Math.abs(x) * 100 + 1e-9) / step);
  // Only today's trading counts: on a weekend, a holiday or before the open
  // the quotes still carry the last session's move (price vs the close
  // before it), and the per-day levels above were just reset — without this
  // a Friday move would be re-sent as "ma" on Saturday, Sunday and Monday.
  const held = consolidatedHoldings(ctx.summary);
  const heldQuotes = held
    .map((h) => ctx.liveQuotes[h.instrumentKey])
    .filter((q) => q?.prevClose != null);
  const marketMovedToday = heldQuotes.length
    ? heldQuotes.some((q) => quotedToday(q, now))
    : quotedToday(ctx.liveQuotes["EUR"], now);
  const dc = ctx.dayChange;
  if (dc?.pct != null && dc.note === "ma" && marketMovedToday) {
    const lv = level(dc.pct, env.bigMovePct);
    if (lv > moves.total) {
      moves.total = lv;
      out.push(
        msg(
          `${dc.abs > 0 ? "🚀" : "🔻"} <b>Nagy mozgás ma: ${pct(dc.pct, 2)}</b> (${sft(dc.abs)})\nVagyon: ${ft(ctx.summary.totalValueHuf)}`,
        ),
      );
    }
  }
  const posLines: string[] = [];
  for (const h of held) {
    const q = ctx.liveQuotes[h.instrumentKey];
    if (!q?.prevClose || !q.price || !quotedToday(q, now)) continue;
    const ch = q.price / q.prevClose - 1;
    const lv = level(ch, env.positionMovePct);
    if (lv > (moves.pos[h.instrumentKey] ?? 0)) {
      moves.pos[h.instrumentKey] = lv;
      // HUF move of the position today: value now minus value at prev close.
      const move = h.marketValueHuf - h.marketValueHuf / (1 + ch);
      posLines.push(
        `${ch > 0 ? "🚀" : "🔻"} <b>${shortName(h.instrument?.name ?? h.instrumentKey)}: ${pct(ch, 1)}</b> ma (${sft(move)}, pozíció: ${mft(h.marketValueHuf)})`,
      );
    }
  }
  if (posLines.length) out.push(msg(posLines.join("\n")));

  // 3) Stale data: no sync in 2 weeks, price file 4+ days old (the price
  // workflow runs on weekdays only and GitHub often starts it hours late,
  // so Friday evening → Monday evening can exceed 3 days).
  const stale: [string, number, string][] = [
    [
      "sync",
      hoursSince(ctx.snapshot.exportedAt, now) / 24,
      "📥 Több mint 14 napja nem szinkronizált az app – ha volt új kivonat, importáld, különben a jelentések elavultak.",
    ],
    [
      "prices",
      hoursSince(ctx.priceFile?.updatedAt, now) / 24,
      "📉 Az árfolyamfájl 4+ napja nem frissült – lehet, hogy a GitHub Actions árfrissítés hibára futott.",
    ],
  ];
  for (const [key, days, text] of stale) {
    const limit = key === "sync" ? 14 : 4;
    if (days > limit && hoursSince(st.warned[key], now) > 24 * 7) {
      st.warned[key] = now.toISOString();
      out.push(msg(text));
    } else if (days <= limit) delete st.warned[key];
  }

  // 4) Weekly (Friday from 18:00, after the Xetra close; caught up on the
  //    weekend if the hub was down) and monthly (the 1st from 08:00) reports.
  const friday = weeklyReportFriday(now);
  if (friday && (st.lastWeekly ?? "") < friday) {
    st.lastWeekly = friday;
    out.push(msg(weeklyText(ctx)));
  }
  const ym = today.slice(0, 7);
  if (now.getHours() >= 8 && st.lastMonthly !== ym) {
    // First run ever: don't fire a report for a month we joined halfway.
    if (st.lastMonthly) out.push(msg(monthlyText(ctx)));
    st.lastMonthly = ym;
  }

  // 5) Month-end leftover: on the month's last working day (Hungarian
  //    calendar), from the set time, once — "already recorded" instead of
  //    the question when the app or /maradek has it.
  const lo = loadLeftoverSettings();
  const [lh, lm] = lo.time.split(":").map(Number);
  if (lo.notify && isLastWorkdayOfMonth(now) && minutesOfDay(now) >= lh * 60 + lm) {
    const m = leftoverMonth(now);
    const state = (st.leftover ??= {});
    if (state.asked !== m.key) {
      state.asked = m.key;
      const inApp = appRecordedLeftover(ctx, m);
      const answered = state.answered?.[m.key];
      const done = inApp
        ? `az appban: ${inApp.title}`
        : answered != null
          ? `a botnak: ${ft(answered)}`
          : undefined;
      out.push(msg(leftoverPromptText(ctx, done)));
    }
  }
  return out;
}
