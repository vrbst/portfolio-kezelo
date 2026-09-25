// Config + Node shims for the Telegram notifier. Secrets and state live in
// .notify/ (gitignored) at the repo root — never in the repo itself.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const NOTIFY_DIR = resolve(ROOT, ".notify");
const ENV_FILE = resolve(NOTIFY_DIR, ".env");

export interface NotifyEnv {
  botToken: string;
  /** Empty until paired (the first private message to the bot sets it). */
  chatId: string;
  /** owner/repo of the private sync repo and the snapshot's path in it. */
  syncRepo: string;
  syncPath: string;
  /** Public repo whose public/prices.json + history.json the Action commits. */
  pricesRepo: string;
  /** Idle-cash alert threshold (HUF) — per-device in the app, set here. */
  idleCashHuf: number;
  /** Daily portfolio move (%) that triggers a "big move" message. */
  bigMovePct: number;
  /** Daily move (%) of a single position that triggers a message. */
  positionMovePct: number;
  /** Quiet hours "HH:MM-HH:MM": non-urgent messages wait until they end. */
  quiet: [number, number];
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

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

export function loadEnv(): NotifyEnv {
  const e = { ...parseEnvFile(), ...process.env } as Record<string, string>;
  if (!e.TELEGRAM_BOT_TOKEN)
    throw new Error(`Hiányzik a TELEGRAM_BOT_TOKEN (${ENV_FILE})`);
  const [qs, qe] = (e.NOTIFY_QUIET || "22:00-07:30").split("-");
  return {
    botToken: e.TELEGRAM_BOT_TOKEN,
    chatId: e.TELEGRAM_CHAT_ID || "",
    syncRepo: e.SYNC_REPO || "vrbst/portfolio-data",
    syncPath: e.SYNC_PATH || "data.json",
    pricesRepo: e.PRICES_REPO || "vrbst/portfolio-kezelo",
    idleCashHuf: Number(e.NOTIFY_IDLE_CASH_HUF) || 100_000,
    bigMovePct: Number(e.NOTIFY_BIG_MOVE_PCT) || 2,
    positionMovePct: Number(e.NOTIFY_POSITION_MOVE_PCT) || 5,
    quiet: [toMinutes(qs), toMinutes(qe)],
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
