import { type ImpliedBand } from "../../../src/lib/outlook";
import { HORIZONS_DAYS, impliedBand, pickExpiry } from "./implied";

/** Underlyings Deribit lists (coin-margined) options on. */
export const OPTION_UNDERLYINGS = ["BTC", "ETH"];

const BASE = "https://www.deribit.com/api/v2/public/";
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export interface OptionSummary {
  instrument_name: string;
  mark_iv?: number | null;
  underlying_price?: number | null;
}

/** "BTC-26MAR27-90000-C" → expiry (08:00 UTC, Deribit's settlement time) and strike. */
export function parseOption(name: string): { expiryMs: number; strike: number; call: boolean; key: string } | null {
  const m = name.split("-");
  if (m.length !== 4) return null;
  const d = m[1].match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  const month = d ? MONTHS.indexOf(d[2]) : -1;
  const strike = Number(m[2]);
  if (!d || month < 0 || !Number.isFinite(strike) || (m[3] !== "C" && m[3] !== "P")) return null;
  return { expiryMs: Date.UTC(2000 + +d[3], month, +d[1], 8), strike, call: m[3] === "C", key: m[1] };
}

interface ExpiryQuote {
  expiryMs: number;
  forward: number;
  iv: number;
}

/** Per expiry: the forward and the at-the-money implied volatility (a fraction). */
export function expiryQuotes(options: OptionSummary[]): ExpiryQuote[] {
  const byExpiry = new Map<string, { expiryMs: number; forward: number; rows: { strike: number; iv: number }[] }>();
  for (const o of options) {
    const p = parseOption(o.instrument_name);
    const iv = o.mark_iv;
    const fwd = o.underlying_price;
    if (!p || !iv || !(iv > 0) || !fwd || !(fwd > 0)) continue;
    const e = byExpiry.get(p.key) ?? { expiryMs: p.expiryMs, forward: fwd, rows: [] };
    e.rows.push({ strike: p.strike, iv: iv / 100 });
    byExpiry.set(p.key, e);
  }
  const out: ExpiryQuote[] = [];
  for (const e of byExpiry.values()) {
    const nearest = Math.min(...e.rows.map((r) => Math.abs(r.strike - e.forward)));
    const atm = e.rows.filter((r) => Math.abs(r.strike - e.forward) === nearest);
    out.push({ expiryMs: e.expiryMs, forward: e.forward, iv: atm.reduce((s, r) => s + r.iv, 0) / atm.length });
  }
  return out.sort((a, b) => a.expiryMs - b.expiryMs);
}

/** The bands for the 3/6/12-month horizons from one underlying's option chain. */
export function bandsFromChain(underlying: string, spot: number, options: OptionSummary[], nowMs: number): ImpliedBand[] {
  const quotes = expiryQuotes(options);
  const seen = new Set<number>();
  const out: ImpliedBand[] = [];
  for (const h of HORIZONS_DAYS) {
    const e = pickExpiry(quotes, nowMs, h);
    if (!e || seen.has(e.expiryMs)) continue;
    // A listed expiry far from the horizon says little about that horizon.
    if (Math.abs((e.expiryMs - nowMs) / 86_400_000 - h) > Math.max(30, h * 0.35)) continue;
    const band = impliedBand({ underlying, spot, forward: e.forward, iv: e.iv, expiryMs: e.expiryMs, nowMs });
    if (band) {
      seen.add(e.expiryMs);
      out.push(band);
    }
  }
  return out;
}

type GetJson = (url: string) => Promise<unknown>;

const defaultGetJson: GetJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Deribit ${res.status} ${res.statusText}`);
  return res.json();
};

/** Null: no option market for this underlying (not an error). */
export async function fetchImpliedBands(
  underlying: string,
  nowMs: number,
  getJson: GetJson = defaultGetJson,
): Promise<ImpliedBand[] | null> {
  const u = underlying.toUpperCase();
  if (!OPTION_UNDERLYINGS.includes(u)) return null;
  const idx = (await getJson(`${BASE}get_index_price?index_name=${u.toLowerCase()}_usd`)) as {
    result?: { index_price?: number };
  };
  const spot = idx?.result?.index_price;
  if (!spot || !(spot > 0)) throw new Error("a Deribit nem adott index-árat");
  const sum = (await getJson(`${BASE}get_book_summary_by_currency?currency=${u}&kind=option`)) as {
    result?: OptionSummary[];
  };
  const bands = bandsFromChain(u, spot, sum?.result ?? [], nowMs);
  if (!bands.length) throw new Error("a Deribit opciós láncából nem számolható sáv");
  return bands;
}
