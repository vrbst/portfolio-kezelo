import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import type { CouponOption, SavingsGoal } from "../lib/savings";
import { formatDate, formatMoney } from "../lib/format";

/**
 * Pick the future coupons that go to a goal: every coupon due by the goal's
 * date that no other goal took, ticked if it is already this goal's. Esc or a
 * click outside closes without saving.
 */
export default function CouponPickerDialog({
  goal,
  goals,
  coupons,
  onSave,
  onClose,
}: {
  goal: SavingsGoal;
  /** All goals — coupons another goal picked are left out. */
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

  const taken = useMemo(
    () => new Set(goals.filter((g) => g.id !== goal.id).flatMap((g) => g.couponIds ?? [])),
    [goals, goal.id],
  );
  const target = goal.targetDate.slice(0, 10);
  const options = coupons.filter((c) => c.day <= target && !taken.has(c.id));
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
        </p>
        {options.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted)]">
            Nincs szabad kupon a céldátumig.
          </p>
        ) : (
          <ul className="-mx-1 flex-1 overflow-y-auto">
            {options.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 text-sm hover:bg-[var(--color-surface-2)]">
                  <input
                    type="checkbox"
                    checked={picked.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <span className="w-24 shrink-0 tabular-nums text-[var(--color-muted)]">
                    {formatDate(c.day)}
                  </span>
                  <span className="priv min-w-0 flex-1 truncate">{c.name}</span>
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
