// The issuer's own analyst consensus (e.g. OTP's investor-relations PDF,
// published every few weeks as ..._YYYYMMDD.pdf). The daily outlook job finds
// the newest document and keeps its text as "pending"; the weekly AI run turns
// that text into numbers (aiDocs.ts). No issuer-specific parser: the profile's
// consensusUrl is all that is known about the issuer.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDaysIso, toLocalDay } from "../../../src/lib/day";
import type { OutlookFile } from "../../../src/lib/outlook";
import { pdfToText } from "./pdfText";

/** How far ahead of the last known document a newer one is looked for. */
export const MAX_PROBE_DAYS = 75;
export const MAX_PDF_BYTES = 8 * 1024 * 1024;

const DATE_IN_URL = /(?<![0-9])(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?![0-9])/;

export interface UrlTemplate {
  before: string;
  after: string;
  /** Local day of the document the URL points to. */
  day: string;
}

/** "…/OTP_analyst_consensus_20260803.pdf" → the pattern with the date cut out. */
export function urlTemplate(url: string): UrlTemplate | null {
  const m = DATE_IN_URL.exec(url);
  if (!m) return null;
  return { before: url.slice(0, m.index), after: url.slice(m.index + 8), day: `${m[1]}-${m[2]}-${m[3]}` };
}

export const urlFor = (t: UrlTemplate, day: string) => `${t.before}${day.replace(/-/g, "")}${t.after}`;

/** The days after `fromDay` up to `toDay`, newest first, at most MAX_PROBE_DAYS. */
export function candidateDays(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let d = addDaysIso(fromDay, 1); d <= toDay && out.length < MAX_PROBE_DAYS; d = addDaysIso(d, 1)) out.push(d);
  return out.reverse();
}

export interface Fetched {
  ok: boolean;
  contentType: string;
  bytes: Uint8Array;
}

export interface IssuerDocsDeps {
  /** .notify/outlook: where state and pending texts live. */
  dir: string;
  head: (url: string) => Promise<boolean>;
  get: (url: string) => Promise<Fetched>;
}

export function defaultIssuerFetch(): Pick<IssuerDocsDeps, "head" | "get"> {
  return {
    head: async (url) => {
      try {
        const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000), redirect: "follow" });
        return res.ok && !/text\/html/i.test(res.headers.get("content-type") ?? "");
      } catch {
        return false;
      }
    },
    get: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_PDF_BYTES) throw new Error(`túl nagy dokumentum (${len} bájt)`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_PDF_BYTES) throw new Error(`túl nagy dokumentum (${bytes.length} bájt)`);
      return { ok: res.ok, contentType: res.headers.get("content-type") ?? "", bytes };
    },
  };
}

export interface IssuerState {
  /** Per asset: the newest document seen and what was done with it. */
  [key: string]: { latestUrl?: string; latestDay?: string; handledUrl?: string; handledHash?: string };
}

export interface PendingDoc {
  key: string;
  url: string;
  fetchedAt: string;
  text: string;
}

const statePath = (dir: string) => join(dir, "issuer-state.json");
const pendingDir = (dir: string) => join(dir, "pending");
const pendingPath = (dir: string, key: string) => join(pendingDir(dir), `${encodeURIComponent(key)}.json`);

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function readIssuerState(dir: string): IssuerState {
  try {
    return JSON.parse(readFileSync(statePath(dir), "utf8")) as IssuerState;
  } catch {
    return {};
  }
}

export function listPending(dir: string): PendingDoc[] {
  if (!existsSync(pendingDir(dir))) return [];
  return readdirSync(pendingDir(dir)).flatMap((f) => {
    if (!f.endsWith(".json")) return [];
    try {
      const d = JSON.parse(readFileSync(join(pendingDir(dir), f), "utf8")) as PendingDoc;
      return d?.key && d.url && d.text ? [d] : [];
    } catch {
      return [];
    }
  });
}

export function removePending(dir: string, key: string) {
  rmSync(pendingPath(dir, key), { force: true });
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const isPdf = (f: Fetched) => /pdf/i.test(f.contentType) || new TextDecoder().decode(f.bytes.slice(0, 5)) === "%PDF-";

const hasIssuerConsensus = (file: OutlookFile | null, key: string, url: string) =>
  !!file?.items[key]?.consensus?.some((c) => c.source === "issuer" && c.url === url);

/**
 * For every asset whose profile names a consensus document: find the newest
 * one, and when it is new, keep its text as pending. A failure for one asset
 * only costs that asset today; it returns what went wrong per asset.
 */
export async function collectIssuerDocs(
  file: OutlookFile,
  deps: IssuerDocsDeps,
  now: Date,
): Promise<{ saved: string[]; errors: Record<string, string> }> {
  const state = readIssuerState(deps.dir);
  const saved: string[] = [];
  const errors: Record<string, string> = {};
  const today = toLocalDay(now);
  for (const [key, profile] of Object.entries(file.profiles)) {
    const base = profile.consensusUrl;
    if (!base) continue;
    try {
      const st = state[key] ?? {};
      const tpl = urlTemplate(st.latestUrl ?? base);
      let url = st.latestUrl ?? base;
      let day = st.latestDay ?? tpl?.day;
      // A dated address: look for a newer document, newest candidate first.
      if (tpl && day) {
        for (const d of candidateDays(day, today)) {
          const candidate = urlFor(tpl, d);
          if (await deps.head(candidate)) {
            url = candidate;
            day = d;
            break;
          }
        }
      }
      state[key] = { ...st, latestUrl: url, ...(day ? { latestDay: day } : {}) };
      if (hasIssuerConsensus(file, key, url)) state[key].handledUrl = url;
      // A dated address names its document: the one handled already is not fetched again.
      if (tpl && state[key].handledUrl === url) continue;
      const fetched = await deps.get(url);
      if (!fetched.ok) throw new Error(`a dokumentum nem tölthető le (${url})`);
      if (!isPdf(fetched)) throw new Error("a konszenzus-cím nem PDF-et ad");
      const hash = sha(fetched.bytes);
      // Dated address: the URL says "new". Fixed address: the content does.
      const already = tpl ? state[key].handledUrl === url : state[key].handledHash === hash;
      if (already || hasIssuerConsensus(file, key, url)) {
        state[key].handledUrl = url;
        state[key].handledHash = hash;
        continue;
      }
      const text = await pdfToText(fetched.bytes);
      if (text.trim().length < 200) throw new Error("a PDF-ben nincs olvasható szöveg");
      mkdirSync(pendingDir(deps.dir), { recursive: true });
      const doc: PendingDoc = { key, url, fetchedAt: now.toISOString(), text };
      writeAtomic(pendingPath(deps.dir, key), JSON.stringify(doc));
      state[key].handledUrl = url;
      state[key].handledHash = hash;
      saved.push(key);
    } catch (e) {
      errors[key] = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }
  mkdirSync(deps.dir, { recursive: true });
  writeAtomic(statePath(deps.dir), JSON.stringify(state, null, 2));
  return { saved, errors };
}
