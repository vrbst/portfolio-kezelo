import { useMemo } from "react";
import { LineChart, RefreshCw } from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import { Card } from "./ui";
import { formatMoney, formatDateTime } from "../lib/format";
import type { Instrument } from "../lib/model";

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
  hufEquiv?: number;
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
  const eurHuf = usePortfolio((s) => s.fx["EUR"]);
  const fx = usePortfolio((s) => s.fx);
  const priceUpdatedAt = usePortfolio((s) => s.priceUpdatedAt);
  const refreshPrices = usePortfolio((s) => s.refreshPrices);
  const pricesLoading = usePortfolio((s) => s.pricesLoading);

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
        return [
          {
            key: inst.key,
            label: inst.ticker ?? inst.name,
            sub: inst.ticker ? inst.name : undefined,
            price,
            currency: inst.currency,
            live: inst.key in livePrices,
            hufEquiv:
              inst.currency !== "HUF" && rate ? price * rate : undefined,
          },
        ];
      });
  }, [summary, prices, livePrices, fx]);

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

      <div className="grid grid-cols-2 gap-2">
        {eurHuf && (
          <PriceTile
            label="EUR/HUF"
            value={formatMoney(eurHuf, "HUF", { decimals: 2 })}
            sub="Euró árfolyam"
            live
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
}: {
  label: string;
  value: string;
  sub?: string;
  live?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4">
      <div className="flex items-center gap-1.5">
        <span className="truncate text-xs font-medium text-[var(--color-muted)]">
          {label}
        </span>
        {live && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-positive)]"
            title="Élő árfolyam"
          />
        )}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {sub && (
        <div className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
          {sub}
        </div>
      )}
    </div>
  );
}
