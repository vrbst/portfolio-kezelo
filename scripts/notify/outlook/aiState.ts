import { toLocalDay } from "../../../src/lib/day";

export interface OutlookAiState {
  /** ISO week ("2026-W42") of the last successful weekly run. */
  lastSuccessWeek?: string;
  lastAttempt?: { at: string; ok: boolean; reason?: "limit" | "error"; message?: string };
}

/** ISO-8601 week of a local day, "YYYY-Www" (Mon–Sun, so Sat and Sun share one). */
export function isoWeekKey(t: number | Date): string {
  const [y, m, d] = toLocalDay(t).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow); // the Thursday of this week
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Both the 04:30 run and the 08:15 retry ask this: is this week's run still missing? */
export function shouldRunOutlookAi(state: OutlookAiState | null, now: Date): boolean {
  return state?.lastSuccessWeek !== isoWeekKey(now);
}

/** Usage-limit style failures of the Claude CLI (as opposed to a bad answer). */
export function classifyAiFailure(message: string): "limit" | "error" {
  return /usage limit|rate.?limit|quota|limit reached|limit will reset|\b429\b|overloaded|credit/i.test(message)
    ? "limit"
    : "error";
}

export function recordAttempt(
  state: OutlookAiState | null,
  now: Date,
  result: { ok: true } | { ok: false; message: string },
): OutlookAiState {
  const at = now.toISOString();
  if (result.ok) return { lastSuccessWeek: isoWeekKey(now), lastAttempt: { at, ok: true } };
  const message = result.message.slice(0, 300);
  return {
    ...(state?.lastSuccessWeek ? { lastSuccessWeek: state.lastSuccessWeek } : {}),
    lastAttempt: { at, ok: false, reason: classifyAiFailure(message), message },
  };
}
