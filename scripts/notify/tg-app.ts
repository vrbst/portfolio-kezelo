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
import { claudeCodeEngine, type EngineRun, type NewsEngine } from "./news/engine";
import { deadlineForJob } from "./jobDeadline";
import { aiCostText, appendAiUsage, readAiUsage, type AiUsageRecord } from "./aiUsage";
import { latestDigest, makeDigest, repoStore, type NewsDeps, type NewsStore } from "./news/job";
import {
  EVENT_JSON_SCHEMA,
  MAX_SEARCH_TRIES,
  RETRY_MIN,
  advanceSlots,
  askEvent,
  buildEventPrompt,
  combineCoverage,
  recordLatency,
  eventText,
  followUpsText,
  nextDue,
  patchSlot,
  publishEvents,
  publishSignature,
  registerFollowUps,
  slotStart,
  slotsToProbe,
  toResults,
  watchLine,
} from "./news/events";
import { probeCoverage, type Coverage } from "./news/rss";
import { portfolioExposure } from "./news/prompt";
import { makeAnalysis, type AnalysisDeps } from "./analysis/job";
import { WHY_JSON_SCHEMA, askWhy, buildWhyPrompt, whyText, type WhyFactor } from "./news/why";
import { ANALYSIS_SCHEMA } from "../../src/lib/aiAnalysis";
import { NEWS_EDITION_LABEL, assetKey, digestAssets, type DigestAsset, type NewsEdition } from "../../src/lib/newsSchema";
import { CHART_PREFIX, chartButtons, chartCaption, chartCard, chartMenuText, chartTargets, chartText, findTarget, type ChartTarget } from "./chart";
import { chartSvg, svgToPng } from "./chartImage";
import { loadContext, withGlideAlerts, type Context } from "./data";
import { loadState, updateState, type EventSlot, type State } from "./state";
import { isDeepGlideAlert, updateGlideSignals } from "../../src/lib/rebalance";
import { bypassesQuietHours, type Alert } from "../../src/lib/alerts";
import { consolidatedHoldings } from "../../src/lib/portfolio";
import {
  intradaySwing,
  quotedToday,
  resolveYahooSymbol,
  type LiveQuote,
} from "../../src/lib/prices";
import { refreshFundamentals, yahooFetcher, type FundamentalsDeps } from "./fundamentals";
import { refreshOutlook, type OutlookDeps, type OutlookTarget } from "./outlook/refresh";
import { fetchImpliedBands } from "./outlook/optionsImplied";
import { OUTLOOK_AI_SCHEMA } from "./outlook/aiViews";
import { CONSENSUS_SCHEMA } from "./outlook/aiDocs";
import { collectIssuerDocs, defaultIssuerFetch, type IssuerDocsDeps } from "./outlook/issuerDocs";
import { weeklyOutlookAi, type WeeklyOutlookDeps } from "./outlook/weekly";
import { addDaysIso, toLocalDay } from "../../src/lib/day";
import {
  alertLine,
  alertsText,
  appRecordedLeftover,
  esc,
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
  analysisText,
  newsAssetText,
  newsText,
  pct,
  planText,
  px,
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
import { goalMilestoneMessages, stalePriceMessage, wealthEvents } from "./watch";
import { effectiveMonthKey } from "../../src/lib/goals";
import {
  loadLeftoverSettings,
  loadMoveAlertSettings,
  loadNotifySettings,
  type NotifyKind,
} from "../../src/lib/planPrefs";
import { FX_MOVE_KEY } from "../../src/lib/moveAlerts";
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
  buttons?: { text: string; data: string }[][];
  /** A picture (PNG/JPEG); `html` becomes its caption. */
  photo?: { base64: string; name?: string };
}

export interface HubResponse {
  v: 1;
  ok?: false;
  error?: string;
  messages?: HubMessage[];
  expectText?: { context: string; ttl: string };
  /** Answer a button press by replacing the pressed message. */
  editOriginal?: true;
  /** Job did nothing: an earlier failure stays open (no "recovered" message). */
  keepFailing?: true;
  /** The app's quiet hours (null = none); the hub keeps the latest. */
  quietHours?: { from: string; to: string } | null;
}

export interface Deps {
  load: () => Promise<Context>;
  stateFile: string;
  env: Pick<NotifyEnv, "bigMovePct" | "positionMovePct" | "wealthStepHuf" | "drawdownStepPct"> &
    Partial<Pick<NotifyEnv, "moveOverrides" | "whySubjects">>;
  /** The daily news digest's AI and storage (built only when needed). */
  news?: (job?: string) => NewsDeps;
  why?: () => NewsEngine;
  /** The AI of the announcement follow-up searches (news/events.ts). */
  events?: () => NewsEngine;
  /** Whether the news already cover an announcement (default: Google News RSS); a test seam. */
  probe?: typeof probeCoverage;
  /** The nightly AI analysis's AI and storage (built only when needed). */
  analysis?: () => AnalysisDeps;
  fundamentals?: () => FundamentalsDeps;
  /** The daily, AI-free outlook sources (Yahoo targets, Deribit bands). */
  outlook?: () => OutlookDeps;
  /** The issuers' consensus documents (found daily, read by the weekly run). */
  outlookDocs?: () => IssuerDocsDeps;
  /** The weekly outlook run: Claude Code on the subscription. */
  outlookAi?: () => WeeklyOutlookDeps;
  aiUsageFile?: string;
  /** Called with each request before it is handled (run_id and job deadline of the AI calls). */
  bindRequest?: (req: HubRequest) => void;
  /** SVG → PNG for /chart (default: headless Chromium); a test seam. */
  renderPng?: (svg: string) => Promise<Buffer>;
  /** Start one of our jobs at the hub now (it runs apart from this request). */
  runJob?: (job: string) => Promise<"started" | "running">;
}

