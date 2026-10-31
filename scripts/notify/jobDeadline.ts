// When may an AI call of a tg-hub job still START? The tg-hub kills a job at
// its `timeout` (schedule.app.json); a call that begins too late would be cut
// off mid-run (the hub still runs it and burns quota, the answer is lost). So
// every call gets a deadline: the job's start + its timeout − the longest a
// call runs − a safety margin. The hub answers deadline_missed past it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./env";
import { ENGINE_TIMEOUT_MS } from "./news/engine";

export const DEADLINE_MARGIN_MS = 3 * 60_000;

/** "90s" / "25m" / "2h" / "6h15m" → ms (the tg-hub descriptor's duration format, compound values too). */
export function parseDuration(s: unknown): number | undefined {
  if (typeof s !== "string" || !/^(\d+(ms|s|m|h|d))+$/.test(s.trim())) return undefined;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let ms = 0;
  for (const [, n, u] of s.trim().matchAll(/(\d+)(ms|s|m|h|d)/g)) ms += Number(n) * unit[u as keyof typeof unit];
  return ms;
}

/** The jobs whose AI calls get a deadline (the ones with a time window). */
export const DEADLINE_JOBS = [
  "news-morning",
  "news-evening",
  "news-event",
  "news-why",
  "analysis",
  "outlook-ai",
  "outlook-ai-retry",
] as const;

/** A job's `timeout` in the descriptor, ms. */
export function jobTimeoutMs(job: string, descriptor = resolve(ROOT, "schedule.app.json")): number | undefined {
  try {
    const d = JSON.parse(readFileSync(descriptor, "utf8")) as { jobs?: { id?: string; timeout?: string }[] };
    return parseDuration(d.jobs?.find((j) => j.id === job)?.timeout);
  } catch {
    return undefined;
  }
}

/** The latest moment a call of the job may start so it still ends before the scheduler stops the job. */
export function jobDeadline(startedAt: number, jobTimeout: number): Date {
  return new Date(startedAt + jobTimeout - ENGINE_TIMEOUT_MS - DEADLINE_MARGIN_MS);
}

/** The deadline of a request's job, or undefined (commands, other jobs, unreadable descriptor). */
export function deadlineForJob(job: string | undefined, startedAt: number): Date | undefined {
  if (!job || !(DEADLINE_JOBS as readonly string[]).includes(job)) return undefined;
  const t = jobTimeoutMs(job);
  return t === undefined ? undefined : jobDeadline(startedAt, t);
}
