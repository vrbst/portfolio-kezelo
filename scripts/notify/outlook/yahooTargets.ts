import { toLocalDay } from "../../../src/lib/day";
import { validateConsensus, type Consensus } from "../../../src/lib/outlook";

type Raw = Record<string, unknown> | undefined;
const raw = (v: unknown): number | undefined => {
  const r = (v as { raw?: unknown } | undefined)?.raw;
  return typeof r === "number" && Number.isFinite(r) ? r : undefined;
};
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * Yahoo's analyst view of one symbol (`financialData` + `recommendationTrend`
 * of a quoteSummary answer). Null when no analyst covers it — normal for ETFs
 * and for many Budapest-listed shares.
 */
export function parseAnalystTargets(json: unknown, now: Date): Consensus | null {
  const q = (json as { quoteSummary?: { result?: Raw[] | null } })?.quoteSummary?.result?.[0];
  if (!q) return null;
  const fin = q.financialData as Raw;
  const currency = text((q.price as Raw)?.currency);
  // Pence-quoted listings (GBp/GBX) would need rescaling: left out, not guessed.
  if (!currency || currency === "GBp" || currency === "GBX") return null;
  const count = raw(fin?.numberOfAnalystOpinions);
  const min = raw(fin?.targetLowPrice);
  const avg = raw(fin?.targetMeanPrice);
  const max = raw(fin?.targetHighPrice);
  if (!count || count <= 0 || min == null || avg == null || max == null) return null;
  const trend = (q.recommendationTrend as { trend?: Record<string, unknown>[] } | undefined)?.trend?.[0];
  const n = (k: string) => (typeof trend?.[k] === "number" ? (trend[k] as number) : 0);
  const ratings = trend
    ? { buy: n("strongBuy") + n("buy"), hold: n("hold"), sell: n("sell") + n("strongSell") }
    : undefined;
  return validateConsensus({
    source: "yahoo",
    asOf: toLocalDay(now),
    currency,
    target: { min, avg, max, count },
    ratings,
  });
}
