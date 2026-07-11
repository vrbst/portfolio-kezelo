import { useState } from "react";
import { Target, Trash2, Plus, CheckCircle2 } from "lucide-react";
import { usePortfolio, useGoalProgress } from "../lib/store";
import { Card, Badge } from "./ui";
import { formatMoney } from "../lib/format";
import { instrumentTypeLabel } from "../lib/labels";
import { PERIOD_LABEL, type GoalPeriod } from "../lib/goals";
import type { InstrumentType } from "../lib/model";

const PERIODS: GoalPeriod[] = [1, 3, 6, 12];

/**
 * Fixed recurring (DCA) savings goals: "invest X into instrument/category Y
 * every period". Progress is derived from the buy transactions; an unmet goal
 * becomes an alert. Lives on the Goals page.
 */
export default function GoalsSettings() {
  const instruments = usePortfolio((s) => s.instruments);
  const addGoal = usePortfolio((s) => s.addGoal);
  const removeGoal = usePortfolio((s) => s.removeGoal);
  const progress = useGoalProgress();

  const investable = instruments.filter((i) => i.type !== "cash");
  // Distinct types present → "buy any instrument of this type" category goals
  // (e.g. DKJ, where each issuance is a different series/ISIN).
  const categoryTypes = [...new Set(investable.map((i) => i.type))];
  const [target, setTarget] = useState("");
  const [periodMonths, setPeriodMonths] = useState<GoalPeriod>(1);
  const [amount, setAmount] = useState("");

  // Target is encoded as `type:<t>` (category) or `key:<isin>` (specific), so
  // the two kinds never collide in the single <select>.
  const defaultTarget = categoryTypes[0]
    ? `type:${categoryTypes[0]}`
    : investable[0]
      ? `key:${investable[0].key}`
      : "";
  const sel = target || defaultTarget;
  const amountNum = Number(amount.replace(/\s/g, ""));
  const canAdd = !!sel && Number.isFinite(amountNum) && amountNum > 0;

  function submit() {
    if (!canAdd) return;
    if (sel.startsWith("type:")) {
      addGoal({
        instrumentType: sel.slice(5) as InstrumentType,
        periodMonths,
        amountHuf: amountNum,
      });
    } else {
      addGoal({
        instrumentKey: sel.slice(4),
        periodMonths,
        amountHuf: amountNum,
      });
    }
    setAmount("");
  }

  const fieldClass =
    "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm";

  return (
    <Card className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <Target className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Megtakarítási célok</h2>
      </div>
      <p className="mb-4 text-sm text-[var(--color-muted)]">
        Rendszeres (DCA) cél egy konkrét eszközre vagy egy egész kategóriára
        (pl. „DKJ – összes", így nem kell minden új sorozatot külön kijelölni).
        Az app figyelmeztet, ha az adott időszakban még nincs meg. A hónap
        utolsó munkanapi vétele már a következő időszakba számít.
      </p>

      {progress.length > 0 && (
        <div className="mb-5 space-y-3">
          {progress.map((p) => {
            const pct = p.done ? 100 : Math.min(100, Math.round(p.ratio * 100));
            return (
              <div
                key={p.goal.id}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      {p.done && (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-positive)]" />
                      )}
                      <span className="truncate">{p.instrumentName}</span>
                      <Badge tone="neutral">
                        {PERIOD_LABEL[p.goal.periodMonths]}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {p.periodLabel}
                    </div>
                  </div>
                  <button
                    onClick={() => removeGoal(p.goal.id)}
                    title="Cél törlése"
                    className="shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-negative)]"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                  <div
                    className={`h-full rounded-full ${
                      p.done
                        ? "bg-[var(--color-positive)]"
                        : "bg-[var(--color-brand)]"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between text-xs tabular-nums">
                  <span className="amt">
                    {formatMoney(p.investedHuf)} / {formatMoney(p.targetHuf)}
                  </span>
                  <span className="text-[var(--color-muted)]">
                    {p.done
                      ? "Teljesítve ✓"
                      : `még ${formatMoney(p.remainingHuf)}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {investable.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Előbb importálj adatokat, hogy legyen mihez célt rendelni.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-muted)]">Eszköz</span>
            <select
              value={sel}
              onChange={(e) => setTarget(e.target.value)}
              className={fieldClass}
            >
              {categoryTypes.length > 0 && (
                <optgroup label="Kategória – minden ilyen eszköz">
                  {categoryTypes.map((t) => (
                    <option key={t} value={`type:${t}`}>
                      {instrumentTypeLabel[t]} (összes)
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Konkrét eszköz">
                {investable.map((i) => (
                  <option key={i.key} value={`key:${i.key}`}>
                    {i.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-muted)]">Időszak</span>
            <select
              value={periodMonths}
              onChange={(e) =>
                setPeriodMonths(Number(e.target.value) as GoalPeriod)
              }
              className={fieldClass}
            >
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-muted)]">
              Összeg (Ft)
            </span>
            <input
              type="number"
              min={0}
              step={10000}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="100000"
              className={`${fieldClass} w-36 tabular-nums`}
            />
          </label>
          <button
            onClick={submit}
            disabled={!canAdd}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" /> Hozzáad
          </button>
        </div>
      )}
    </Card>
  );
}
