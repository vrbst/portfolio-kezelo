import InfoTip from "./InfoTip";
import { useEffect, useMemo, useState } from "react";
import { Target, Plus } from "lucide-react";
import { usePortfolio, usePortfolioSummary, useValuedInstruments } from "../lib/store";
import { consolidatedHoldings } from "../lib/portfolio";
import {
  computeSavingsProgress,
  savingsMonthStates,
  loadSavingsGoals,
  saveSavingsGoals,
  reserveConflicts,
  futureCouponOptions,
  type SavingsGoal,
} from "../lib/savings";
import GoalCard from "./savings/GoalCard";
import GoalEditorDialog, { type EditorSection } from "./savings/GoalEditorDialog";
import GoalScheduleDialog from "./savings/GoalScheduleDialog";
import { PREFS_EVENT } from "../lib/prefs";
import { Card } from "./ui";

/**
 * Medium-term savings goals: a dated target amount backed by assigned
 * instruments (typically DKJ), with progress, the monthly saving still needed,
 * and an optional "let incoming bond coupons count too" switch. Goals are
 * added and edited in one dialog; each card opens its own schedule (chart and
 * the planned amounts with dates).
 */
export default function SavingsTargets() {
  const summary = usePortfolioSummary();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = useValuedInstruments();
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);

  const [goals, setGoals] = useState<SavingsGoal[]>(loadSavingsGoals);

  // A sync pull may bring newer goals from another device — reload them.
  useEffect(() => {
    const onPrefs = (e: Event) => {
      if ((e as CustomEvent<{ source?: string }>).detail?.source === "remote")
        setGoals(loadSavingsGoals());
    };
    window.addEventListener(PREFS_EVENT, onPrefs);
    return () => window.removeEventListener(PREFS_EVENT, onPrefs);
  }, []);

  function persist(next: SavingsGoal[]) {
    setGoals(next);
    saveSavingsGoals(next);
  }

  const progress = useMemo(() => {
    const map = new Map(instruments.map((i) => [i.key, i]));
    return computeSavingsProgress(
      goals,
      accounts,
      transactions,
      map,
      prices,
      fx,
    );
  }, [goals, accounts, transactions, instruments, prices, fx]);
  // This month's remaining quota per goal — the Havi terv's own figure.
  const planHuf = useMemo(() => {
    const map = new Map(instruments.map((i) => [i.key, i]));
    return new Map(
      savingsMonthStates(goals, accounts, transactions, map, prices, fx).map(
        (s) => [s.goalId, s.planHuf],
      ),
    );
  }, [goals, accounts, transactions, instruments, prices, fx]);

  // Buys that may have been paid from a goal's set-aside cash.
  const conflicts = useMemo(
    () => reserveConflicts(goals, transactions, new Map(instruments.map((i) => [i.key, i])), fx),
    [goals, transactions, instruments, fx],
  );

  // Instruments available to assign — everything currently held, name + value.
  const holdings = useMemo(
    () =>
      consolidatedHoldings(summary)
        .filter((h) => h.marketValueHuf > 0)
        .map((h) => ({
          key: h.instrumentKey,
          name: h.instrument?.name ?? h.instrumentKey,
          value: h.marketValueHuf,
        })),
    [summary],
  );
  const nameOf = (key: string) =>
    holdings.find((h) => h.key === key)?.name ??
    instruments.find((i) => i.key === key)?.name ??
    key;
  const coupons = useMemo(
    () => futureCouponOptions(summary, transactions),
    [summary, transactions],
  );

  // Which dialog is open: the editor (a goal id, or "new") or a schedule.
  const [editing, setEditing] = useState<{ id: string | "new"; section?: EditorSection } | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);

  function update(id: string, patch: Partial<SavingsGoal>) {
    persist(goals.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }
  function remove(id: string) {
    persist(goals.filter((g) => g.id !== id));
  }
  function saveGoal(goal: SavingsGoal) {
    persist(
      goals.some((g) => g.id === goal.id)
        ? goals.map((g) => (g.id === goal.id ? goal : g))
        : [...goals, goal],
    );
  }

  const editedGoal = editing && editing.id !== "new" ? goals.find((g) => g.id === editing.id) : undefined;
  const scheduled = scheduleId ? progress.find((p) => p.goal.id === scheduleId) : undefined;

  return (
    <Card className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Target className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Középtávú célok</h2>
        <InfoTip>
          Célösszeg egy dátumra, mögé rendelt eszközökkel (pl. DKJ). Az app
          mutatja az előrehaladást és a havi szükséges félretételt; a kártyán
          az ütemterv-ikonnal a grafikon és a tervezett összegek is megnyithatók.
        </InfoTip>
        <button className="btn-ghost ml-auto text-sm" onClick={() => setEditing({ id: "new" })}>
          <Plus className="h-4 w-4" /> Új cél
        </button>
      </div>

      {progress.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
          Még nincs középtávú cél. Vegyél fel egyet (pl. autó, nyaralás): célösszeg, dátum, és hogy
          melyik eszköz fedezi — az app kiszámolja a havi félretételt.
          <div className="mt-3">
            <button className="btn-primary" onClick={() => setEditing({ id: "new" })}>
              <Plus className="h-4 w-4" /> Első cél felvétele
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] gap-4">
          {progress.map((p) => (
            <GoalCard
              key={p.goal.id}
              progress={p}
              planHuf={planHuf.get(p.goal.id) ?? 0}
              conflicts={conflicts.filter((c) => c.goalId === p.goal.id)}
              nameOf={nameOf}
              onEdit={(section) => setEditing({ id: p.goal.id, section })}
              onSchedule={() => setScheduleId(p.goal.id)}
              onUpdate={update}
              onRemove={remove}
            />
          ))}
        </div>
      )}

      {editing && (editing.id === "new" || editedGoal) && (
        <GoalEditorDialog
          goal={editedGoal}
          goals={goals}
          holdings={holdings}
          coupons={coupons}
          nameOf={nameOf}
          section={editing.section}
          onSave={saveGoal}
          onClose={() => setEditing(null)}
        />
      )}
      {scheduled && (
        <GoalScheduleDialog
          progress={scheduled}
          planHuf={planHuf.get(scheduled.goal.id) ?? 0}
          goals={goals}
          coupons={coupons}
          onClose={() => setScheduleId(null)}
        />
      )}
    </Card>
  );
}
