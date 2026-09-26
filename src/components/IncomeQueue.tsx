import { useEffect, useRef } from "react";
import { BellPlus, CheckCheck } from "lucide-react";
import { usePortfolio } from "../lib/store";
import type { PlannedTrade, Reminder } from "../lib/alerts";
import {
  incomeEventTitle,
  incomeSplitText,
  markIncomeAllocated,
  type IncomeAllocation,
} from "../lib/incomeFlow";
import { formatMoney } from "../lib/format";
import { Amt } from "./ui";

/** Saves the event's split as ONE planned-transaction reminder and marks it distributed. */
function saveAsPlan(
  a: IncomeAllocation,
  addReminder: (r: Omit<Reminder, "id" | "createdAt">) => Promise<void>,
) {
  const steps = (a.plan?.suggestions ?? []).filter((s) => s.status === "ok");
  void addReminder({
    severity: "info",
    title: `Beérkezett pénz elosztása – ${incomeEventTitle(a.event)}`,
    detail: incomeSplitText(a) + ".",
    to: "/goals",
    plan: steps.length
      ? steps.map((s): PlannedTrade => ({
          side: s.side,
          bucketName: s.bucketName,
          instrumentKey: s.instrumentKey,
          instrumentName: s.instrumentName,
          amountHuf: Math.round(s.amountHuf),
          quantity: s.quantity,
          costHuf: s.costHuf ? Math.round(s.costHuf) : undefined,
        }))
      : undefined,
  });
  markIncomeAllocated([a.event.id]);
}

/**
 * "Beérkezett, még el nem osztott": coupons, interest, dividends and
 * redemptions from the ledger, each split goal-first, then along the glide
 * path. An event disappears once saved as a plan or marked distributed.
 */
export default function IncomeQueue({
  allocations,
  since,
  highlightId,
}: {
  allocations: IncomeAllocation[];
  since: string | null;
  /** Event to scroll to and highlight (picked from the manual-amount warning). */
  highlightId?: string | null;
}) {
  const addReminder = usePortfolio((s) => s.addReminder);
  const refs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (highlightId) refs.current.get(highlightId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlightId]);

  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-3">
      <h4 className="text-xs font-semibold">Beérkezett, még el nem osztott</h4>
      <p className="mb-2 text-xs text-[var(--color-muted)]">
        Kupon, kamat, osztalék, lejárat a ledgerből{since ? ` (${since}-tól)` : ""}. Előbb a
        rá igényt tartó célok kapnak (a hiányukig), a maradék a célpályán megy tovább;
        több esemény időrendben épül egymásra.
      </p>
      {allocations.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">Nincs elosztásra váró bejövő pénz.</p>
      ) : (
        <ul className="space-y-2">
          {allocations.map((a) => (
            <li
              key={a.event.id}
              ref={(el) => {
                if (el) refs.current.set(a.event.id, el);
                else refs.current.delete(a.event.id);
              }}
              className={`rounded-xl border px-3 py-2 text-sm ${
                a.event.id === highlightId
                  ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10"
                  : "border-[var(--color-border)]"
              }`}
            >
              <div className="font-medium">{incomeEventTitle(a.event)}</div>
              <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                {a.payoutOf?.length ? (
                  incomeSplitText(a)
                ) : (
                  <>
                    {a.goals.map((g) => (
                      <span key={g.goalId}>
                        {g.name}: <Amt>{formatMoney(g.huf)}</Amt> →{" "}
                      </span>
                    ))}
                    célpálya: <Amt>{formatMoney(a.glideHuf)}</Amt>
                    {a.plan?.flow && a.glideHuf >= 1 && ` (célpont: ${a.plan.flow.label})`}
                    {(a.plan?.suggestions ?? [])
                      .filter((s) => s.status === "ok")
                      .map((s, i) => (
                        <span key={i}>
                          {" "}→ {s.instrumentName ?? s.bucketName}: <Amt>{formatMoney(s.amountHuf)}</Amt>
                        </span>
                      ))}
                  </>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {!a.payoutOf?.length && (
                  <button
                    className="btn-ghost px-2 py-1 text-xs"
                    onClick={() => saveAsPlan(a, addReminder)}
                    title="Tervezett tranzakcióként a teendők közé, és nem jelenik meg újra"
                  >
                    <BellPlus className="h-3.5 w-3.5" /> Rögzítés tervként
                  </button>
                )}
                <button
                  className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => markIncomeAllocated([a.event.id])}
                  title="Már elosztottad — nem jelenik meg újra (egyik eszközön sem)"
                >
                  <CheckCheck className="h-3.5 w-3.5" /> Elosztottnak jelölöm
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Shown while a MANUAL amount is typed and a goal earmarks the coupons: a
 * coupon typed here would be spent twice — offer the arrived coupons instead,
 * where the goal gets its share first.
 */
export function CouponWarning({
  goals,
  allocations,
  onPick,
}: {
  goals: string[];
  allocations: IncomeAllocation[];
  onPick: (eventId: string) => void;
}) {
  if (goals.length === 0) return null;
  const coupons = allocations.filter((a) => a.event.kind === "coupon" && a.goals.length > 0);
  return (
    <div className="mb-2 text-xs text-[var(--color-warning)]">
      <p>
        Figyelem: {goals.map((n) => `„${n}”`).join(", ")} a kötvénykuponokat is
        magának foglalja — ha itt kupont osztasz el, az kétszer számolódik. Kupont
        inkább a lenti „Beérkezett” listából válassz: ott a cél előbb megkapja a
        részét.
      </p>
      {coupons.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {coupons.map((a) => (
            <button
              key={a.event.id}
              className="rounded-full border border-[var(--color-warning)] px-2 py-0.5"
              onClick={() => onPick(a.event.id)}
            >
              {a.event.instrumentName ?? "kupon"}, {a.event.day}:{" "}
              <Amt>{formatMoney(a.event.amountHuf)}</Amt>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