export function defaultDeps(): Deps {
  const env = loadEnv();
  const aiUsageFile = resolve(NOTIFY_DIR, "ai-usage.jsonl");
  const logRun = (job: string, model: string) => (run: EngineRun) =>
    appendAiUsage(aiUsageFile, aiUsageRecord(job, model, run));
  // Every AI call goes to the my-claude-hub; this request's id is its run_id
  // there, and a time-windowed job's calls share one start deadline.
  const call: { runId?: string; deadline?: Date } = {};
  const engine = (o: Pick<Parameters<typeof claudeCodeEngine>[0], "model" | "schema" | "tools" | "priority" | "onRun">) =>
    claudeCodeEngine({
      hub: { baseUrl: env.hubUrl, apiKey: env.hubKey },
      runId: call.runId,
      deadline: call.deadline,
      ...o,
    });
  return {
    load: () => loadContext(env, aiUsageFile),
    stateFile: resolve(NOTIFY_DIR, "state.json"),
    env,
    bindRequest: (req) => {
      call.runId = req.id;
      call.deadline = req.type === "job" ? deadlineForJob(req.job, Date.now()) : undefined;
    },
    news: (job = "news") => ({
      engine: engine({ model: env.newsModel, priority: "normal", onRun: logRun(job, env.newsModel) }),
      store: repoStore(env.syncRepo, newsGithubToken),
      cacheDir: resolve(NOTIFY_DIR, "news"),
      appUrl: env.appUrl,
    }),
    analysis: () => ({
      // No tools: it reasons over the snapshot alone, nothing to look up.
      engine: engine({
        model: env.analysisModel,
        schema: ANALYSIS_SCHEMA,
        tools: "",
        priority: "background",
        onRun: logRun(ANALYSIS_JOB, env.analysisModel),
      }),
      store: repoStore(env.syncRepo, newsGithubToken),
      cacheDir: resolve(NOTIFY_DIR, "analysis"),
    }),
    why: () =>
      engine({
        model: env.whyModel,
        schema: WHY_JSON_SCHEMA,
        priority: "interactive",
        onRun: logRun(WHY_JOB, env.whyModel),
      }),
    events: () =>
      engine({
        model: env.newsModel,
        schema: EVENT_JSON_SCHEMA,
        priority: "normal",
        onRun: logRun(EVENT_JOB, env.newsModel),
      }),
    aiUsageFile,
    runJob: hubRunJob,
    fundamentals: () => {
      let session: ReturnType<typeof yahooFetcher> | undefined;
      return {
        resolve: (t) => resolveYahooSymbol({ key: t.key, isin: t.isin, currency: t.currency }),
        fetch: async (symbol) => (await (session ??= yahooFetcher()))(symbol),
        store: repoStore(env.syncRepo, newsGithubToken),
      };
    },
    outlook: () => {
      let session: ReturnType<typeof yahooFetcher> | undefined;
      return {
        resolve: (t) => resolveYahooSymbol({ key: t.key, isin: t.isin, currency: t.currency }),
        fetch: async (symbol) => (await (session ??= yahooFetcher()))(symbol),
        bands: (underlying, nowMs) => fetchImpliedBands(underlying, nowMs),
        store: repoStore(env.syncRepo, newsGithubToken),
      };
    },
    outlookAi: () => ({
      engine: engine({
        model: env.outlookModel,
        schema: OUTLOOK_AI_SCHEMA,
        priority: "background",
        onRun: logRun(OUTLOOK_AI_JOB, env.outlookModel),
      }),
      store: repoStore(env.syncRepo, newsGithubToken),
      stateFile: resolve(NOTIFY_DIR, "outlook", "ai-state.json"),
      // No tools: it reads only the document text it is handed.
      docEngine: engine({
        model: env.outlookModel,
        schema: CONSENSUS_SCHEMA,
        tools: "",
        priority: "background",
        onRun: logRun(OUTLOOK_AI_JOB, env.outlookModel),
      }),
      docsDir: resolve(NOTIFY_DIR, "outlook"),
    }),
    outlookDocs: () => ({ dir: resolve(NOTIFY_DIR, "outlook"), ...defaultIssuerFetch() }),
  };
}

