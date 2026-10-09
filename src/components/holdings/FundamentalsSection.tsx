import type { ReactNode } from "react";
import { sectorKey, sectorLabel, type FetchError, type Fundamentals, type Weight } from "../../lib/fundamentals";
import { formatCompact, formatDate, formatNumber } from "../../lib/format";

const pct = (v: number, d = 1) => `${formatNumber(v * 100, d)}%`;
const ratio = (v: number) => formatNumber(v, 1);

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">{children}</div>
    </div>
  );
}

export function WeightBars({ items, label = (n: string) => n, limit = 6 }: { items: Weight[]; label?: (name: string) => string; limit?: number }) {
  const top = items.slice(0, limit);
  const max = Math.max(...top.map((w) => w.weight), 0.0001);
  return (
    <ul className="space-y-1.5 text-xs">
      {top.map((w) => (
        <li key={w.name} className="grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-x-3">
          <div className="min-w-0">
            <div className="truncate">{label(w.name)}</div>
            <div className="mt-0.5 h-1.5 rounded-full bg-[var(--color-surface-2)]">
              <div className="h-1.5 rounded-full bg-[var(--color-brand)]" style={{ width: `${(w.weight / max) * 100}%` }} />
            </div>
          </div>
          <span className="text-right tabular-nums">{pct(w.weight)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function FundamentalsSection({ f, error }: { f?: Fundamentals; error?: FetchError }) {
  if (!f) return null;
  const fund = f.quoteType === "ETF" || f.quoteType === "MUTUALFUND";
  const ccy = f.currency ?? "";
  const items: [string, ReactNode][] = [];
  if (f.sector) items.push(["Szektor", sectorLabel(sectorKey(f.sector))]);
  if (f.industry) items.push(["Iparág", f.industry]);
  if (f.country) items.push(["Ország", f.country]);
  if (f.pe != null) items.push([fund ? "P/E (súlyozott)" : "P/E", ratio(f.pe)]);
  if (f.forwardPe != null) items.push(["Várható P/E", ratio(f.forwardPe)]);
  if (f.pb != null) items.push([fund ? "P/B (súlyozott)" : "P/B", ratio(f.pb)]);
  if (f.dividendYield != null && f.dividendYield > 0) items.push(["Osztalékhozam", pct(f.dividendYield, 2)]);
  if (f.marketCap != null) items.push(["Piaci kapitalizáció", `${formatCompact(f.marketCap)} ${ccy}`]);
  if (f.totalAssets != null) items.push(["Alapméret", `${formatCompact(f.totalAssets)} ${ccy}`]);
  if (f.beta != null) items.push(["Béta", formatNumber(f.beta, 2)]);
  if (f.nextEarnings) items.push(["Következő gyorsjelentés", formatDate(f.nextEarnings)]);
  if (f.family) items.push(["Alapkezelő", f.family]);
  if (!items.length && !f.sectors?.length && !f.topHoldings?.length) return null;

  return (
    <section className="border-t border-[var(--color-border)] px-5 py-4" data-privacy="public">
      <h3 className="mb-3 text-sm font-semibold">Papír-adatok</h3>
      {items.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {items.map(([label, value]) => (
            <Item key={label} label={label}>
              {value}
            </Item>
          ))}
        </div>
      )}
      {f.sectors && f.sectors.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-[var(--color-muted)]">Szektorok</div>
          <WeightBars items={[...f.sectors].sort((a, b) => b.weight - a.weight)} label={(n) => sectorLabel(sectorKey(n))} />
        </div>
      )}
      {f.topHoldings && f.topHoldings.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-[var(--color-muted)]">Legnagyobb tételek</div>
          <WeightBars items={f.topHoldings} limit={10} />
        </div>
      )}
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        Forrás: Yahoo Finance ({f.symbol}), {formatDate(f.fetchedAt)}
        {error && (
          <span className="text-[var(--color-warning)]">
            {" "}
            — a frissítés {formatDate(error.since)} óta nem sikerül, ez a legutóbbi sikeres adat
          </span>
        )}
      </p>
    </section>
  );
}
