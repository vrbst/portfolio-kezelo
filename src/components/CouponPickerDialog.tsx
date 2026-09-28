import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import type { CouponOption, SavingsGoal } from "../lib/savings";
import { couponClaimedBy } from "../lib/incomeClaims";
import { formatDate, formatMoney } from "../lib/format";

/**
 * Pick the future coupons that go to a goal: every coupon due by the goal's
 * date, ticked if it is already this goal's. One that another goal picked, or
 * that a goal earmarking every coupon (includeCoupons) owns by its date, is
 * listed greyed out with that goal's name. Esc or a click outside closes
 * without saving.
 */
export default function CouponPickerDialog({
  goal,
  goals,
  coupons,
  onSave,
  onClose,
}: {
  goal: SavingsGoal;
  /** All goals — coupons another goal owns can't be picked. */
  goals: SavingsGoal[];
  coupons: CouponOption[];
  onSave: (couponIds: string[]) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState(() => new Set(goal.couponIds ?? []));
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Coupon id → why it is not free: the other goal that picked it.
  const pickedBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of goals)
      if (g.id !== goal.id) for (const id of g.couponIds ?? []) m.set(id, g.name);
    return m;
  }, [goals, goal.id]);
  const target = goal.targetDate.slice(0, 10);
  const rows = coupons
    .filter((c) => c.day <= target)
    .map((c) => {
      const claim = couponClaimedBy(goals, goal.id, c.day);
      const owner = claim
        ? `${claim.name} (minden kupon a céldátumáig)`
        : pickedBy.get(c.id);
      return { ...c, owner };
    });
  const options = rows.filter((c) => !c.owner);
  const optionIds = new Set(options.map((c) => c.id));
  const total = options
    .filter((c) => picked.has(c.id))
    .reduce((s, c) => s + c.amountHuf, 0);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const save = () => {
    // Picks not in the list (already credited, or past a moved date) are kept
    // as they were — only the listed ones can be changed here.
    const kept = (goal.couponIds ?? []).filter((id) => !optionIds.has(id));
    onSave([...kept, ...options.filter((c) => picked.has(c.id)).map((c) => c.id)]);
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Kuponok – ${goal.name}`}
        className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold">
            Kuponok a célra – <span className="priv">{goal.name}</span>
          </h2>
          <button ref={closeRef} className="btn-ghost" onClick={onClose} aria-label="Bezárás">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs text-[var(--color-muted)]">
          A céldátumig ({formatDate(target)}) várható kuponok, amelyek még nincsenek
          másik célhoz rendelve. A kijelölt kupon a várható teljesülésbe számít, a
          jóváírás után pedig a cél félretett pénze lesz — nem kell elosztani.
          A más célhoz tartozó kuponok szürkén, a cél nevével látszanak.
        </p>
        {goal.includeCoupons && (
          <p className="mb-3 rounded-lg border border-[var(--color-border)] p-2 text-xs text-[var(--color-muted)]">
            Ennél a célnál be van kapcsolva, hogy a céldátumig érkező összes
            (más célhoz nem rendelt) kupon beleszámít — külön kijelölni csak
            akkor kell, ha ezt kikapcsolod.
          </p>
        )}
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted)]">
            Nincs várható kupon a céldátumig.
          </p>
        ) : (
          <ul className="-mx-1 flex-1 overflow-y-auto">
            {rows.map((c) => (
              <li key={c.id}>
                <label
                  className={
                    c.owner
                      ? "flex cursor-not-allowed items-center gap-3 rounded-lg px-1 py-1.5 text-sm opacity-50"
                      : "flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 text-sm hover:bg-[var(--color-surface-2)]"
                  }
                  title={c.owner ? `Már a(z) ${c.owner} célhoz tartozik` : undefined}
                >
                  <input
                    type="checkbox"
                    checked={!c.owner && picked.has(c.id)}
                    disabled={!!c.owner}
                    onChange={() => toggle(c.id)}
                  />
                  <span className="w-24 shrink-0 tabular-nums text-[var(--color-muted)]">
                    {formatDate(c.day)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="priv block truncate">{c.name}</span>
                    {c.owner && (
                      <span className="priv block truncate text-xs">→ {c.owner}</span>
                    )}
                  </span>
                  <span className="amt tabular-nums">{formatMoney(c.amountHuf)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
          <span className="text-sm text-[var(--color-muted)]">
            Kijelölve: <span className="amt font-semibold text-[var(--color-text)]">{formatMoney(total)}</span>
          </span>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Mégse
            </button>
            <button className="btn-primary" onClick={save}>
              <Check className="h-4 w-4" /> Mentés
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