export function aiUsageRecord(job: string, model: string, run: EngineRun, at = new Date()): AiUsageRecord {
  const u = run.usage;
  return {
    at: at.toISOString(),
    job,
    model,
    ok: run.ok,
    ...(run.error ? { error: run.error } : {}),
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheCreationTokens: u?.cacheCreationTokens ?? 0,
    cacheReadTokens: u?.cacheReadTokens ?? 0,
    webSearches: u?.webSearches ?? 0,
    ...(u?.turns != null ? { turns: u.turns } : {}),
    durationMs: u?.durationMs ?? run.durationMs,
    ...(u?.costUsd != null ? { costUsd: u.costUsd } : {}),
    ...(u?.models ? { models: u.models } : {}),
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
    const req = JSON.parse(input) as HubRequest;
    deps.bindRequest?.(req);
    res = await handleRequest(req, deps);
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
      if (req.command === "hirek") return latestNews(req.args, deps, false);
      if (req.command === "hirkereses") return searchNews(deps);
      if (req.command === "bejelentesek") return followUps(deps);
      if (req.command === "riasztas") return priceAlerts(req.args, deps);
      if (req.command === "koltseg") return aiCost(deps);
      if (req.command === "chart") return chart(req.args, deps, false);
      return req.command === "maradek"
        ? leftover(req.args, deps)
        : command(req.command, deps);
    case "text":
      // Only the amount after a bare /maradek is expected (expectText).
      if (req.context === "maradek") return leftover(req.text, deps);
      return { v: 1, messages: [msg("Ehhez most nem tudok mit kezdeni. A parancsokat a /help sorolja fel.")] };
    case "callback":
      if (req.data.startsWith(CHART_PREFIX)) return chart(req.data.slice(CHART_PREFIX.length), deps, true);
      if (req.data.startsWith(NEWS_PREFIX)) return latestNews(req.data.slice(NEWS_PREFIX.length), deps, true);
      return { v: 1, messages: [] };
    case "job":
      console.error(`job ${req.job}`);
      if (req.job === "tick") return tick(deps);
      if (req.job === "news-morning") return news(deps, "morning", req.manual === true);
      if (req.job === "news-evening") return news(deps, "evening", req.manual === true);
      if (req.job === ANALYSIS_JOB) return analysisJob(deps, req.manual === true);
      if (req.job === WHY_JOB) return whyMoved(deps);
      if (req.job === EVENT_JOB) return eventsJob(deps);
      if (req.job === FUNDAMENTALS_JOB) return fundamentalsJob(deps);
      if (req.job === OUTLOOK_JOB) return outlookJob(deps);
      if (req.job === OUTLOOK_AI_JOB) return outlookAiJob(deps, "primary", req.manual === true);
      if (req.job === OUTLOOK_AI_RETRY_JOB) return outlookAiJob(deps, "retry", req.manual === true);
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

function aiCost(deps: Deps): HubResponse {
  const records = deps.aiUsageFile ? readAiUsage(deps.aiUsageFile) : [];
  return { v: 1, messages: [msg(aiCostText(records, new Date()))] };
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

/**
 * /chart [papír]: the price cards' two-session curve as text. Without a (known)
 * name a button menu; a button press swaps the pressed message for that chart,
 * keeping the buttons so the next asset is one tap away.
 */
async function chart(query: string, deps: Deps, fromButton: boolean): Promise<HubResponse> {
  const ctx = await contextFor(deps);
  if (typeof ctx === "string") return fail(ctx);
  const targets = chartTargets(ctx);
  const target = findTarget(targets, query);
  const edit = fromButton ? ({ editOriginal: true } as const) : {};
  if (!target) {
    const note = query.trim() && !fromButton ? `Nem találom: <code>${esc(query.trim())}</code>.\n\n` : "";
    return {
      v: 1,
      messages: [{ ...msg(note + chartMenuText(targets)), buttons: chartButtons(targets) }],
      ...edit,
    };
  }
  return {
    v: 1,
    messages: [await chartMessage(ctx, target, targets, deps)],
    ...edit,
  };
}

/** The chart as an image; any rendering failure falls back to the text chart. */
async function chartMessage(
  ctx: Context,
  target: ChartTarget,
  targets: ChartTarget[],
  deps: Deps,
): Promise<HubMessage> {
  const buttons = chartButtons(targets, target.key);
  const card = chartCard(ctx, target);
  if (card) {
    try {
      const png = await (deps.renderPng ?? svgToPng)(chartSvg(card));
      return {
        ...msg(chartCaption(card)),
        buttons,
        photo: { base64: png.toString("base64"), name: `${target.label.replace(/\W+/g, "-")}.png` },
      };
    } catch (e) {
      console.error("chart image failed:", (e as Error).message);
    }
  }
  return { ...msg(chartText(ctx, target)), buttons };
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
  // Switched off in the app: no search at all (a manual run or /hirkereses is a request).
  const mode = loadNotifySettings().ai[edition === "morning" ? "newsMorning" : "newsEvening"];
  const scheduled = !onDemand && !manual;
  if (scheduled && mode === "off") {
    console.error(`news: ${edition} switched off`);
    return { v: 1, messages: [] };
  }
  const nd = deps.news(onDemand ? "hirkereses" : `news-${edition}`);
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
  // The announcements the digest lists with a time become follow-ups (also
  // when the digest itself stays silent).
  let watching: string | undefined;
  if (loadNotifySettings().ai.events !== "off") {
    const ev = updateState(deps.stateFile, (cur) => {
      const events = registerFollowUps(cur.events, run.digest, ctx.at);
      // Nothing to follow and nothing followed before: leave the state alone.
      return events.slots.length || cur.events ? { ...cur, events } : cur;
    }).events;
    if (run.digest.edition === "morning") watching = watchLine(ev, today);
    await publishEventsSafe(deps, nd.store);
  }
  if (scheduled && mode === "silent") return { v: 1, messages: [] };
  return {
    v: 1,
    messages: [msg(newsText(run.digest, ctx, nd.appUrl, run.uploadError, watching), onDemand)],
  };
}

// ---- following up the announcements ---------------------------------------

export const EVENT_JOB = "news-event";

/** news/events.json brought up to date with the state (a failure is logged, the next change retries). */
async function publishEventsSafe(deps: Deps, store: NewsStore): Promise<void> {
  const ev = loadState(deps.stateFile).events;
  if (!ev || (!ev.pending?.length && ev.published === publishSignature(ev))) return;
  // Never followed anything: no file to keep current.
  if (!ev.slots.length && !ev.pending?.length && ev.published === undefined) return;
  const sent = ev.pending ?? [];
  try {
    const published = await publishEvents(store, ev, sent);
    updateState(deps.stateFile, (cur) =>
      cur.events
        ? {
            ...cur,
            events: {
              ...cur.events,
              published,
              pending: (cur.events.pending ?? []).filter((p) => !sent.some((q) => q.key === p.key)),
            },
          }
        : cur,
    );
  } catch (e) {
    console.error("news-event: events.json upload failed:", (e as Error).message);
  }
}

/** /bejelentesek: what is followed, in what state, and the learned delays. */
function followUps(deps: Deps): HubResponse {
  return { v: 1, messages: [msg(followUpsText(loadState(deps.stateFile).events, new Date()))] };
}

/**
 * The tick's part: probe the news for the announcements that are out, move
 * the slots on, keep news/events.json current, and start the job when a
 * search is due. Never throws (the tick has other work).
 */
async function followEvents(deps: Deps): Promise<void> {
  try {
    if (loadNotifySettings().ai.events === "off") return;
    const now = new Date();
    const before = loadState(deps.stateFile).events;
    if (!before?.slots.length) return;
    const probe = deps.probe ?? probeCoverage;
    // Every event of every watched slot, at once: a slow feed (10 s each)
    // must not hold the tick up one probe after the other.
    const probes: Record<string, Coverage | null> = {};
    await Promise.all(
      slotsToProbe(before, now).map(async (s) => {
        const since = slotStart(s.date, s.time);
        const names = s.events.length ? s.events.map((e) => e.query ?? e.event) : [s.kind];
        probes[s.key] = combineCoverage(await Promise.all(names.map((n) => probe(s.kind, n, since))));
      }),
    );
    const after = updateState(deps.stateFile, (cur) =>
      cur.events ? { ...cur, events: advanceSlots(cur.events, now, probes).ev } : cur,
    ).events;
    if (deps.news) await publishEventsSafe(deps, deps.news(EVENT_JOB).store);
    if (nextDue(after, now) && deps.runJob) await deps.runJob(EVENT_JOB);
  } catch (e) {
    console.error("news-event: follow-up step failed:", (e as Error).message);
  }
}

/**
 * Job "news-event": the first announcement whose search is due → one AI
 * search for the result, the expectation, the reaction and the outlook → the
 * sync repo and one message. The tick starts it as soon as the news cover an
 * announcement; every 15 minutes (tg-hub.app.json) it also picks up retries
 * (the result wasn't out yet) and a start the tick missed.
 */
async function eventsJob(deps: Deps): Promise<HubResponse> {
  if (!deps.events || !deps.news) return fail("Az esemény-utókövetés nincs beállítva.");
  const now = new Date();
  // Expired slots and the ones a crashed search held are settled first.
  updateState(deps.stateFile, (cur) =>
    cur.events ? { ...cur, events: advanceSlots(cur.events, now).ev } : cur,
  );
  const settled = loadState(deps.stateFile).events;
  if (!nextDue(settled, now)) {
    // Nothing to do — but after a failed search that is no recovery.
    const live = settled?.slots.some((s) => s.status === "due" || s.status === "searching");
    if (settled?.failing && !live)
      updateState(deps.stateFile, (cur) =>
        cur.events ? { ...cur, events: { ...cur.events, failing: false } } : cur,
      );
    return { v: 1, messages: [], ...(settled?.failing && live ? { keepFailing: true as const } : {}) };
  }

  // The app's settings (ai.events) come into this process with the context.
  const ctx = await contextFor(deps);
  if (typeof ctx === "string") return fail(ctx);
  const mode = loadNotifySettings().ai.events;
  if (mode === "off") return { v: 1, messages: [] };

  const holder: { slot?: EventSlot } = {};
  updateState(deps.stateFile, (cur) => {
    const due = nextDue(cur.events, now);
    if (!cur.events || !due) return cur;
    holder.slot = due;
    return {
      ...cur,
      events: patchSlot(cur.events, due.key, (s) => ({
        ...s,
        status: "searching",
        takenAt: now.toISOString(),
        tries: s.tries + 1,
      })),
    };
  });
  const slot = holder.slot;
  if (!slot) return { v: 1, messages: [] };

  /** The slot is free again: searched again after a while, or (giveUp) never. */
  const release = (failing: boolean, giveUp = false) =>
    updateState(deps.stateFile, (cur) =>
      cur.events
        ? {
            ...cur,
            events: {
              ...patchSlot(cur.events, slot.key, (s) => ({
                ...s,
                status: giveUp ? "expired" : "due",
                takenAt: undefined,
                dueAt: new Date(now.getTime() + RETRY_MIN * 60_000).toISOString(),
              })),
              failing,
            },
          }
        : cur,
    );

  const engine = deps.events();
  const started = Date.now();
  let result: Awaited<ReturnType<typeof askEvent>>;
  try {
    result = await askEvent(engine, buildEventPrompt({ slot, now, exposure: portfolioExposure(ctx) }));
  } catch (e) {
    release(true);
    throw e;
  }
  const { answer, costUsd } = result;
  console.error(
    `news-event: ${slot.key} ${answer.released ? `${answer.items.length} result(s)` : "not out yet"} in ${Math.round((Date.now() - started) / 1000)} s` +
      (costUsd != null ? `, ~$${costUsd.toFixed(2)} at API prices` : ""),
  );
  if (!answer.released) {
    // A preview can look like coverage: after a few misses the slot is given up.
    release(false, slot.tries + 1 >= MAX_SEARCH_TRIES);
    await publishEventsSafe(deps, deps.news(EVENT_JOB).store);
    return { v: 1, messages: [] };
  }
  // An approximate slot's start is not the release: no latency to show.
  const latencyMin = slot.firstSeenAt && !slot.approx
    ? Math.max(0, Math.round((Date.parse(slot.firstSeenAt) - Date.parse(slot.startsAt)) / 60_000))
    : undefined;
  const results = toResults(slot, answer, {
    engine: engine.name,
    model: engine.model,
    at: now,
    ...(costUsd != null ? { costUsd } : {}),
    ...(latencyMin != null ? { latencyMin } : {}),
  });
  const found = new Date();
  updateState(deps.stateFile, (cur) =>
    cur.events
      ? {
          ...cur,
          events: {
            ...recordLatency(
              patchSlot(cur.events, slot.key, (s) => ({ ...s, status: "done", takenAt: undefined })),
              slot,
              found,
            ),
            pending: [...(cur.events.pending ?? []), ...results],
            failing: false,
          },
        }
      : cur,
  );
  await publishEventsSafe(deps, deps.news(EVENT_JOB).store);
  if (mode === "silent") return { v: 1, messages: [] };
  return { v: 1, messages: [msg(eventText(results))] };
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

/** Callback data of the /hirek buttons: `news:<asset>`, or `news:*` for the whole digest. */
export const NEWS_PREFIX = "news:";
const NEWS_ALL = "*";
/** Asset buttons on the /hirek menu (the most mentioned first). */
const NEWS_BUTTONS_MAX = 15;

/** One button per asset the digest touches, three to a row, plus "Mind"; the open one is marked. */
export function newsButtons(all: DigestAsset[], current?: string): NonNullable<HubMessage["buttons"]> {
  const mark = (on: boolean, text: string) => (on ? `▸ ${text}` : text);
  const assets = all
    .filter((a) => new TextEncoder().encode(NEWS_PREFIX + a.label).length <= 64)
    .slice(0, NEWS_BUTTONS_MAX);
  const mind = { text: mark(current === NEWS_ALL, "Mind"), data: NEWS_PREFIX + NEWS_ALL };
  const rows: { text: string; data: string }[][] = [[mind]];
  assets.forEach((a, i) => {
    if (i % 3 === 0) rows.push([]);
    rows[rows.length - 1].push({
      text: mark(current != null && assetKey(current) === a.key, a.label),
      data: NEWS_PREFIX + a.label,
    });
  });
  return rows;
}

/**
 * /hirek [papír]: without an argument the newest digest's assets as buttons
 * (plus "Mind" = the whole digest, as before); a button or a typed asset shows
 * that asset's news. A button press replaces the pressed message and keeps the
 * buttons, so the next asset is one tap away.
 */
async function latestNews(query: string, deps: Deps, fromButton: boolean): Promise<HubResponse> {
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
  const edit = fromButton ? ({ editOriginal: true } as const) : {};
  const q = query.trim();
  const assets = digestAssets(digest.items);
  const asset = q === NEWS_ALL || !q ? undefined : assets.find((a) => a.key === assetKey(q));
  const hasAssets = assets.length > 0;
  // No argument: the menu (a digest without any asset has nothing to pick: show it whole).
  if (!q && hasAssets)
    return {
      v: 1,
      messages: [{ ...msg("📰 <b>Melyik papír hírei érdekelnek?</b>"), buttons: newsButtons(assets) }],
      ...edit,
    };
  if (asset)
    return {
      v: 1,
      messages: [{ ...msg(newsAssetText(digest, asset.label, nd.appUrl)), buttons: newsButtons(assets, asset.label) }],
      ...edit,
    };
  // The whole digest: "Mind", or an asset that isn't in it (typed wrong, or an old
  // button after a newer digest came out) with a note saying so.
  const note = q && q !== NEWS_ALL ? `Nem találok ilyen papírt a hírek között: <code>${esc(q)}</code>. Itt az egész összefoglaló.

` : "";
  return {
    v: 1,
    messages: [{ ...msg(note + newsText(digest, ctx, nd.appUrl)), ...(hasAssets ? { buttons: newsButtons(assets, NEWS_ALL) } : {}) }],
    ...edit,
  };
}

// ---- the nightly AI analysis --------------------------------------------

export const ANALYSIS_JOB = "analysis";

/**
 * Job "analysis" (Tue–Sat in the small hours, so every weekday's close is in
 * it, tg-hub.app.json): the app's AI analysis, run with Claude Code on the
 * subscription → the sync repo and one message (the hub holds it back until
 * the quiet hours end). Once a day by schedule; a manual run sends today's
 * again from the local copy (this also retries a failed upload).
 */
async function analysisJob(deps: Deps, manual: boolean): Promise<HubResponse> {
  if (!deps.analysis) return fail("Az éjszakai AI-elemzés nincs beállítva.");
  const ctx = await contextFor(deps);
  if (typeof ctx === "string") return fail(ctx);
  const today = toLocalDay(ctx.at);
  if (!manual && loadState(deps.stateFile).analysis === today) {
    console.error(`analysis: ${today} done already`);
    return { v: 1, messages: [] };
  }
  const mode = loadNotifySettings().ai.analysis;
  if (!manual && mode === "off") {
    console.error("analysis: switched off");
    return { v: 1, messages: [] };
  }
  const run = await makeAnalysis(ctx, deps.analysis(), { reuseLocal: manual });
  if (!manual)
    updateState(deps.stateFile, (cur) => ({ ...cur, analysis: run.analysis.day }));
  if (!manual && mode === "silent") return { v: 1, messages: [] };
  return {
    v: 1,
    messages: [msg(analysisText(run.analysis, loadEnv().appUrl, run.uploadError))],
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
  // After the load: that is what brings the app's settings (ai.events) into
  // this process.
  await followEvents(deps);
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
    events: cur.events,
    priceAlerts: (cur.priceAlerts ?? []).filter((a) => kept.has(a.id) || !alertIds.has(a.id)),
    whyTaken: cur.whyTaken,
    whyFailing: cur.whyFailing,
  }));
  const request = st.why?.request?.at;
  if (request && request !== asked && deps.runJob)
    try {
      await deps.runJob(WHY_JOB);
    } catch (e) {
      console.error("why: job start failed:", (e as Error).message);
    }
  return { v: 1, messages, quietHours: loadNotifySettings().quietHours };
}

export const WHY_JOB = "news-why";
export const FUNDAMENTALS_JOB = "fundamentals";

const QUOTED_TYPES = new Set(["etf", "stock", "fund"]);

/** The held, quoted papers (what fundamentals and the outlook look at). */
async function heldTargets(deps: Deps): Promise<{ targets: OutlookTarget[]; at: Date }> {
  const ctx = await deps.load();
  const targets = consolidatedHoldings(ctx.summary)
    .filter((h) => h.quantity > 1e-9 && h.instrument && QUOTED_TYPES.has(h.instrument.type))
    .map((h) => ({
      key: h.instrumentKey,
      name: shortName(h.instrument!.name),
      isin: h.instrument!.isin ?? h.instrumentKey,
      currency: h.currency,
      type: h.instrument!.type as OutlookTarget["type"],
    }));
  return { targets, at: ctx.at };
}

async function fundamentalsJob(deps: Deps): Promise<HubResponse> {
  if (!deps.fundamentals) return { v: 1, messages: [] };
  const { targets, at } = await heldTargets(deps);
  const { messages } = await refreshFundamentals(targets, deps.fundamentals(), at);
  if (loadNotifySettings().off.fundamentals) return { v: 1, messages: [] };
  return { v: 1, messages: messages.map((m) => msg(m)) };
}

// ---- the outlook: analyst targets and market-implied ranges ---------------

export const OUTLOOK_JOB = "outlook";
export const OUTLOOK_AI_JOB = "outlook-ai";
export const OUTLOOK_AI_RETRY_JOB = "outlook-ai-retry";

/** Job "outlook" (daily, no AI): profiles, Yahoo targets, option-implied bands. */
async function outlookJob(deps: Deps): Promise<HubResponse> {
  if (!deps.outlook) return { v: 1, messages: [] };
  const { targets, at } = await heldTargets(deps);
  const { file, messages } = await refreshOutlook(targets, deps.outlook(), at);
  if (deps.outlookDocs) {
    // The issuers' own consensus documents: only found and kept here (no AI);
    // the weekly run reads them. A failure costs nothing but today's check.
    try {
      const { saved, errors } = await collectIssuerDocs(file, deps.outlookDocs(), at);
      if (saved.length) console.error(`outlook: new consensus document for ${saved.join(", ")}`);
      for (const [k, e] of Object.entries(errors)) console.error(`outlook: consensus document ${k}: ${e}`);
    } catch (e) {
      console.error("outlook: consensus documents failed:", (e as Error).message);
    }
  }
  return { v: 1, messages: messages.map((m) => msg(m)) };
}

/**
 * Jobs "outlook-ai" (Saturday 04:30, before the 08:00 usage-limit reset) and
 * "outlook-ai-retry" (Saturday 08:15): the weekly run on the subscription. Both
 * run only while this week has no successful run. A failure of the first one is
 * quiet, because the retry follows; only the failure of the retry is reported.
 */
async function outlookAiJob(deps: Deps, kind: "primary" | "retry", manual: boolean): Promise<HubResponse> {
  if (!deps.outlookAi) return fail("A heti kilátás-gyűjtés nincs beállítva.");
  const { targets, at } = await heldTargets(deps);
  if (!targets.length) return { v: 1, messages: [] };
  const out = await weeklyOutlookAi(targets, deps.outlookAi(), at, { manual });
  if (out.status === "skipped") {
    console.error("outlook-ai: this week is done already");
    return { v: 1, messages: [] };
  }
  if (out.status === "failed") {
    console.error(`outlook-ai: failed (${out.reason}): ${out.message}`);
    if (kind === "primary" && !manual) return { v: 1, messages: [] };
    return fail(
      `A heti kilátás-gyűjtés nem sikerült${out.reason === "limit" ? " (az előfizetési keret kimerült)" : ""}: ${out.message}. Az előző heti adatok maradnak.`,
    );
  }
  console.error(`outlook-ai: ${out.result.views} nézet ${out.result.assets} eszközhöz`);
  return {
    v: 1,
    messages: manual ? [msg(`📈 Kilátások frissítve: ${out.result.views} nézet ${out.result.assets} eszközhöz.`)] : [],
  };
}
const FX_KEY = FX_MOVE_KEY;
export const WHY_MAX_RUNS_PER_DAY = 3;
export const WHY_REQUEST_TTL_MS = 3 * 3_600_000;

async function whyMoved(deps: Deps): Promise<HubResponse> {
  if (!deps.why) return fail("A „Miért mozdult?” keresés nincs beállítva.");
  const now = new Date();
  const st = loadState(deps.stateFile);
  const req = st.why?.request;
  if (!req || st.whyTaken === req.at || now.getTime() - Date.parse(req.at) > WHY_REQUEST_TTL_MS)
    // Nothing to do — but after a failed search that is no recovery.
    return { v: 1, messages: [], ...(st.whyFailing ? { keepFailing: true as const } : {}) };
  updateState(deps.stateFile, (cur) => ({ ...cur, whyTaken: req.at }));
  const [y, m, d] = st.why!.day.split("-").map(Number);
  const prompt = buildWhyPrompt({
    day: st.why!.day,
    weekday: new Date(y, m - 1, d).getDay(),
    factors: req.factors,
    exposure: req.exposure,
  });
  const started = Date.now();
  let result: Awaited<ReturnType<typeof askWhy>>;
  try {
    result = await askWhy(deps.why(), prompt, req.factors);
  } catch (e) {
    // Release the request: the next run (every 30 min, until the request
    // expires) tries again. Otherwise that run would find it taken and
    // finish "successfully" with nothing done — the hub would announce a
    // recovery that never happened.
    updateState(deps.stateFile, (cur) => (cur.whyTaken === req.at ? { ...cur, whyTaken: undefined, whyFailing: req.at } : cur));
    throw e;
  }
  updateState(deps.stateFile, (cur) => ({ ...cur, whyFailing: undefined }));
  const { answer, costUsd } = result;
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
 * from the due hour (default WEEKLY_REPORT_HOUR, settable in the app) through the weekend; Monday–Friday before it none.
 */
export function weeklyReportFriday(now: Date, hour = WEEKLY_REPORT_HOUR): string | null {
  const back = { 5: 0, 6: 1, 0: 2 }[now.getDay()];
  if (back === undefined || (back === 0 && now.getHours() < hour)) return null;
  return addDaysIso(toLocalDay(now), -back);
}

/** What's new since the last tick; advances `st` (pure apart from that). */
export function tickMessages(ctx: Context, st: State, env: Deps["env"]): HubMessage[] {
  const now = ctx.at;
  const ns = loadNotifySettings();
  const out: HubMessage[] = [];
  // Every message is built (so the state moves on) but a switched-off type
  // is dropped: turning it back on must not replay what piled up meanwhile.
  const send = (kind: NotifyKind, ...m: HubMessage[]) => {
    if (!ns.off[kind]) out.push(...m);
  };
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
  send("alerts", ...alertMessages(fresh.filter((a) => !isDeepGlideAlert(a))));
  send("deepGlide", ...alertMessages(fresh.filter(isDeepGlideAlert)));
  for (const a of fresh) st.sentAlerts[a.id] = now.toISOString();
  // Resolved alerts are forgotten, so a later re-trigger is new again.
  for (const id of Object.keys(st.sentAlerts))
    if (!active.has(id)) delete st.sentAlerts[id];

  // 2) Big daily moves: the whole portfolio and single positions, each
  //    re-reported only when it crosses the next threshold level.
  if (st.moves?.day !== today) st.moves = { day: today, total: 0, pos: {} };
  const moves = st.moves;
  const moveSettings = loadMoveAlertSettings();
  const positionStep = (key: string, ids: (string | undefined)[]) =>
    moveSettings.byKey[key] ??
    forHolding(env.moveOverrides, ids) ??
    moveSettings.positionPct ??
    env.positionMovePct;
  const level = (x: number, step: number) =>
    Math.floor((Math.abs(x) * 100 + 1e-9) / step);
  const crosses = (x: number, reported: number, step: number) => level(x, step) > level(reported, step);
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
  if (st.why?.day !== today) st.why = { day: today, explained: [], runs: 0 };
  const why = st.why;
  // A reversal off the day's low / high is its own event: a position that fell
  // 6% and bounced back to -3% is quiet on the previous-close scale. It pings
  // on the same step, once per level, but not when it only repeats the move
  // already reported off the previous close (a straight +3% from the open).
  type Swing = NonNullable<WhyFactor["swing"]>;
  const swingKey = (key: string, s: Swing) => `${key}:swing-${s.from === "low" ? "up" : "down"}`;
  const swingMoves = (key: string, ch: number, q: LiveQuote, step: number) => {
    const sw = intradaySwing(q, now);
    const fired: Swing[] = [];
    const seen: Swing[] = [];
    if (!sw) return { fired, seen };
    const rep = moves.swing?.[key] ?? { up: 0, down: 0 };
    const store = (r: { up: number; down: number }) => ((moves.swing ??= {})[key] = r);
    if (crosses(sw.up, rep.up, step) && (ch <= 0 || level(sw.up, step) > level(ch, step))) {
      fired.push({ from: "low", pct: sw.up });
      rep.up = sw.up;
      store(rep);
    }
    if (crosses(sw.down, rep.down, step) && (ch >= 0 || level(sw.down, step) > level(ch, step))) {
      fired.push({ from: "high", pct: sw.down });
      rep.down = Math.abs(sw.down);
      store(rep);
    }
    // The reported level (the one that fired), not today's size of the swing:
    // after a retrace the current figure is small and the "why" would explain a
    // reversal that is no longer one.
    if (rep.up > 0) seen.push({ from: "low", pct: rep.up });
    if (rep.down > 0) seen.push({ from: "high", pct: -rep.down });
    return { fired, seen };
  };
  const swingLine = (name: string, s: Swing, ch: number, tail: string) =>
    `${s.from === "low" ? "↗️" : "↘️"} <b>${name}: ${pct(s.pct, 1)}</b> a mai ${s.from === "low" ? "mélypontjától" : "csúcsától"} (ma: ${pct(ch, 1)}), ${tail}`;
  // The newest reversal not yet explained today (the larger one if both).
  const pendingSwing = (key: string, seen: Swing[]) =>
    seen
      .filter((s) => !why.explained.includes(swingKey(key, s)))
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0];
  // The daily level crossing right after a reversal that was already reported
  // is the same move seen twice: the day's low (high) sat at the previous
  // close, so "+0.5% off the low" and "+0.5% today" differ only by rounding.
  // The level moves on, but neither a message nor a second search follows.
  const coveredBySwing = (key: string, ch: number, q: LiveQuote, step: number) => {
    const sw = intradaySwing(q, now);
    const rep = moves.swing?.[key];
    if (!sw || !rep) return false;
    const [reported, off] = ch > 0 ? [rep.up, sw.up] : [rep.down, sw.down];
    return reported > 0 && level(ch, step) <= level(reported, step) && level((1 + ch) / (1 + off) - 1, step) === 0;
  };
  const settle = (key: string, ch: number, q: LiveQuote, step: number) => {
    if (!coveredBySwing(key, ch, q, step)) return false;
    if (!why.explained.includes(key)) why.explained.push(key);
    return true;
  };
  const moved: { factor: WhyFactor; daily: boolean }[] = [];
  const dc = ctx.dayChange;
  if (dc?.pct != null && dc.note === "ma" && marketMovedToday) {
    if (crosses(dc.pct, moves.total, moveSettings.portfolioPct ?? env.bigMovePct)) {
      moves.total = Math.abs(dc.pct);
      send(
        "portfolioMove",
        msg(
          `${dc.abs > 0 ? "🚀" : "🔻"} <b>Nagy mozgás ma: ${pct(dc.pct, 2)}</b> (${sft(dc.abs)})\nVagyon: ${ft(ctx.summary.totalValueHuf)}`,
        ),
      );
    }
    if (moves.total > 0)
      moved.push({ factor: { key: "portfolio", label: "portfólió", pct: dc.pct }, daily: true });
  }
  const posLines: string[] = [];
  for (const h of held) {
    const q = ctx.liveQuotes[h.instrumentKey];
    if (!q?.prevClose || !q.price || !quotedToday(q, now)) continue;
    const ch = q.price / q.prevClose - 1;
    const i = h.instrument;
    const name = shortName(i?.name ?? h.instrumentKey);
    const ids = [i?.ticker, name, i?.isin, h.instrumentKey];
    const step = positionStep(h.instrumentKey, ids);
    if (crosses(ch, moves.pos[h.instrumentKey] ?? 0, step)) {
      const same = settle(h.instrumentKey, ch, q, step);
      moves.pos[h.instrumentKey] = Math.abs(ch);
      // HUF move of the position today: value now minus value at prev close.
      const move = h.marketValueHuf - h.marketValueHuf / (1 + ch);
      if (!same)
        posLines.push(
          `${ch > 0 ? "🚀" : "🔻"} <b>${name}: ${pct(ch, 1)}</b> ma, árfolyam: ${px(q.price, h.currency)} (${sft(move)}, pozíció: ${mft(h.marketValueHuf)})`,
        );
    }
    const sw = swingMoves(h.instrumentKey, ch, q, step);
    for (const s of sw.fired)
      posLines.push(
        swingLine(name, s, ch, `árfolyam: ${px(q.price, h.currency)} (pozíció: ${mft(h.marketValueHuf)})`),
      );
    const daily = (moves.pos[h.instrumentKey] ?? 0) > 0;
    const swing = pendingSwing(h.instrumentKey, sw.seen);
    if (daily || swing) {
      const subject = forHolding(env.whySubjects, ids);
      moved.push({
        daily,
        factor: {
          key: h.instrumentKey,
          label: name,
          pct: ch,
          name: i?.name ?? h.instrumentKey,
          currency: h.currency,
          ...(i?.type ? { type: i.type } : {}),
          ...(i?.ticker ? { ticker: i.ticker } : {}),
          ...(i?.isin ? { isin: i.isin } : {}),
          ...(subject ? { subject } : {}),
          ...(swing ? { swing } : {}),
        },
      });
    }
  }
  const eur = ctx.liveQuotes["EUR"];
  if (marketMovedToday && eur?.prevClose && eur.price && quotedToday(eur, now)) {
    const ch = eur.price / eur.prevClose - 1;
    if (crosses(ch, moves.pos[FX_KEY] ?? 0, positionStep(FX_KEY, ["EUR"]))) {
      const same = settle(FX_KEY, ch, eur, positionStep(FX_KEY, ["EUR"]));
      moves.pos[FX_KEY] = Math.abs(ch);
      if (!same)
        posLines.push(
          `${ch > 0 ? "🚀" : "🔻"} <b>EUR/HUF: ${pct(ch, 1)}</b> ma (${eur.price.toFixed(2).replace(".", ",")} Ft)`,
        );
    }
    const sw = swingMoves(FX_KEY, ch, eur, positionStep(FX_KEY, ["EUR"]));
    for (const s of sw.fired)
      posLines.push(swingLine("EUR/HUF", s, ch, `${eur.price.toFixed(2).replace(".", ",")} Ft`));
    const daily = (moves.pos[FX_KEY] ?? 0) > 0;
    const swing = pendingSwing(FX_KEY, sw.seen);
    if (daily || swing)
      moved.push({
        daily,
        factor: { key: FX_KEY, label: "EUR/HUF", pct: ch, ...(swing ? { swing } : {}) },
      });
  }
  if (posLines.length) send("positionMove", msg(posLines.join("\n")));

  // Per factor: the move off the previous close and the reversal each get
  // searched once a day.
  const pending = (m: (typeof moved)[number]) =>
    (m.daily && !why.explained.includes(m.factor.key)) ||
    (m.factor.swing != null && !why.explained.includes(swingKey(m.factor.key, m.factor.swing)));
  const todo = moved.filter(pending);
  const unexplained = todo.map((m) => m.factor);
  const open =
    why.request != null &&
    st.whyTaken !== why.request.at &&
    now.getTime() - Date.parse(why.request.at) < WHY_REQUEST_TTL_MS;
  if (ns.ai.why !== "off" && unexplained.length && !open && why.runs < WHY_MAX_RUNS_PER_DAY) {
    why.request = {
      at: now.toISOString(),
      factors: unexplained,
      ...(unexplained.some((f) => f.key === "portfolio") ? { exposure: portfolioExposure(ctx) } : {}),
    };
    for (const m of todo) {
      if (m.daily && !why.explained.includes(m.factor.key)) why.explained.push(m.factor.key);
      if (m.factor.swing) why.explained.push(swingKey(m.factor.key, m.factor.swing));
    }
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
      send("stale", msg(text));
    } else if (days <= limit) delete st.warned[key];
  }
  send("bondNotices", ...bondNoticeMessages(ctx, st).map((html) => msg(html)));

  // 4) Weekly (Friday from 18:00, after the Xetra close; caught up on the
  //    weekend if the hub was down) and monthly (the 1st from 08:00) reports.
  const friday = weeklyReportFriday(now, ns.weeklyHour);
  if (friday && (st.lastWeekly ?? "") < friday) {
    st.lastWeekly = friday;
    send("weekly", msg(weeklyText(ctx)));
  }
  const ym = today.slice(0, 7);
  if (now.getHours() >= ns.monthlyHour && st.lastMonthly !== ym) {
    // First run ever: don't fire a report for a month we joined halfway.
    if (st.lastMonthly) send("monthly", msg(monthlyText(ctx)));
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
  if (now.getHours() >= ns.monthlyHour && st.lastYearly !== year) {
    if (st.lastYearly) send("yearly", msg(yearlyText(ctx)));
    st.lastYearly = year;
  }
  if (now.getMonth() === 4 && now.getDate() <= 20 && now.getHours() >= 9 && st.taxReminded !== year) {
    st.taxReminded = year;
    const tax = taxReminderText(ctx);
    if (tax) send("tax", msg(tax));
  }

  const planMonth = effectiveMonthKey(now);
  if (
    now.getDate() >= ns.planReminderDay &&
    planMonth === ym &&
    now.getHours() >= 9 &&
    st.planReminded !== planMonth
  ) {
    st.planReminded = planMonth;
    const text = planReminderText(ctx);
    if (text) send("planReminder", msg(text));
  }

  const goals = goalMilestoneMessages(ctx, st);
  if (goals.length) send("goalMilestones", msg(goals.join("\n")));
  const wealthEnv = {
    wealthStepHuf: ns.wealthStepHuf ?? env.wealthStepHuf,
    drawdownStepPct: ns.drawdownStepPct ?? env.drawdownStepPct,
  };
  for (const e of wealthEvents(ctx, st, wealthEnv)) send(e.kind, msg(e.text));
  for (const text of priceAlertMessages(ctx, st)) send("priceAlerts", msg(text));
  const stalePrices = stalePriceMessage(ctx, st);
  if (stalePrices) send("stalePrices", msg(stalePrices));
  return out;
}
