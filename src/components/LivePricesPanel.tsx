import { useEffect, useMemo, useState } from "react";
import { LineChart, RefreshCw } from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import { Card } from "./ui";
import { formatMoney, formatDateTime, formatPercent } from "../lib/format";
import type { Instrument } from "../lib/model";
import type { LiveQuote } from "../lib/prices";
import InstrumentLogo from "./InstrumentLogo";
import PriceChartDialog from "./PriceChartDialog";

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
  // The tile whose enlarged two-day chart is open (by tile key).
  const [openKey, setOpenKey] = useState<string | null>(null);

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

  const eurQuote = liveQuotes["EUR"];
  const opened =
    openKey === "EUR"
      ? eurQuote && {
          title: "EUR/HUF",
          value: formatMoney(eurHuf, "HUF", { decimals: 2 }),
          sub: "Euró árfolyam",
          quote: eurQuote,
        }
      : (() => {
          const t = tiles.find((x) => x.key === openKey);
          return (
            t?.quote && {
              title:
                t.sub && t.sub !== t.label ? `${t.label} · ${t.sub}` : t.label,
              value: formatMoney(t.price, t.currency, { decimals: 2 }),
              sub:
                t.hufEquiv != null
                  ? `≈ ${formatMoney(t.hufEquiv, "HUF")}`
                  : undefined,
              quote: t.quote,
            }
          );
        })();

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
            quote={eurQuote}
            mark={<CurrencyMark symbol="€" />}
            onOpen={() => setOpenKey("EUR")}
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
            onOpen={() => setOpenKey(t.key)}
          />
        ))}
      </div>
      {opened && opened.quote.intraday && (
        <PriceChartDialog {...opened} onClose={() => setOpenKey(null)} />
      )}
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
  mark,
  onOpen,
}: {
  label: string;
  value: string;
  sub?: string;
  live?: boolean;
  manual?: boolean;
  quote?: LiveQuote;
  instrument?: Instrument;
  /** Icon in place of the instrument logo (e.g. the EUR/HUF tile's €). */
  mark?: React.ReactNode;
  /** Opens the enlarged chart; only offered when there is a curve to show. */
  onOpen?: () => void;
}) {
  const change =
    quote?.prevClose != null ? quote.price / quote.prevClose - 1 : undefined;
  const up = (change ?? 0) >= 0;
  // Green = a live quote from a market that is trading right now. A live quote
  // from a closed market is just its last close: grey, not green. Without a
  // known session (e.g. the frankfurter fallback) it stays green as before.
  const now = useNow();
  const trading =
    !quote?.session ||
    (now >= quote.session.start && now < quote.session.end);
  const clickable = !!onOpen && !!quote?.intraday;
  return (
    <div
      className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4 ${
        clickable
          ? "cursor-pointer transition hover:border-[var(--color-brand)]/50 hover:bg-[var(--color-surface-2)]/70 focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]"
          : ""
      }`}
      {...(clickable && {
        role: "button",
        tabIndex: 0,
        "aria-label": `${label} – nagyobb grafikon`,
        onClick: onOpen,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen!();
          }
        },
      })}
    >
      <div className="flex items-center gap-1.5">
        {mark ??
          (instrument && <InstrumentLogo instrument={instrument} size={18} />)}
        <span className="truncate text-xs font-medium text-[var(--color-muted)]">
          {label}
        </span>
        {manual ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warning,#fbbf24)]"
            title="Kézi árfolyam — a következő frissítéskor visszaáll az élő értékre"
          />
        ) : (
          live &&
          (trading ? (
            <span
              className="live-dot relative h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-positive)]"
              title="Élő árfolyam — a piac most nyitva"
            />
          ) : (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-muted)]"
              title={`Záróár — ${quote?.exchange ?? "a piac"} most zárva`}
            />
          ))
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
            className="mt-2 h-8 w-full"
            title={
              (quote.intradayFrom
                ? `Alakulás a(z) ${quote.intradayFrom} alapján (ennek a jegyzésnek nincs napközbeni adata)`
                : "Árfolyam-alakulás") +
              " — bal: előző nap, jobb: ma; szaggatott: előző napi zárás"
            }
          >
            <TwoDaySparkline
              today={quote.intraday}
              prevDay={quote.prevDay}
              // A borrowed curve (intradayFrom) is in the proxy's own price
              // scale: its previous close is its last bar of the prior day.
              prevClose={
                quote.intradayFrom ? quote.prevDay?.at(-1) : quote.prevClose
              }
              session={quote.session}
              stroke={up ? "var(--color-positive)" : "var(--color-negative)"}
            />
          </div>
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

const BAR_MS = 5 * 60_000;

/**
 * Currency mark for FX tiles, in the same tinted rounded-tile style as
 * InstrumentLogo (EU blue for the euro).
 */
function CurrencyMark({
  symbol,
  color = "#60a5fa",
  size = 18,
}: {
  symbol: string;
  color?: string;
  size?: number;
}) {
  return (
    <span
      className="font-display grid shrink-0 place-items-center rounded-lg font-bold"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        color,
        background: `color-mix(in oklab, ${color} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 28%, transparent)`,
      }}
      aria-hidden="true"
    >
      {symbol}
    </span>
  );
}

/**
 * Two-session mini chart: the previous session faded on the left half, today
 * on the right half — laid out by time, so a half-finished trading day fills
 * only part of its half — and the previous close as a dashed baseline. Makes
 * "up on the day but sliding since the open" readable at a glance.
 */
function TwoDaySparkline({
  today,
  prevDay,
  prevClose,
  session,
  stroke,
}: {
  today: number[];
  prevDay?: number[];
  prevClose?: number;
  session?: { start: number; end: number };
  stroke: string;
}) {
  const w = 100;
  const h = 28;
  const prev = prevDay ?? [];
  const all = [...prev, ...today, ...(prevClose != null ? [prevClose] : [])];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min || 1;
  const py = (v: number) => h - 1.5 - ((v - min) / range) * (h - 3);
  // Bars a full "today" would have: the session length, else as many as the
  // previous day had (24 h markets: FX, crypto), else a whole day of 5-min bars.
  const fullDay = session
    ? Math.max(2, Math.round((session.end - session.start) / BAR_MS))
    : Math.max(prev.length, 288);
  const split = prev.length ? w / 2 : 0;
  const pxPrev = (i: number) => (i / (prev.length - 1)) * split;
  const pxToday = (i: number) =>
    split + Math.min(1, i / (fullDay - 1)) * (w - split);
  const path = (vals: number[], px: (i: number) => number) =>
    vals
      .map(
        (v, i) =>
          `${i === 0 ? "M" : "L"}${px(i).toFixed(2)},${py(v).toFixed(2)}`,
      )
      .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-full w-full"
      aria-hidden="true"
    >
      {prevClose != null && (
        <line
          x1={0}
          x2={w}
          y1={py(prevClose)}
          y2={py(prevClose)}
          stroke="var(--color-muted)"
          strokeOpacity={0.7}
          strokeWidth={1}
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {prev.length >= 2 && (
        <>
          <line
            x1={split}
            x2={split}
            y1={0}
            y2={h}
            stroke="var(--color-border)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path(prev, pxPrev)}
            fill="none"
            stroke="var(--color-muted)"
            strokeOpacity={0.6}
            strokeWidth={1.25}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
      <path
        d={path(today, pxToday)}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
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
  const now = useNow();
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

/** Current time, re-rendering every 30 s (market open/closed, countdowns). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
