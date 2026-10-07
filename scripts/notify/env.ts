// Config + Node shims for the Telegram notifier (run by the local tg-hub, see
// tg-hub.app.json). Secrets and state live in .notify/ (gitignored) at the
// repo root — never in the repo itself. The bot token, the owner's chat id
// and the quiet hours are the hub's business, not ours.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const NOTIFY_DIR = resolve(ROOT, ".notify");
const ENV_FILE = resolve(NOTIFY_DIR, ".env");

export interface NotifyEnv {
  /** owner/repo of the private sync repo and the snapshot's path in it. */
  syncRepo: string;
  syncPath: string;
  /** Public repo whose public/prices.json + history.json the Action commits. */
  pricesRepo: string;
  /** Idle-cash alert threshold (HUF) — per-device in the app, set here. */
  idleCashHuf: number;
  /** Set-aside goal cash is not idle within this many days of the goal's date. */
  reserveGraceDays: number;
  /** Daily portfolio move (%) that triggers a "big move" message. */
  bigMovePct: number;
  /** Daily move (%) of a single position that triggers a message. */
  positionMovePct: number;
  wealthStepHuf: number;
  drawdownStepPct: number;
  moveOverrides: Record<string, number>;
  whySubjects: Record<string, string>;
  whyModel: string;
  /** Daily news digest (news/): the model Claude Code runs it with. */
  newsModel: string;
  /** Path / name of the Claude Code CLI. */
  newsClaudeBin: string;
  /** The app's address, linked from the Telegram digest. */
  appUrl: string;
}

function parseEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function parseMoveOverrides(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of s.split(",")) {
    const m = part.trim().match(/^([^:\s][^:]*?)\s*:\s*(\d+(?:[.,]\d+)?)$/);
    const pct = m ? Number(m[2].replace(",", ".")) : NaN;
    if (m && pct > 0) out[m[1].trim().toUpperCase()] = pct;
  }
  return out;
}

export function parseWhySubjects(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(";")) {
    const m = part.trim().match(/^([^=\s][^=]*?)\s*=\s*(\S.*)$/);
    if (m) out[m[1].trim().toUpperCase()] = m[2].trim();
  }
  return out;
}

export function forHolding<T>(
  map: Record<string, T> | undefined,
  ids: (string | undefined)[],
): T | undefined {
  if (!map) return undefined;
  for (const id of ids) {
    const v = id ? map[id.trim().toUpperCase()] : undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}

export function loadEnv(): NotifyEnv {
  const e = { ...parseEnvFile(), ...process.env } as Record<string, string>;
  return {
    syncRepo: e.SYNC_REPO || "vrbst/portfolio-data",
    syncPath: e.SYNC_PATH || "data.json",
    pricesRepo: e.PRICES_REPO || "vrbst/portfolio-kezelo",
    idleCashHuf: Number(e.NOTIFY_IDLE_CASH_HUF) || 100_000,
    reserveGraceDays:
      e.NOTIFY_RESERVE_GRACE_DAYS && Number(e.NOTIFY_RESERVE_GRACE_DAYS) >= 0
        ? Number(e.NOTIFY_RESERVE_GRACE_DAYS)
        : 45,
    bigMovePct: Number(e.NOTIFY_BIG_MOVE_PCT) || 1,
    positionMovePct: Number(e.NOTIFY_POSITION_MOVE_PCT) || 1,
    wealthStepHuf: Number(e.NOTIFY_WEALTH_STEP_HUF) || 1_000_000,
    drawdownStepPct: Number(e.NOTIFY_DRAWDOWN_STEP_PCT) || 5,
    moveOverrides: parseMoveOverrides(e.NOTIFY_MOVE_PCT_OVERRIDES ?? "WBIT:4"),
    whySubjects: parseWhySubjects(e.NOTIFY_WHY_SUBJECT ?? "WBIT=Bitcoin (BTC)"),
    whyModel: e.NEWS_WHY_MODEL || "sonnet",
    newsModel: e.NEWS_MODEL || "opus",
    newsClaudeBin: e.NEWS_CLAUDE_BIN || "claude",
    appUrl: e.APP_URL || "https://vrbst.github.io/portfolio-kezelo/",
  };
}

/**
 * GitHub token for the private sync repo: GITHUB_TOKEN from .env if set (a
 * fine-grained, read-only token is best), else the logged-in `gh` CLI's.
 */
export function githubToken(): string {
  const e = parseEnvFile();
  if (process.env.GITHUB_TOKEN || e.GITHUB_TOKEN)
    return (process.env.GITHUB_TOKEN || e.GITHUB_TOKEN)!;
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "Nincs GitHub-token: add meg a GITHUB_TOKEN-t a .notify/.env-ben, vagy jelentkezz be: gh auth login",
    );
  }
}

/**
 * Token that may WRITE the sync repo, for the news digest (news/*.json):
 * NEWS_GITHUB_TOKEN (a fine-grained token with Contents read/write on that
 * one repo), else the read token above — which then fails on the upload.
 */
export function newsGithubToken(): string {
  const e = parseEnvFile();
  return process.env.NEWS_GITHUB_TOKEN || e.NEWS_GITHUB_TOKEN || githubToken();
}

/**
 * In-memory localStorage: the app's lib modules read their planning prefs
 * (savings goals, forecast settings, allocation) from it. Seeded per run from
 * the synced snapshot, so it always mirrors the cloud copy.
 */
export function installLocalStorage() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as unknown as { localStorage: typeof ls }).localStorage = ls;
}
