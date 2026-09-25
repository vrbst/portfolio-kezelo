import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { formatCompact, formatMoney } from "../../lib/format";
import {
  CAT_COLOR,
  MONTHS,
  WEEKDAYS,
  dayAggregate,
  dayColor,
  isoDay,
  itemSign,
  shortName,
  type DayItem,
} from "./shared";

/**
 * One month, big: every day cell lists its items (name + amount), so a busy
 * month reads without hovering. Clicking a day selects it (the day panel shows
 * the detail) and closes the dialog. Arrows / ←→ step months; Esc closes.
 */
export default function MonthZoomDialog({
  year,
  month,
  byDay,
  todayIso,
  privacy,
  onMonth,
  onSelect,
  onClose,
}: {
  year: number;
  month: number;
  byDay: Map<string, DayItem[]>;
  todayIso: string;
  privacy: boolean;
  /** Step to another month (may cross the year). */
  onMonth: (year: number, month: number) => void;
  onSelect: (iso: string) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const step = (d: number) => {
    const t = new Date(year, month + d, 1);
    onMonth(t.getFullYear(), t.getMonth());
  };
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);

  let inflow = 0;
  let outflow = 0;
  for (let d = 1; d <= days; d++) {
    const items = byDay.get(isoDay(year, month, d));
    if (!items) continue;
    const a = dayAggregate(items);
    inflow += a.inflow;
    outflow += a.outflow;
  }
  const money = (n: number) => (privacy ? "•••" : formatMoney(n));

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${year}. ${MONTHS[month]}`}
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost px-2 py-1.5"
              onClick={() => step(-1)}
              aria-label="Előző hónap"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <h2 className="min-w-40 text-center text-lg font-semibold capitalize">
              {year}. {MONTHS[month]}
            </h2>
            <button
              className="btn-ghost px-2 py-1.5"
              onClick={() => step(1)}
              aria-label="Következő hónap"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-4 text-xs text-[var(--color-muted)]">
            <span>
              be{" "}
              <span className="amt font-semibold text-[var(--color-positive)]">
                {money(inflow)}
              </span>
            </span>
            <span>
              ki{" "}
              <span className="amt font-semibold text-[var(--color-negative)]">
                {money(outflow)}
              </span>
            </span>
            <button
              ref={closeRef}
              className="btn-ghost"
              onClick={onClose}
              aria-label="Bezárás"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-xs text-[var(--color-muted)]">
          {WEEKDAYS.map((w, i) => (
            <div key={i} className="py-1">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (d == null) return <div key={i} />;
            const key = isoDay(year, month, d);
            const items = byDay.get(key) ?? [];
            const color = items.length ? dayColor(dayAggregate(items)) : null;
            const isToday = key === todayIso;
            const future = key > todayIso;
            const shown = [...items]
              .sort(
                (a, b) =>
                  (b.amountHuf ?? b.noteHuf ?? 0) -
                  (a.amountHuf ?? a.noteHuf ?? 0),
              )
              .slice(0, 3);
            return (
              <button
                key={i}
                onClick={() => {
                  onSelect(key);
                  onClose();
                }}
                className="flex min-h-20 flex-col items-stretch gap-0.5 rounded-lg border border-[var(--color-border)]/60 p-1 text-left transition hover:border-[var(--color-brand)]/60 sm:min-h-24 sm:p-1.5"
                style={
                  color
                    ? {
                        background: `${color}${future ? "12" : "1f"}`,
                        borderColor: `${color}55`,
                      }
                    : undefined
                }
              >
                <span
                  className={`text-xs tabular-nums ${
                    isToday
                      ? "grid h-5 w-5 place-items-center rounded-full bg-[var(--color-brand)] font-semibold text-white"
                      : items.length
                        ? "font-semibold"
                        : "text-[var(--color-muted)]"
                  }`}
                >
                  {d}
                </span>
                {shown.map((it, k) => {
                  const amt = it.amountHuf ?? it.noteHuf;
                  return (
                    <span
                      key={k}
                      className="flex min-w-0 items-center gap-1 text-[10px] leading-tight"
                      title={it.title}
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: CAT_COLOR[it.cat] }}
                      />
                      <span className="priv hidden min-w-0 flex-1 truncate text-[var(--color-muted)] sm:inline">
                        {shortName(it.title)}
                      </span>
                      {amt != null && (
                        <span
                          className={`amt shrink-0 tabular-nums ${
                            it.amountHuf == null
                              ? "text-[var(--color-muted)]"
                              : it.cat === "out"
                                ? "text-[var(--color-negative)]"
                                : "text-[var(--color-positive)]"
                          }`}
                        >
                          {privacy
                            ? "•••"
                            : `${it.amountHuf != null ? itemSign(it) : ""}${formatCompact(amt)}`}
                        </span>
                      )}
                    </span>
                  );
                })}
                {items.length > 3 && (
                  <span className="text-[10px] text-[var(--color-muted)]">
                    +{items.length - 3} további
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
