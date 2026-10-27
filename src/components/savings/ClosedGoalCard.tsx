import { useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "../ui";
import { formatDate, formatMoney } from "../../lib/format";
import type { SavingsGoal } from "../../lib/savings";

/**
 * A goal closed by hand: kept at the end of the list, dimmed, with no figures
 * (it takes part in no calculation). It can be reopened or deleted.
 */
export default function ClosedGoalCard({
  goal: g,
  onReopen,
  onRemove,
}: {
  goal: SavingsGoal;
  onReopen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3 opacity-50 transition hover:opacity-80">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="priv font-medium">{g.name}</span>
            <Badge>Lezárva</Badge>
          </div>
          <div className="text-xs text-[var(--color-muted)]">
            Cél: <span className="amt">{formatMoney(g.targetHuf)}</span> · {formatDate(g.targetDate)}
            {g.closedAt ? ` · lezárva: ${formatDate(g.closedAt)}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
            onClick={() => onReopen(g.id)}
            title="Cél újranyitása"
            aria-label="Cél újranyitása"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          {confirming ? (
            <span className="flex items-center gap-1 text-xs">
              <button className="text-[var(--color-negative)] underline" onClick={() => onRemove(g.id)}>
                Törlés
              </button>
              <button className="text-[var(--color-muted)] underline" onClick={() => setConfirming(false)}>
                Mégse
              </button>
            </span>
          ) : (
            <button
              className="text-[var(--color-muted)] hover:text-[var(--color-negative)]"
              onClick={() => setConfirming(true)}
              title="Cél törlése"
              aria-label="Cél törlése"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
