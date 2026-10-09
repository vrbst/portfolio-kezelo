import {
  FUNDAMENTALS_PATH,
  staleErrors,
  validateFundamentals,
  validateFundamentalsFile,
  type Fundamentals,
  type FundamentalsFile,
  type Weight,
} from "../../src/lib/fundamentals";
import type { NewsStore } from "./news/job";
import { esc } from "./reports";
import { toLocalDay, utcDay } from "../../src/lib/day";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const MODULES = "price,summaryDetail,summaryProfile,defaultKeyStatistics,topHoldings,fundProfile,calendarEvents";
const NOTIFY_EVERY_MS = 7 * 86_400_000;

export interface FundamentalsTarget {
  key: string;
  name: string;
  isin: string;
  currency: string;
}

export interface FundamentalsDeps {
  resolve: (t: FundamentalsTarget) => Promise<string | null>;
  fetch: (symbol: string) => Promise<unknown>;
  store: NewsStore;
}

type Raw = Record<string, unknown> | undefined;
const raw = (v: unknown): number | undefined => {
  const r = (v as { raw?: unknown } | undefined)?.raw;
  return typeof r === "number" && Number.isFinite(r) ? r : undefined;
};
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const invert = (v: number | undefined) => (v != null && v > 0 ? 1 / v : undefined);
const epochDay = (s: number | undefined) => (s != null ? utcDay(s * 1000) : undefined);

export function parseQuoteSummary(json: unknown, symbol: string, now: Date): Fundamentals {
  const r = (json as { quoteSummary?: { result?: Raw[]; error?: { description?: string } } })?.quoteSummary;
  const q = r?.result?.[0];
  if (!q) throw new Error(r?.error?.description || "üres válasz");
  const price = q.price as Raw;
  const detail = q.summaryDetail as Raw;
  const profile = q.summaryProfile as Raw;
  const stats = q.defaultKeyStatistics as Raw;
  const top = q.topHoldings as Raw;
  const fund = q.fundProfile as Raw;
  const events = (q.calendarEvents as Raw)?.earnings as Raw;
  const quoteType = text(price?.quoteType);
  const isFund = quoteType === "ETF" || quoteType === "MUTUALFUND";
  const equity = top?.equityHoldings as Raw;
  const sectors: Weight[] = Array.isArray(top?.sectorWeightings)
    ? (top.sectorWeightings as Record<string, unknown>[]).flatMap((o) =>
        Object.entries(o).flatMap(([name, v]) => {
          const weight = raw(v);
          return weight != null && weight > 0 ? [{ name, weight }] : [];
        }),
      )
    : [];
  const holdings: Weight[] = Array.isArray(top?.holdings)
    ? (top.holdings as Raw[]).flatMap((h) => {
        const name = text(h?.holdingName);
        const weight = raw(h?.holdingPercent);
        return name && weight != null ? [{ name, weight }] : [];
      })
    : [];
  const earnings = Array.isArray(events?.earningsDate) ? raw((events.earningsDate as unknown[])[0]) : undefined;
  const f = validateFundamentals({
    symbol,
    fetchedAt: now.toISOString(),
    quoteType,
    currency: text(price?.currency) ?? text(detail?.currency),
    sector: text(profile?.sector),
    industry: text(profile?.industry),
    country: text(profile?.country),
    pe: isFund ? invert(raw(equity?.priceToEarnings)) : raw(detail?.trailingPE),
    forwardPe: isFund ? undefined : raw(detail?.forwardPE),
    pb: isFund ? invert(raw(equity?.priceToBook)) : raw(stats?.priceToBook),
    dividendYield: raw(detail?.dividendYield) ?? raw(detail?.yield),
    marketCap: raw(detail?.marketCap),
    beta: raw(detail?.beta),
    nextEarnings: epochDay(earnings),
    totalAssets: raw(detail?.totalAssets) ?? raw(stats?.totalAssets),
    family: text(fund?.family) ?? text(stats?.fundFamily),
    sectors,
    topHoldings: holdings,
  });
  if (!f) throw new Error("hibás adat");
  return f;
}

export async function yahooFetcher(): Promise<(symbol: string) => Promise<unknown>> {
  const first = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": UA },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const cookie = (first.headers.getSetCookie?.() ?? [first.headers.get("set-cookie") ?? ""])
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error("a Yahoo nem adott sütit");
  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie },
    signal: AbortSignal.timeout(15_000),
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumbRes.ok || !crumb || crumb.includes("<") || crumb.length > 64)
    throw new Error(`a Yahoo crumb-kérés nem sikerült (${crumbRes.status})`);
  return async (symbol) => {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Cookie: cookie }, signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => null);
    if (!res.ok && !body) throw new Error(`${res.status} ${res.statusText}`);
    return body;
  };
}

function parsePrevious(text: string): FundamentalsFile | null {
  try {
    return validateFundamentalsFile(JSON.parse(text));
  } catch {
    return null;
  }
}

const shortErr = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function refreshFundamentals(
  targets: FundamentalsTarget[],
  deps: FundamentalsDeps,
  now: Date,
): Promise<{ file: FundamentalsFile; messages: string[] }> {
  const prevText = await deps.store.read(FUNDAMENTALS_PATH).catch(() => null);
  const prev = prevText ? parsePrevious(prevText) : null;
  const file: FundamentalsFile = { v: 1, updatedAt: now.toISOString(), items: {}, errors: {} };
  if (prev?.notifiedAt) file.notifiedAt = prev.notifiedAt;
  for (const t of targets) {
    try {
      const symbol = await deps.resolve(t);
      if (!symbol) throw new Error("nincs Yahoo-szimbólum");
      file.items[t.key] = parseQuoteSummary(await deps.fetch(symbol), symbol, now);
    } catch (e) {
      const old = prev?.items[t.key];
      if (old) file.items[t.key] = old;
      file.errors[t.key] = { since: prev?.errors[t.key]?.since ?? now.toISOString(), message: shortErr(e) };
    }
  }
  const messages: string[] = [];
  const stale = staleErrors(file, now);
  if (!stale.length) delete file.notifiedAt;
  else if (!file.notifiedAt || now.getTime() - Date.parse(file.notifiedAt) >= NOTIFY_EVERY_MS) {
    file.notifiedAt = now.toISOString();
    const names = new Map(targets.map((t) => [t.key, t.name]));
    messages.push(
      [
        "⚠️ <b>A papír-adatok (P/E, szektorok…) letöltése napok óta nem sikerül</b>",
        ...stale.map(
          ([k, e]) =>
            `• ${esc(names.get(k) ?? k)}: ${esc(e.message)} (${toLocalDay(Date.parse(e.since))} óta)`,
        ),
        "Az app a legutóbbi sikeres adatot mutatja. Valószínűleg a Yahoo végpontja változott.",
      ].join("\n"),
    );
  }
  await deps.store.write(FUNDAMENTALS_PATH, JSON.stringify(file), `fundamentals ${toLocalDay(now)}`);
  return { file, messages };
}
