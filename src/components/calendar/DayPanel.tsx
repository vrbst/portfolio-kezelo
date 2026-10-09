import { Badge, BottomSheet } from "../ui";
import { formatMoney } from "../../lib/format";
import {
  CAT_COLOR,
  MONTHS,
  WEEKDAY_NAMES,
  itemSign,
  type DayItem,
} from "./shared";

function dayTitle(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()];
  return `${y}. ${MONTHS[m - 1]} ${d}., ${wd}`;
}

function relative(iso: string, todayIso: string): string {
  const days = Math.round((Date.parse(iso) - Date.parse(todayIso)) / 86_400_000);
  if (days === 0) return "ma";
  if (days === 1) return "holnap";
  if (days === -1) return "tegnap";
  return days > 0 ? `${days} nap múlva` : `${-days} napja`;
}

/** The selected day's items: title, tags, signed amount (or marker note). */
function DayBody({
  date,
  items,
  todayIso,
  privacy,
}: {
  date: string;
  items: DayItem[];
  todayIso: string;
  privacy: boolean;
}) {
  const sorted = [...items].sort(
    (a, b) =>
      (b.amountHuf ?? b.noteHuf ?? 0) - (a.amountHuf ?? a.noteHuf ?? 0),
  );
  return (
    <>
      <div className="text-sm font-semibold">{dayTitle(date)}</div>
      <div className="mt-0.5 text-xs text-[var(--color-muted)]">
        {relative(date, todayIso)}
      </div>
      {sorted.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-muted)]">
          Nincs tétel ezen a napon.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {sorted.map((it, i) => {
            const amt = it.amountHuf ?? it.noteHuf;
            return (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: CAT_COLOR[it.cat] }}
                />
                <div className="min-w-0 flex-1">
                  <div className="priv text-sm font-medium leading-snug break-words">
                    {it.title}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">{it.tag}</Badge>
                    {it.future && it.amountHuf != null && (
                      <Badge tone="warning">várható</Badge>
                    )}
                  </div>
                </div>
                {amt != null && (
                  <div
                    className={`amt shrink-0 text-sm font-semibold tabular-nums ${
                      it.amountHuf == null
                        ? "text-[var(--color-muted)]"
                        : it.cat === "out"
                          ? "text-[var(--color-negative)]"
                          : "text-[var(--color-positive)]"
                    }`}
                  >
                    {privacy
                      ? "•••"
                      : `${it.amountHuf != null ? itemSign(it) : ""}${formatMoney(amt)}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Desktop: a sticky card beside the calendar. */
export function DayPanel(props: {
  date: string;
  items: DayItem[];
  todayIso: string;
  privacy: boolean;
}) {
  return (
    <div className="sticky top-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/30 p-4">
      <DayBody {...props} />
    </div>
  );
}

/** Mobile: a bottom sheet over the page, dismissed by the backdrop, X or Esc. */
export function DaySheet({
  onClose,
  ...props
}: {
  date: string;
  items: DayItem[];
  todayIso: string;
  privacy: boolean;
  onClose: () => void;
}) {
  return (
    <BottomSheet label="A nap tételei" onClose={onClose}>
      <DayBody {...props} />
    </BottomSheet>
  );
}
