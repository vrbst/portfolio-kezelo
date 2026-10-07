// Portfolio Tracker's tg-hub app: one request in, one response out (protocol:
// C:\Users\vrbst\WORK\tg-hub\README.md "App-protokoll"). The hub polls the
// bot, guards the owner, answers /help and /status, holds back `normal`
// messages in the quiet hours (tg-hub.app.json) and runs the "tick" job every
// 5 minutes. Here:
//   • commands → the reports (reports.ts),
//   • job "tick" → recompute the portfolio with live quotes (like the app) and
//     return what's new: new alerts, big daily moves (portfolio and single
//     positions), stale data, weekly / monthly reports, and on the month's
//     last working day the leftover question (/maradek answers it),
//   • jobs "news-morning" / "news-evening" → the AI's market-news digest
//     (news/), /hirek sends the latest again, /hirkereses searches now.
// What has been sent already lives in .notify/state.json (state.ts).

import { resolve } from "node:path";
import { NOTIFY_DIR, forHolding, loadEnv, newsGithubToken, type NotifyEnv } from "./env";
import { claudeCodeEngine, type NewsEngine } from "./news/engine";
import { latestDigest, makeDigest, repoStore, type NewsDeps } from "./news/job";
import { portfolioExposure } from "./news/prompt";
import { WHY_JSON_SCHEMA, askWhy, buildWhyPrompt, whyText, type WhyFactor } from "./news/why";
import { NEWS_EDITION_LABEL, type NewsEdition } from "../../src/lib/newsSchema";
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
  glideText,
  goalsText,
  leftoverAnswer,
  leftoverPromptText,
  liquidationText,
  mft,
  monthlyText,
  newsText,
  pct,
  planText,
  quotesText,
  returnsText,
  sft,
  shortName,
  planReminderText,
  statusText,
  taxReminderText,
  tbszText,
  weeklyText,
  yearlyText,
} from "./reports";
import { priceAlertCommand, priceAlertMessages } from "./priceAlerts";
import { goalMilestoneMessages, stalePriceMessage, wealthMessages } from "./watch";
import { effectiveMonthKey } from "../../src/lib/goals";
import { loadLeftoverSettings } from "../../src/lib/planPrefs";
import { leftoverMonth, parseLeftoverAmount } from "../../src/lib/leftover";
import { isLastWorkdayOfMonth } from "../../src/lib/huCalendar";
import { bondNoticeMessages } from "./bondNotices";

// ---- protocol (the parts we use) ------------------------------------------

export type HubRequest = { v: number; id: string; app: string; now: string } & (
  | { type: "command"; command: string; args: string }
  | { type: "text"; text: string; context: string | null }
  | { type: "callback"; data: string }
  | { type: "job"; job: string; manual?: boolean }
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
  env: Pick<NotifyEnv, "bigMovePct" | "positionMovePct" | "wealthStepHuf" | "drawdownStepPct"> &
    Partial<Pick<NotifyEnv, "moveOverrides" | "whySubjects">>;
  /** The daily news digest's AI and storage (built only when needed). */
  news?: () => NewsDeps;
  why?: () => NewsEngine;
  /** Start one of our jobs at the hub now (it runs apart from this request). */
  runJob?: (job: string) => Promise<"started" | "running">;
}

export function defaultDeps(): Deps {
  const env = loadEnv();
  return {
    load: () => loadContext(env),
    stateFile: resolve(NOTIFY_DIR, "state.json"),
    env,
    news: () => ({
      engine: claudeCodeEngine({ bin: env.newsClaudeBin, model: env.newsModel }),
      store: repoStore(env.syncRepo, newsGithubToken),
      cacheDir: resolve(NOTIFY_DIR, "news"),
      appUrl: env.appUrl,
    }),
    why: () => claudeCodeEngine({ bin: env.newsClaudeBin, model: env.whyModel, schema: WHY_JSON_SCHEMA }),
    runJob: hubRunJob,
  };
}

