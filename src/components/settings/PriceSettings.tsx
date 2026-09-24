import { useState } from "react";
import { LineChart, RefreshCw, Check, Pencil, X } from "lucide-react";
import { usePortfolio } from "../../lib/store";
import { Card, Badge } from "../ui";
import { formatDateTime, formatNumber } from "../../lib/format";
import { instrumentTypeLabel } from "../../lib/labels";
import { loadSymbolOverrides, saveSymbolOverride } from "../../lib/prices";
import type { Instrument } from "../../lib/model";

const PRICED_TYPES = new Set(["etf", "stock", "fund"]);

export default function PriceSettings() {
  const instruments = usePortfolio((s) => s.instruments);
  const priceFile = usePortfolio((s) => s.priceFile);
  const prices = usePortfolio((s) => s.prices);
  const livePrices = usePortfolio((s) => s.livePrices);
  const manualPrices = usePortfolio((s) => s.manualPrices);
  const setManualPrice = usePortfolio((s) => s.setManualPrice);
  const refreshPrices = usePortfolio((s) => s.refreshPrices);
  const pricesLoading = usePortfolio((s) => s.pricesLoading);
  const priceUpdatedAt = usePortfolio((s) => s.priceUpdatedAt);
  const eurHuf = usePortfolio((s) => s.fx["EUR"]);

  const priced = instruments.filter((i) => PRICED_TYPES.has(i.type));

  return (
    <Card className="mt-4 p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LineChart className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Árfolyamok</h2>
        </div>
        <button
          className="btn-ghost"
          onClick={() => refreshPrices()}
          disabled={pricesLoading}
        >
          <RefreshCw
            className={`h-4 w-4 ${pricesLoading ? "animate-spin" : ""}`}
          />
          Frissítés
        </button>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Automatikus forrás: Yahoo Finance (a szimbólumot az ISIN-ből keresi meg)
        + frankfurter.app (EUR/HUF
        {eurHuf ? ` = ${formatNumber(eurHuf, 2)}` : ""}). Ha egy papírnál rossz
        listát talál, a szimbólumot kézzel felülírhatod alább. Az árat is
        megadhatod kézzel (ceruza) — ez ideiglenes, a következő sikeres
        árfrissítéskor automatikusan visszaáll az élő értékre.
        {priceUpdatedAt && ` Frissítve: ${formatDateTime(priceUpdatedAt)}.`}
      </p>

      {priced.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Még nincs árazható értékpapír (ETF/részvény) importálva.
        </p>
      ) : (
        <div className="space-y-2">
          {priced.map((inst) => (
            <PriceRow
              key={inst.key}
              inst={inst}
              price={prices.get(inst.key)}
              currency={priceFile?.prices[inst.key]?.currency ?? inst.currency}
              isLive={inst.key in livePrices}
              isManual={inst.key in manualPrices}
              autoSymbol={priceFile?.prices[inst.key]?.symbol}
              onChanged={() => refreshPrices()}
              onManualPrice={(p) => setManualPrice(inst.key, p)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function PriceRow({
  inst,
  price,
  currency,
  isLive,
  isManual,
  autoSymbol,
  onChanged,
  onManualPrice,
}: {
  inst: Instrument;
  price?: number;
  currency: string;
  isLive: boolean;
  isManual: boolean;
  autoSymbol?: string;
  onChanged: () => void;
  onManualPrice: (price: number | null) => void;
}) {
  const isinKey = inst.isin ?? inst.key;
  const [sym, setSym] = useState(() => loadSymbolOverrides()[isinKey] ?? "");
  const updateInstrument = usePortfolio((s) => s.updateInstrument);

  // Manual price editor: opens with the current price prefilled.
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceDraft, setPriceDraft] = useState("");

  const openPriceEdit = () => {
    setPriceDraft(price != null ? String(+price.toFixed(4)) : "");
    setEditingPrice(true);
  };
  const savePriceEdit = () => {
    const v = Number(priceDraft.replace(/\s/g, "").replace(",", "."));
    onManualPrice(Number.isFinite(v) && v > 0 ? v : null);
    setEditingPrice(false);
  };

  const save = () => {
    saveSymbolOverride(isinKey, sym);
    onChanged();
  };

  const saveTer = (raw: string) => {
    const v = Number(raw.replace(",", "."));
    void updateInstrument(inst.key, {
      terPct:
        raw.trim() !== "" && Number.isFinite(v) && v >= 0 ? v / 100 : undefined,
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          {inst.ticker || inst.name}
          <Badge tone="neutral">{instrumentTypeLabel[inst.type]}</Badge>
          {isLive && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-[var(--color-positive)]"
              title="Élő árfolyam"
            />
          )}
        </div>
        <label className="mt-1.5 flex items-center gap-2 text-xs text-[var(--color-muted)]">
          szimbólum:
          <input
            value={sym}
            onChange={(e) => setSym(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder={autoSymbol ?? "auto (ISIN alapján)"}
            title="Yahoo szimbólum kézi felülírása. Üresen hagyva automatikus."
            className="w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs"
          />
          <span className="ml-2">TER:</span>
          <input
            key={`ter:${inst.terPct ?? ""}`}
            type="number"
            step="0.01"
            min={0}
            defaultValue={
              inst.terPct != null ? +(inst.terPct * 100).toFixed(3) : ""
            }
            onBlur={(e) => saveTer(e.target.value)}
            placeholder="pl. 0.22"
            title="Az alap éves költséghányada (TER) százalékban — a Hozam oldal költségbecsléséhez."
            className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-xs tabular-nums"
          />
          <span>%</span>
        </label>
      </div>
      <div className="text-right">
        {editingPrice ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              type="text"
              inputMode="decimal"
              value={priceDraft}
              onChange={(e) => setPriceDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") savePriceEdit();
                if (e.key === "Escape") setEditingPrice(false);
              }}
              placeholder={price != null ? formatNumber(price, 2) : "ár"}
              className="w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-sm tabular-nums"
            />
            <span className="text-xs text-[var(--color-muted)]">
              {currency}
            </span>
            <button
              onClick={savePriceEdit}
              title="Kézi ár mentése"
              className="rounded-lg p-1 text-[var(--color-positive)] hover:bg-[var(--color-surface-2)]"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              onClick={() => setEditingPrice(false)}
              title="Mégse"
              className="rounded-lg p-1 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <div className="text-right">
              {price != null ? (
                <div className="amt font-semibold tabular-nums">
                  {formatNumber(price, 2)}{" "}
                  <span className="text-xs font-normal text-[var(--color-muted)]">
                    {currency}
                  </span>
                </div>
              ) : (
                <span className="text-xs text-[var(--color-muted)]">
                  Nincs ár még
                </span>
              )}
              {isManual && (
                <button
                  onClick={() => onManualPrice(null)}
                  title="Vissza az automatikus árra"
                  className="text-[10px] text-[var(--color-warning,#fbbf24)] hover:underline"
                >
                  kézi ár · visszaállítás
                </button>
              )}
            </div>
            <button
              onClick={openPriceEdit}
              title="Kézi árfolyam megadása (ideiglenes)"
              className="rounded-lg p-1 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
