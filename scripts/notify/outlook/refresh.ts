import { toLocalDay } from "../../../src/lib/day";
import {
  OUTLOOK_PATH,
  staleOutlookErrors,
  validateOutlookFile,
  type Consensus,
  type ImpliedBand,
  type Outlook,
  type OutlookFile,
  type OutlookProfile,
} from "../../../src/lib/outlook";
import type { NewsStore } from "../news/job";
import { esc } from "../reports";
import { classifyForOutlook } from "./profile";
import { parseAnalystTargets } from "./yahooTargets";

const NOTIFY_EVERY_MS = 7 * 86_400_000;

export interface OutlookTarget {
  key: string;
  name: string;
  isin: string;
  currency: string;
  type: "etf" | "stock" | "fund";
}

export interface OutlookDeps {
  resolve: (t: OutlookTarget) => Promise<string | null>;
  /** Yahoo quoteSummary (with financialData and recommendationTrend). */
  fetch: (symbol: string) => Promise<unknown>;
  /** The option-implied bands of an underlying; null = no option market. */
  bands: (underlying: string, nowMs: number) => Promise<ImpliedBand[] | null>;
  store: NewsStore;
}

const shortErr = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

function parsePrevious(text: string, now: Date): OutlookFile | null {
  try {
    return validateOutlookFile(JSON.parse(text), now);
  } catch {
    return null;
  }
}

interface YahooIdentity {
  quoteType?: string;
  names: string[];
}

/** What Yahoo calls the paper: its type, long/short name and fund category. */
const identityOf = (json: unknown): YahooIdentity => {
  const q = (
    json as {
      quoteSummary?: {
        result?:
          | { price?: Record<string, unknown>; fundProfile?: Record<string, unknown> }[]
          | null;
      };
    }
  )?.quoteSummary?.result?.[0];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    quoteType: str(q?.price?.quoteType),
    names: [q?.price?.longName, q?.price?.shortName, q?.fundProfile?.categoryName].flatMap((v) => str(v) ?? []),
  };
};

/**
 * What kind of asset this is. A profile the weekly AI run (or the user) set
 * stays; otherwise the rules guess it again, so a re-typed instrument follows.
 */
function profileFor(
  t: OutlookTarget,
  prev: OutlookProfile | undefined,
  yahoo: YahooIdentity | null,
  now: Date,
): OutlookProfile | null {
  // Without Yahoo's answer today the rules would guess from the bare name and
  // could flip a known profile (a bitcoin product back to an equity fund).
  if (prev && (prev.source !== "rule" || !yahoo)) return prev;
  const rule = classifyForOutlook({ name: t.name, type: t.type }, yahoo);
  if (!rule) return null;
  return {
    assetClass: rule.assetClass,
    ...(rule.underlying ? { underlying: rule.underlying } : {}),
    source: "rule",
    checkedAt: now.toISOString(),
  };
}

/**
 * The daily, AI-free part: for every held asset, work out its profile and pull
 * the sources that profile calls for (Yahoo analyst targets for shares,
 * option-implied bands for crypto products). Issuer consensus and the AI's
 * named views are written by the weekly run and carried over untouched.
 */
export async function refreshOutlook(
  targets: OutlookTarget[],
  deps: OutlookDeps,
  now: Date,
): Promise<{ file: OutlookFile; messages: string[] }> {
  const prevText = await deps.store.read(OUTLOOK_PATH).catch(() => null);
  const prev = prevText ? parsePrevious(prevText, now) : null;
  const file: OutlookFile = { v: 1, updatedAt: now.toISOString(), profiles: {}, items: {}, errors: {} };
  if (prev?.notifiedAt) file.notifiedAt = prev.notifiedAt;

  for (const t of targets) {
    let json: unknown = null;
    let summaryError: string | undefined;
    try {
      const symbol = await deps.resolve(t);
      if (!symbol) throw new Error("nincs Yahoo-szimbólum");
      json = await deps.fetch(symbol);
    } catch (e) {
      summaryError = shortErr(e);
    }
    const profile = profileFor(t, prev?.profiles[t.key], json ? identityOf(json) : null, now);
    if (profile) file.profiles[t.key] = profile;

    const old = prev?.items[t.key];
    const consensus: Consensus[] = (old?.consensus ?? []).filter((c) => c.source === "issuer");
    let implied: ImpliedBand[] | undefined;
    // Only the source this kind of asset needs can fail it.
    let error: string | undefined;

    if (profile?.assetClass === "equity") {
      const fresh = json ? parseAnalystTargets(json, now) : null;
      const kept = old?.consensus?.find((c) => c.source === "yahoo");
      if (fresh) consensus.unshift(fresh);
      else if (summaryError && kept) consensus.unshift(kept);
      error = summaryError;
    } else if (profile?.assetClass === "crypto" && profile.underlying) {
      implied = old?.implied;
      try {
        const bands = await deps.bands(profile.underlying, now.getTime());
        if (bands) implied = bands;
      } catch (e) {
        error = shortErr(e);
      }
    }

    const item: Outlook = {};
    if (consensus.length) item.consensus = consensus;
    if (implied?.length) item.implied = implied;
    if (old?.views?.length) item.views = old.views;
    if (Object.keys(item).length) file.items[t.key] = item;
    if (error) file.errors[t.key] = { since: prev?.errors[t.key]?.since ?? now.toISOString(), message: error };
  }

  const messages: string[] = [];
  const stale = staleOutlookErrors(file, now);
  if (!stale.length) delete file.notifiedAt;
  else if (!file.notifiedAt || now.getTime() - Date.parse(file.notifiedAt) >= NOTIFY_EVERY_MS) {
    file.notifiedAt = now.toISOString();
    const names = new Map(targets.map((t) => [t.key, t.name]));
    messages.push(
      [
        "⚠️ <b>A kilátás-adatok (célárak, opciós sáv) letöltése napok óta nem sikerül</b>",
        ...stale.map(
          ([k, e]) =>
            `• ${esc(names.get(k) ?? k)}: ${esc(e.message)} (${toLocalDay(Date.parse(e.since))} óta)`,
        ),
        "Az app a legutóbbi sikeres adatot mutatja.",
      ].join("\n"),
    );
  }
  await deps.store.write(OUTLOOK_PATH, JSON.stringify(file), `outlook ${toLocalDay(now)}`);
  return { file, messages };
}