/** POST /v1/apps/{app}/jobs/{job}/run at the hub that started this process. */
async function hubRunJob(job: string): Promise<"started" | "running"> {
  const { TG_HUB_URL: url, TG_HUB_APP: app, TG_HUB_KEY: key } = process.env;
  if (!url || !app || !key) throw new Error("A hírkeresés csak a tg-hubon keresztül indítható.");
  const res = await fetch(`${url}/v1/apps/${app}/jobs/${job}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 409) return "running";
  if (!res.ok) throw new Error(`A tg-hub nem indította el a keresést (HTTP ${res.status}).`);
  return "started";
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
      if (req.command === "hirek") return latestNews(deps);
      if (req.command === "hirkereses") return searchNews(deps);
      if (req.command === "riasztas") return priceAlerts(req.args, deps);
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
      if (req.job === "news-morning") return news(deps, "morning", req.manual === true);
      if (req.job === "news-evening") return news(deps, "evening", req.manual === true);
      if (req.job === WHY_JOB) return whyMoved(deps);
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
  terv: planText,
  palya: glideText,
  hozam: returnsText,
  tbsz: tbszText,
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

async function priceAlerts(args: string, deps: Deps): Promise<HubResponse> {
  const ctx = await contextFor(deps);
  if (typeof ctx === "string") return fail(ctx);
  let html = "";
  updateState(deps.stateFile, (cur) => {
    const r = priceAlertCommand(ctx, args, cur.priceAlerts ?? []);
    html = r.html;
    return { ...cur, priceAlerts: r.alerts };
  });
  return { v: 1, messages: [msg(html)] };
}

// ---- the news digest ------------------------------------------------------

/** /hirkereses: how long a request waits for its job, and the gap between two. */
export const NEWS_SEARCH_PENDING_MS = 10 * 60_000;
export const NEWS_SEARCH_COOLDOWN_MS = 30 * 60_000;

/** The edition an on-demand search refreshes: the morning one until noon. */
export const searchEdition = (now: Date): NewsEdition => (now.getHours() < 12 ? "morning" : "evening");

/**
 * Jobs "news-morning" (weekdays before the Xetra opens) and "news-evening"
 * (after it closes), tg-hub.app.json: the AI's digest of the market news →
 * the sync repo and one message. Three ways to get here:
 *   • on demand (/hirkereses left a request in the state): a fresh search,
 *     sent at once (urgent: the user asked) — it doesn't count as the day's
 *     scheduled run, so the evening digest still comes after the close;
 *   • by schedule: a fresh search, once a day per edition;
 *   • a manual run at the hub: today's digest again from the local copy
 *     (this also retries a failed upload without a new search).
 */
async function news(deps: Deps, edition: NewsEdition, manual: boolean): Promise<HubResponse> {
  if (!deps.news) return fail("A hírösszefoglaló nincs beállítva.");
  const ctx = await contextFor(deps);
  if (typeof ctx === "string") return fail(ctx);
  const today = toLocalDay(ctx.at);
  const st = loadState(deps.stateFile).news ?? {};
  const asked = st.searchRequestedAt;
  const onDemand = asked != null && ctx.at.getTime() - Date.parse(asked) < NEWS_SEARCH_PENDING_MS;
  if (!onDemand && !manual && st[edition] === today) {
    console.error(`news: ${today} ${edition} done already`);
    return { v: 1, messages: [] };
  }
  const nd = deps.news();
  let run;
  try {
    run = await makeDigest(ctx, nd, edition, { reuseLocal: manual && !onDemand });
  } finally {
    // A failed search frees /hirkereses for another try.
    if (onDemand)
      updateState(deps.stateFile, (cur) => {
        const { searchRequestedAt: _, ...rest } = cur.news ?? {};
        return { ...cur, news: rest };
      });
  }
  if (!onDemand)
    updateState(deps.stateFile, (cur) => ({
      ...cur,
      news: { ...cur.news, [edition]: run.digest.day },
    }));
  return { v: 1, messages: [msg(newsText(run.digest, ctx, nd.appUrl, run.uploadError), onDemand)] };
}

/**
 * /hirkereses: a fresh search now. The search takes minutes and the hub
 * runs one command at a time, so this only starts the news job (it answers
 * on its own) and says so; at most once per NEWS_SEARCH_COOLDOWN_MS.
 */
async function searchNews(deps: Deps): Promise<HubResponse> {
  if (!deps.news || !deps.runJob) return fail("A hírösszefoglaló nincs beállítva.");
  const now = new Date();
  const st = loadState(deps.stateFile).news ?? {};
  const since = (iso?: string) => (iso ? now.getTime() - Date.parse(iso) : Infinity);
  if (since(st.searchRequestedAt) < NEWS_SEARCH_PENDING_MS)
    return { v: 1, messages: [msg("🔎 Már keresem a híreket, pár perc és jön.")] };
  const last = since(st.lastSearchAt);
  if (last < NEWS_SEARCH_COOLDOWN_MS) {
    const wait = Math.ceil((NEWS_SEARCH_COOLDOWN_MS - last) / 60_000);
    return {
      v: 1,
      messages: [msg(`Az előző keresés ${Math.floor(last / 60_000)} perce volt. Újat ${wait} perc múlva kérhetsz; a legutóbbit a /hirek küldi el.`)],
    };
  }
  const edition = searchEdition(now);
  updateState(deps.stateFile, (cur) => ({
    ...cur,
    news: { ...cur.news, searchRequestedAt: now.toISOString(), lastSearchAt: now.toISOString() },
  }));
  let started: "started" | "running";
  try {
    started = await deps.runJob(`news-${edition}`);
  } catch (e) {
    updateState(deps.stateFile, (cur) => ({
      ...cur,
      news: { ...cur.news, searchRequestedAt: undefined, lastSearchAt: st.lastSearchAt },
    }));
    return fail((e as Error).message);
  }
  if (started === "running") {
    // The scheduled run is on it: its answer is the fresh one.
    updateState(deps.stateFile, (cur) => ({
      ...cur,
      news: { ...cur.news, searchRequestedAt: undefined },
    }));
    return { v: 1, messages: [msg(`🔎 Épp most készül a(z) ${NEWS_EDITION_LABEL[edition].toLowerCase()}, pár perc és jön.`)] };
  }
  return {
    v: 1,
    messages: [msg(`🔎 Keresem a friss híreket (${NEWS_EDITION_LABEL[edition].toLowerCase()}), 2–4 perc és küldöm.`)],
  };
}

/** /hirek: the newest digest from the sync repo again, with today's moves. */
async function latestNews(deps: Deps): Promise<HubResponse> {
  if (!deps.news) return fail("A hírösszefoglaló nincs beállítva.");
  const ctx = await contextFor(deps);
  if (typeof ctx === "string") return fail(ctx);
  const nd = deps.news();
  let digest;
  try {
    digest = await latestDigest(nd.store);
  } catch (e) {
    console.error("news: read failed:", (e as Error).message);
    return fail(loadErrorText(e));
  }
  if (!digest)
    return {
      v: 1,
      messages: [msg("📰 Még nincs hírösszefoglaló. Hétköznap kettő készül: 7:45 körül (a Xetra nyitása előtt) és 18:15 körül (a zárása után).")],
    };
  return { v: 1, messages: [msg(newsText(digest, ctx, nd.appUrl))] };
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
  const alertIds = new Set((st.priceAlerts ?? []).map((a) => a.id));
  const asked = st.why?.request?.at;
  const messages = tickMessages(ctx, st, deps.env);
  const kept = new Set((st.priceAlerts ?? []).map((a) => a.id));
  // Save before answering: a kill after this only loses messages, never
  // sends them twice. /maradek and the news job may have written meanwhile:
  // keep their fields.
  updateState(deps.stateFile, (cur) => ({
    ...st,
    leftover: { ...st.leftover, answered: cur.leftover?.answered },
    news: cur.news,
    priceAlerts: (cur.priceAlerts ?? []).filter((a) => kept.has(a.id) || !alertIds.has(a.id)),
    whyTaken: cur.whyTaken,
  }));
  const request = st.why?.request?.at;
  if (request && request !== asked && deps.runJob)
    try {
      await deps.runJob(WHY_JOB);
    } catch (e) {
      console.error("why: job start failed:", (e as Error).message);
    }
  return { v: 1, messages };
}

export const PLAN_REMINDER_DAY = 10;
export const WHY_JOB = "news-why";
const FX_KEY = "EUR/HUF";
export const WHY_MAX_RUNS_PER_DAY = 3;
export const WHY_REQUEST_TTL_MS = 3 * 3_600_000;

async function whyMoved(deps: Deps): Promise<HubResponse> {
  if (!deps.why) return fail("A „Miért mozdult?” keresés nincs beállítva.");
  const now = new Date();
  const st = loadState(deps.stateFile);
  const req = st.why?.request;
  if (!req || st.whyTaken === req.at || now.getTime() - Date.parse(req.at) > WHY_REQUEST_TTL_MS)
    return { v: 1, messages: [] };
  updateState(deps.stateFile, (cur) => ({ ...cur, whyTaken: req.at }));
  const [y, m, d] = st.why!.day.split("-").map(Number);
  const prompt = buildWhyPrompt({
    day: st.why!.day,
    weekday: new Date(y, m - 1, d).getDay(),
    factors: req.factors,
    exposure: req.exposure,
  });
  const started = Date.now();
  const { answer, costUsd } = await askWhy(deps.why(), prompt, req.factors);
  console.error(
    `why: ${answer.items.length} explained in ${Math.round((Date.now() - started) / 1000)} s` +
      (costUsd != null ? `, ~$${costUsd.toFixed(2)} at API prices` : ""),
  );
  return { v: 1, messages: [msg(whyText(req.factors, answer))] };
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
  const moved: WhyFactor[] = [];
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
    if (moves.total > 0) moved.push({ key: "portfolio", label: "portfólió", pct: dc.pct });
  }
  const posLines: string[] = [];
  for (const h of held) {
    const q = ctx.liveQuotes[h.instrumentKey];
    if (!q?.prevClose || !q.price || !quotedToday(q, now)) continue;
    const ch = q.price / q.prevClose - 1;
    const i = h.instrument;
    const name = shortName(i?.name ?? h.instrumentKey);
    const ids = [i?.ticker, name, i?.isin, h.instrumentKey];
    const lv = level(ch, forHolding(env.moveOverrides, ids) ?? env.positionMovePct);
    if (lv > (moves.pos[h.instrumentKey] ?? 0)) {
      moves.pos[h.instrumentKey] = lv;
      // HUF move of the position today: value now minus value at prev close.
      const move = h.marketValueHuf - h.marketValueHuf / (1 + ch);
      posLines.push(
        `${ch > 0 ? "🚀" : "🔻"} <b>${name}: ${pct(ch, 1)}</b> ma (${sft(move)}, pozíció: ${mft(h.marketValueHuf)})`,
      );
    }
    if ((moves.pos[h.instrumentKey] ?? 0) > 0) {
      const subject = forHolding(env.whySubjects, ids);
      moved.push({
        key: h.instrumentKey,
        label: name,
        pct: ch,
        name: i?.name ?? h.instrumentKey,
        currency: h.currency,
        ...(i?.type ? { type: i.type } : {}),
        ...(i?.ticker ? { ticker: i.ticker } : {}),
        ...(i?.isin ? { isin: i.isin } : {}),
        ...(subject ? { subject } : {}),
      });
    }
  }
  const eur = ctx.liveQuotes["EUR"];
  if (marketMovedToday && eur?.prevClose && eur.price && quotedToday(eur, now)) {
    const ch = eur.price / eur.prevClose - 1;
    const lv = level(ch, env.positionMovePct);
    if (lv > (moves.pos[FX_KEY] ?? 0)) {
      moves.pos[FX_KEY] = lv;
      posLines.push(
        `${ch > 0 ? "🚀" : "🔻"} <b>EUR/HUF: ${pct(ch, 1)}</b> ma (${eur.price.toFixed(2).replace(".", ",")} Ft)`,
      );
    }
    if ((moves.pos[FX_KEY] ?? 0) > 0) moved.push({ key: FX_KEY, label: "EUR/HUF", pct: ch });
  }
  if (posLines.length) out.push(msg(posLines.join("\n")));

  if (st.why?.day !== today) st.why = { day: today, explained: [], runs: 0 };
  const why = st.why;
  const unexplained = moved.filter((f) => !why.explained.includes(f.key));
  const open =
    why.request != null &&
    st.whyTaken !== why.request.at &&
    now.getTime() - Date.parse(why.request.at) < WHY_REQUEST_TTL_MS;
  if (unexplained.length && !open && why.runs < WHY_MAX_RUNS_PER_DAY) {
    why.request = {
      at: now.toISOString(),
      factors: unexplained,
      ...(unexplained.some((f) => f.key === "portfolio") ? { exposure: portfolioExposure(ctx) } : {}),
    };
    why.explained.push(...unexplained.map((f) => f.key));
    why.runs++;
  }

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
  out.push(...bondNoticeMessages(ctx, st).map((html) => msg(html)));

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

  const year = today.slice(0, 4);
  if (now.getHours() >= 8 && st.lastYearly !== year) {
    if (st.lastYearly) out.push(msg(yearlyText(ctx)));
    st.lastYearly = year;
  }
  if (now.getMonth() === 4 && now.getDate() <= 20 && now.getHours() >= 9 && st.taxReminded !== year) {
    st.taxReminded = year;
    const tax = taxReminderText(ctx);
    if (tax) out.push(msg(tax));
  }

  const planMonth = effectiveMonthKey(now);
  if (
    now.getDate() >= PLAN_REMINDER_DAY &&
    planMonth === ym &&
    now.getHours() >= 9 &&
    st.planReminded !== planMonth
  ) {
    st.planReminded = planMonth;
    const text = planReminderText(ctx);
    if (text) out.push(msg(text));
  }

  const goals = goalMilestoneMessages(ctx, st);
  if (goals.length) out.push(msg(goals.join("\n")));
  for (const text of wealthMessages(ctx, st, env)) out.push(msg(text));
  for (const text of priceAlertMessages(ctx, st)) out.push(msg(text));
  const stalePrices = stalePriceMessage(ctx, st);
  if (stalePrices) out.push(msg(stalePrices));
  return out;
}
