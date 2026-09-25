import { useState } from "react";
import { Wallet } from "lucide-react";
import { formatMoney, formatCompact } from "../../lib/format";
import { MONTHS } from "./shared";

export type IncomeKind = "kamat" | "lejarat" | "osztalek";

export interface IncomeMonth {
  /** YYYY-MM */
  key: string;
  /** Realised (past) or expected (future). The current month can have both. */
  past: Record<IncomeKind, number>;
  future: Record<IncomeKind, number>;
}

const KIND_META: { key: IncomeKind; label: string; color: string }[] = [
  { key: "kamat", label: "Kamat", color: "#22d3ee" },
  { key: "osztalek", label: "Osztalék", color: "#34d399" },
  { key: "lejarat", label: "Lejárat (visszakapott tőke)", color: "#6366f1" },
];

const sum = (r: Record<IncomeKind, number>) =>
  r.kamat + r.lejarat + r.osztalek;

/** Hatched fill for expected amounts: same hue, striped. */
const hatch = (c: string) =>
  `repeating-linear-gradient(135deg, ${c} 0 3px, color-mix(in srgb, ${c} 35%, transparent) 3px 6px)`;

/**
 * Passive-income timeline: the last 12 months (realised, solid) and the next
 * 12 (expected, hatched) on one axis, stacked by kind — interest, dividends and
 * returned principal. Trades are NOT income, so sells never show up here.
 */
export default function IncomeTimeline({
  months,
  currentKey,
  privacy,
}: {
  months: IncomeMonth[];
  currentKey: string;
  privacy: boolean;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(
    ...months.map((m) => sum(m.past) + sum(m.future)),
    1,
  );
  const curIdx = months.findIndex((m) => m.key === currentKey);
  const pastTotal = months
    .slice(0, Math.max(0, curIdx + 1))
    .reduce((s, m) => s + sum(m.past), 0);
  const futTotals = months.reduce(
    (acc, m) => ({
      kamat: acc.kamat + m.future.kamat,
      lejarat: acc.lejarat + m.future.lejarat,
      osztalek: acc.osztalek + m.future.osztalek,
    }),
    { kamat: 0, lejarat: 0, osztalek: 0 },
  );
  const money = (n: number) => (privacy ? "•••" : formatMoney(n));
  const hasAny = months.some((m) => sum(m.past) + sum(m.future) > 0);
  if (!hasAny) return null;
  const shownKinds = KIND_META.filter((k) =>
    months.some((m) => m.past[k.key] + m.future[k.key] > 0),
  );

  return (
    <div className="mt-5 border-t border-[var(--color-border)] pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Wallet className="h-4 w-4 text-[var(--color-brand)]" />
          Passzív jövedelem – elmúlt és következő 12 hónap
        </h3>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-muted)]">
          <span>
            Elmúlt 12 hónap:{" "}
            <span className="amt font-semibold text-[var(--color-text)]">
              {money(pastTotal)}
            </span>
          </span>
          <span>
            Következő 12 hónap:{" "}
            <span className="amt font-semibold text-[var(--color-positive)]">
              {money(sum(futTotals))}
            </span>
            {sum(futTotals) > 0 && (
              <span className="amt">
                {" "}
                (
                {KIND_META.filter((k) => futTotals[k.key] > 0)
                  .map(
                    (k) =>
                      `${k.label.split(" ")[0].toLowerCase()} ${privacy ? "•••" : formatCompact(futTotals[k.key])}`,
                  )
                  .join(" · ")}
                )
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="relative mt-4 flex h-40 gap-1 sm:gap-1.5">
        {months.map((m, i) => {
          const total = sum(m.past) + sum(m.future);
          const active = hover === m.key;
          const [y, mo] = m.key.split("-").map(Number);
          return (
            <div
              key={m.key}
              className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5"
              onMouseEnter={() => setHover(m.key)}
              onMouseLeave={() => setHover(null)}
            >
              {/* "ma" divider before the current month. */}
              {i === curIdx && (
                <div className="pointer-events-none absolute -left-[3px] top-0 bottom-5 border-l border-dashed border-[var(--color-muted)]/60">
                  <span className="absolute -top-4 -left-2 text-[10px] text-[var(--color-muted)]">
                    ma
                  </span>
                </div>
              )}
              <div className="relative flex w-full flex-1 flex-col justify-end">
                {active && total > 0 && (
                  <div className="pointer-events-none absolute -top-1 left-1/2 z-10 w-48 -translate-x-1/2 -translate-y-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-[11px] shadow-xl">
                    <div className="mb-1 font-semibold">
                      {y}. {MONTHS[mo - 1]}
                    </div>
                    {KIND_META.map((k) => {
                      const p = m.past[k.key];
                      const f = m.future[k.key];
                      if (p + f <= 0) return null;
                      return (
                        <div key={k.key} className="flex justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ background: k.color }}
                            />
                            {k.label.split(" ")[0]}
                          </span>
                          <span className="amt text-right tabular-nums">
                            {money(p + f)}
                            {f > 0 && (
                              <span className="block text-[10px] text-[var(--color-muted)]">
                                {p > 0
                                  ? `ebből várható ${privacy ? "•••" : formatCompact(f)}`
                                  : "várható"}
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Expected segments on top (hatched), realised below (solid). */}
                {KIND_META.map((k) =>
                  m.future[k.key] > 0 ? (
                    <div
                      key={`f-${k.key}`}
                      className="w-full first:rounded-t"
                      style={{
                        height: `${(m.future[k.key] / max) * 100}%`,
                        background: hatch(k.color),
                        opacity: active ? 0.95 : 0.7,
                      }}
                    />
                  ) : null,
                )}
                {KIND_META.map((k) =>
                  m.past[k.key] > 0 ? (
                    <div
                      key={`p-${k.key}`}
                      className="w-full first:rounded-t"
                      style={{
                        height: `${(m.past[k.key] / max) * 100}%`,
                        background: k.color,
                        opacity: active ? 1 : 0.85,
                      }}
                    />
                  ) : null,
                )}
              </div>
              <span
                className={`text-[10px] tabular-nums ${
                  i === curIdx
                    ? "font-semibold text-[var(--color-brand)]"
                    : "text-[var(--color-muted)]"
                }`}
              >
                {MONTHS[mo - 1].slice(0, 3)}
                {mo === 1 && (
                  <span className="hidden sm:inline"> ’{String(y).slice(2)}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-[var(--color-muted)]">
        {shownKinds.map((k) => (
          <span key={k.key} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: k.color }}
            />
            {k.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: hatch("#8b93a7") }}
          />
          várható
        </span>
        <span>Az eladások és vételek nem jövedelem, itt nem szerepelnek.</span>
      </div>
    </div>
  );
}
