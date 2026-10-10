// The notifier's own business state (.notify/state.json): what has already
// been sent, so a tick only reports what's new. Polling, quiet-hour queues and
// heartbeats are tg-hub's (its own state), not ours.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GlideSignals } from "../../src/lib/rebalance";
import type { NewsEdition } from "../../src/lib/newsSchema";
import type { WhyFactor } from "./news/why";

export interface State {
  /** Alert id → when it was first sent. Pruned when the alert resolves. */
  sentAlerts: Record<string, string>;
  lastWeekly?: string; // YYYY-MM-DD of the Friday whose report was sent
  lastMonthly?: string; // YYYY-MM
  /**
   * Today's last reported |move| (fraction): a new message goes out only when
   * the move crosses a higher multiple of the current threshold than the one
   * already reported, so a 2% day pings once, and again if it deepens to 4%.
   */
  moves?: { day: string; total: number; pos: Record<string, number> };
  /** Stale-data warnings: key → last sent ISO (re-sent at most weekly). */
  warned: Record<string, string>;
  /**
   * Glide-path re-alert state (last alerted distance per out-of-band
   * bucket). The app keeps its own copy; both run updateGlideSignals.
   */
  glideSignals?: GlideSignals;
  /**
   * Month-end leftover: the month (YYYY-MM) already asked about, and the
   * amounts answered with /maradek per month (the app's recorded plan is the
   * other "already done" signal — it comes with the sync).
   */
  leftover?: { asked?: string; answered?: Record<string, number> };
  /**
   * ISO of the first tick in the current run of transient load failures
   * (network, timeout); cleared by a successful load. Until it's older than
   * the grace period the tick stays silent (tg-app.ts).
   */
  loadFailingSince?: string;
  news?: NewsState;
  /** Local day (YYYY-MM-DD) of the last scheduled nightly AI analysis. */
  analysis?: string;
  goalLevels?: Record<string, number>;
  wealth?: WealthState;
  planReminded?: string;
  lastYearly?: string;
  taxReminded?: string;
  priceAlerts?: PriceAlert[];
  bondNotices?: {
    maturity?: Record<string, string>;
    periods?: Record<string, { start: string; rate: number }>;
    switches?: Record<string, string>;
  };
  why?: WhyState;
  whyTaken?: string;
  /** `at` of the request whose last search failed; cleared by the next success. */
  whyFailing?: string;
}

export interface WealthState {
  step: number;
  peakPl: number;
  peakValue: number;
  peakDay: string;
  drawdown: number;
}

export interface PriceAlert {
  id: string;
  key: string;
  label: string;
  currency: string;
  fx: boolean;
  op: "below" | "above";
  level: number;
  createdAt: string;
}

export interface WhyState {
  day: string;
  explained: string[];
  runs: number;
  request?: { at: string; factors: WhyFactor[]; exposure?: string[] };
}

export type NewsState = {
  /** Per edition: the last local day (YYYY-MM-DD) the scheduled run made it. */
  [E in NewsEdition]?: string;
} & {
  /** ISO: /hirkereses asked for a fresh search; the news job it starts takes it. */
  searchRequestedAt?: string;
  /** ISO: the last on-demand search (the 30-minute guard). */
  lastSearchAt?: string;
};

/** Fields of the old self-polling bot, now kept by tg-hub: dropped on load. */
const LEGACY = ["offset", "strangers", "queue", "lastBeat", "lastErrorAt"];

export function loadState(file: string): State {
  const base: State = { sentAlerts: {}, warned: {} };
  try {
    if (!existsSync(file)) return base;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const k of LEGACY) delete raw[k];
    return { ...base, ...raw };
  } catch {
    return base;
  }
}

/**
 * Read–modify–write. The tick (a job) and /maradek (a command) run in
 * separate processes and may overlap: each re-reads the file right before
 * writing and changes only its own fields. The write is atomic, so a process
 * killed on timeout never leaves a half-written file.
 */
export function updateState(file: string, change: (current: State) => State): State {
  const next = change(loadState(file));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file);
  return next;
}
