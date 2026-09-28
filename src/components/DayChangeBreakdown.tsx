import type { DayChange } from "../lib/store";
import { formatMoney, formatPercent } from "../lib/format";

function signCls(v: number): string {
  return v >= 0
    ? "text-[var(--color-positive)]"
    : "text-[var(--color-negative)]";
}

function Row({
  label,
  abs,
  pct,
  sub = false,
}: {
  label: string;
  abs: number;
  pct?: number;
  sub?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${
        sub ? "pl-3 text-xs text-[var(--color-muted)]" : ""
      }`}
    >
      <span className="min-w-0 truncate">
        {label}
        {pct != null && (
          <span
            className={`ml-1.5 tabular-nums ${sub ? "" : "text-xs"} ${signCls(pct)}`}
          >
            {formatPercent(pct)}
          </span>
        )}
      </span>
      <span
        className={`amt shrink-0 tabular-nums ${sub ? "" : "font-medium"} ${signCls(abs)}`}
      >
        {formatMoney(abs, "HUF", { sign: true })}
      </span>
    </div>
  );
}

/** Popup body of the hero card's daily move: what it is made of. */
export default function DayChangeBreakdown({ change }: { change: DayChange }) {
  const items = change.breakdown ?? [];
  return (
    <div>
      <div className="mb-1.5 text-xs text-[var(--color-muted)]">
        Miből adódik a {change.note === "ma" ? "mai" : `${change.note}os`}{" "}
        változás?
      </div>
      <div className="space-y-1">
        {items.map((it) => (
          <div key={it.kind + it.label} className="space-y-0.5">
            <Row label={it.label} abs={it.abs} pct={it.pct} />
            {it.children?.map((c) => (
              <Row key={c.label} label={c.label} abs={c.abs} pct={c.pct} sub />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 border-t border-[var(--color-border)] pt-1.5">
        <Row label="Összesen" abs={change.abs} pct={change.pct} />
      </div>
    </div>
  );
}
