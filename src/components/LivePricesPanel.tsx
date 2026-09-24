import { useEffect, useMemo, useState } from "react";
import { LineChart, RefreshCw } from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import { Card, Sparkline } from "./ui";
import { formatMoney, formatDateTime, formatPercent } from "../lib/format";
import type { Instrument } from "../lib/model";
import type { LiveQuote } from "../lib/prices";
import InstrumentLogo from "./InstrumentLogo";

/** Security types we list as "ETF" tickers (tradable, market-priced). Bonds and
 * cash are excluded — they live on the treasury pages. */
const TICKER_TYPES = new Set(["etf", "stock", "fund"]);

interface Tile {
  key: string;
  label: string;
  sub?: string;
  price: number;
  currency: string;
  live: boolean;
  /** Price is a temporary manual override (beats the live quote). */
  manual: boolean;
  hufEquiv?: number;
  /** Live quote context (previous close, intraday curve), when available. */
  quote?: LiveQuote;
  instrument: Instrument;
}

/**
 * Live price strip for the dashboard: EUR/HUF first, then every market-priced
 * security actually held across the accounts, newest price first. Market prices
 * are public, so this card intentionally ignores privacy mode.
 */
export default function LivePricesPanel() {
  const summary = usePortfolioSummary();
  const prices = usePortfolio((s) => s.prices);
  const livePrices = usePortfolio((s) => s.livePrices);
  const manualPrices = usePortfolio((s) => s.manualPrices);
  const eurHuf = usePortfolio((s) => s.fx["EUR"]);
  const fx = usePortfolio((s) => s.fx);
  const priceUpdatedAt = usePortfolio((s) => s.priceUpdatedAt);
  const refreshPrices = usePortfolio((s) => s.refreshPrices);
  const pricesLoading = usePortfolio((s) => s.pricesLoading);
  const liveQuotes = usePortfolio((s) => s.liveQuotes);

  const tiles = useMemo<Tile[]>(() => {
    // Distinct held securities, aggregated value across accounts for ordering.
    const seen = new Map<string, { inst: Instrument; value: number }>();
    for (const a of summary.accounts) {
      for (const h of a.holdings) {
        const inst = h.instrument;
        if (!inst || !TICKER_TYPES.has(inst.type)) continue;
        if ((h.quantity ?? 0) <= 0) continue;
        const ex = seen.get(inst.key);
        const v = h.marketValueHuf ?? 0;
        if (ex) ex.value += v;
        else seen.set(inst.key, { inst, value: v });
      }
    }

    return [...seen.values()]
      .sort((a, b) => b.value - a.value)
      .flatMap(({ inst }): Tile[] => {
        const price = prices.get(inst.key);
        if (price == null) return [];
        const rate = inst.currency === "HUF" ? 1 : fx[inst.currency];
        const manual = inst.key in manualPrices;
        return [
          {
            key: inst.key,
            label: inst.ticker ?? inst.name,
            sub: inst.ticker ? inst.name : undefined,
            price,
            currency: inst.currency,
            // A manual override wins over the live quote, so it is NOT "live".
            live: !manual && inst.key in livePrices,
            manual,
            hufEquiv:
              inst.currency !== "HUF" && rate ? price * rate : undefined,
            // A manual price has no market context to compare against.
            quote: manual ? undefined : liveQuotes[inst.key],
            instrument: inst,
          },
        ];
      });
  }, [summary, prices, livePrices, manualPrices, fx, liveQuotes]);

  // The exchange status follows the largest held security's listing.
  const session = tiles.find((t) => t.quote?.session)?.quote;

  if (!eurHuf && tiles.length === 0) return null;

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LineChart className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Élő árfolyamok</h2>
        </div>
        <button
          className="btn-ghost"
          onClick={() => refreshPrices()}
          disabled={pricesLoading}
          title={
            priceUpdatedAt
              ? `Frissítve: ${formatDateTime(priceUpdatedAt)}`
              : "Frissítés"
          }
        >
          <RefreshCw
            className={`h-4 w-4 ${pricesLoading ? "animate-spin" : ""}`}
          />
          {priceUpdatedAt && (
            <span className="hidden text-xs font-normal text-[var(--color-muted)] sm:inline">
              {formatDateTime(priceUpdatedAt)}
            </span>
          )}
        </button>
      </div>

      {session?.session && (
        <div className="-mt-2 mb-3">
          <MarketStatus
            session={session.session}
            exchange={session.exchange}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {eurHuf && (
          <PriceTile
            label="EUR/HUF"
            value={formatMoney(eurHuf, "HUF", { decimals: 2 })}
            sub="Euró árfolyam"
            live
            quote={liveQuotes["EUR"]}
          />
        )}
        {tiles.map((t) => (
          <PriceTile
            key={t.key}
            label={t.label}
            value={formatMoney(t.price, t.currency, { decimals: 2 })}
            sub={
              t.hufEquiv != null ? `≈ ${formatMoney(t.hufEquiv, "HUF")}` : t.sub
            }
            live={t.live}
            manual={t.manual}
            quote={t.quote}
            instrument={t.instrument}
          />
        ))}
      </div>
    </Card>
  );
}

function PriceTile({
  label,
  value,
  sub,
  live,
  manual,
  quote,
  instrument,
}: {
  label: string;
  value: string;
  sub?: string;
  live?: boolean;
  manual?: boolean;
  quote?: LiveQuote;
  instrument?: Instrument;
}) {
  const change =
    quote?.prevClose != null ? quote.price / quote.prevClose - 1 : undefined;
  const up = (change ?? 0) >= 0;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4">
      <div className="flex items-center gap-1.5">
        {instrument && <InstrumentLogo instrument={instrument} size={18} />}
        <span className="truncate text-xs font-medium text-[var(--color-muted)]">
          {label}
        </span>
        {manual ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warning,#fbbf24)]"
            title="Kézi árfolyam — a következő frissítéskor visszaáll az élő értékre"
          />
        ) : (
          live && (
            <span
              className="live-dot relative h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-positive)]"
              title="Élő árfolyam"
            />
          )
        )}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {change != null && (
        <span
          className={`mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
            up
              ? "bg-[var(--color-positive)]/12 text-[var(--color-positive)]"
              : "bg-[var(--color-negative)]/12 text-[var(--color-negative)]"
          }`}
          title="Változás az előző záráshoz képest"
        >
          {formatPercent(change)}
        </span>
      )}
      {quote?.intraday && (
        <>
          <div
            className="mt-2 h-6 w-full"
            title={
              quote.intradayFrom
                ? `Mai alakulás a(z) ${quote.intradayFrom} alapján (ennek a jegyzésnek nincs napközbeni adata)`
                : "Mai árfolyam-alakulás"
            }
          >
            <Sparkline
              data={quote.intraday}
              stroke={up ? "var(--color-positive)" : "var(--color-negative)"}
              className="h-full w-full"
            />
          </div>
          {quote.intradayFrom && (
            <div className="text-[10px] text-[var(--color-muted)]/80">
              görbe: {quote.intradayFrom}
            </div>
          )}
        </>
      )}
      <div className="mt-0.5 flex items-center gap-1.5">
        {manual && (
          <span className="shrink-0 text-[10px] font-medium text-[var(--color-warning,#fbbf24)]">
            kézi
          </span>
        )}
        {sub && (
          <span className="truncate text-xs text-[var(--color-muted)]">
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * "XETRA nyitva · zárásig 2ó 15p" / "zárva" pill for the exchange the held ETFs
 * trade on, from Yahoo's current regular session. Re-renders every 30s so the
 * countdown stays current.
 */
function MarketStatus({
  session,
  exchange,
}: {
  session: { start: number; end: number };
  exchange?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const open = now >= session.start && now < session.end;
  const fmtLeft = (ms: number) => {
    const m = Math.max(0, Math.round(ms / 60_000));
    return m >= 60 ? `${Math.floor(m / 60)}ó ${m % 60}p` : `${m}p`;
  };
  const opensToday = now < session.start;
  const hhmm = new Intl.DateTimeFormat("hu-HU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(session.start);
  const name = exchange ?? "Tőzsde";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        open
          ? "border-[var(--color-positive)]/40 bg-[var(--color-positive)]/10 text-[var(--color-positive)]"
          : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)]"
      }`}
      title={`${name} kereskedési idő (helyi idő szerint)`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          open
            ? "live-dot relative bg-[var(--color-positive)]"
            : "bg-[var(--color-muted)]"
        }`}
      />
      {open
        ? `${name} nyitva · zárásig ${fmtLeft(session.end - now)}`
        : opensToday
          ? `${name} zárva · nyit ${hhmm}`
          : `${name} zárva`}
    </span>
  );
}
