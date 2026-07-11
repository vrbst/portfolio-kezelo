import { useEffect, useMemo, useState } from "react";
import { Target, Plus, Trash2, X, Pencil, Check, BellPlus } from "lucide-react";
import { usePortfolio, usePortfolioSummary } from "../lib/store";
import { consolidatedHoldings } from "../lib/portfolio";
import {
  computeSavingsProgress,
  loadSavingsGoals,
  saveSavingsGoals,
  type SavingsGoal,
} from "../lib/savings";
import { PREFS_EVENT } from "../lib/prefs";
import { Card } from "./ui";
import { formatMoney, formatDate } from "../lib/format";

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `sg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/**
 * Medium-term savings goals: a dated target amount backed by assigned
 * instruments (typically DKJ), with progress, the monthly saving still needed,
 * and an optional "let incoming bond coupons count too" switch.
 */
export default function SavingsTargets() {
  const summary = usePortfolioSummary();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
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
    holdings.find((h) => h.key === key)?.name ?? key;

  // --- add-goal form ---
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");

  function addGoal() {
    const targetHuf = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!name.trim() || !date || !Number.isFinite(targetHuf) || targetHuf <= 0)
      return;
    persist([
      ...goals,
      {
        id: newId(),
        name: name.trim(),
        targetHuf,
        targetDate: date,
        instrumentKeys: [],
        includeCoupons: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    setName("");
    setAmount("");
    setDate("");
  }

  function update(id: string, patch: Partial<SavingsGoal>) {
    persist(goals.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }
  function remove(id: string) {
    persist(goals.filter((g) => g.id !== id));
  }

  // One-click reminder from a goal — appears among the alerts (and syncs).
  const addReminder = usePortfolio((s) => s.addReminder);
  const reminders = usePortfolio((s) => s.reminders);
  const reminderTitle = (name: string) => `Középtávú cél: ${name}`;
  function reminderDetail(
    pr: ReturnType<typeof computeSavingsProgress>[number],
  ) {
    const base = `${formatMoney(pr.goal.targetHuf)} · ${formatDate(pr.goal.targetDate)}`;
    if (pr.reached)
      return `${base} · a jelenlegi eszközökből teljesül a céldátumra.`;
    return `${base} · most ${Math.round(pr.progressPct * 100)}% · havi ${formatMoney(pr.monthlyNeededHuf)} félretétel kell.`;
  }

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2">
        <Target className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Középtávú célok</h2>
      </div>
      <p className="mb-3 text-sm text-[var(--color-muted)]">
        Célösszeg egy dátumra, mögé rendelt eszközökkel (pl. DKJ). Az app
        mutatja az előrehaladást és a havi szükséges félretételt.
      </p>

      {/* Új cél */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Cél neve (pl. Autó)"
          className="min-w-[8rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          inputMode="numeric"
          placeholder="Összeg (Ft)"
          className="w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input
          type="date"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button className="btn-ghost" onClick={addGoal} title="Cél hozzáadása">
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {progress.length > 0 && (
        <div className="mt-4 space-y-4">
          {progress.map((p) => {
            const rTitle = reminderTitle(p.goal.name);
            return (
              <GoalRow
                key={p.goal.id}
                progress={p}
                holdings={holdings}
                nameOf={nameOf}
                onUpdate={update}
                onRemove={remove}
                reminderAdded={reminders.some((r) => r.title === rTitle)}
                onAddReminder={() =>
                  void addReminder({
                    severity: "info",
                    title: rTitle,
                    detail: reminderDetail(p),
                    to: "/forecast",
                  })
                }
              />
            );
          })}
        </div>
      )}
    </Card>
  );
}

function GoalRow({
  progress: p,
  holdings,
  nameOf,
  onUpdate,
  onRemove,
  reminderAdded,
  onAddReminder,
}: {
  progress: ReturnType<typeof computeSavingsProgress>[number];
  holdings: { key: string; name: string; value: number }[];
  nameOf: (key: string) => string;
  onUpdate: (id: string, patch: Partial<SavingsGoal>) => void;
  onRemove: (id: string) => void;
  reminderAdded: boolean;
  onAddReminder: () => void;
}) {
  const g = p.goal;
  const assignable = holdings.filter((h) => !g.instrumentKeys.includes(h.key));
  const barPct = Math.min(p.projectedPct * 100, 100);
  const todayPct = Math.min(p.progressPct * 100, 100);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(g.name);
  const [amount, setAmount] = useState(String(Math.round(g.targetHuf)));
  const [date, setDate] = useState(g.targetDate);

  function startEdit() {
    setName(g.name);
    setAmount(String(Math.round(g.targetHuf)));
    setDate(g.targetDate);
    setEditing(true);
  }
  function saveEdit() {
    const targetHuf = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!name.trim() || !date || !Number.isFinite(targetHuf) || targetHuf <= 0)
      return;
    onUpdate(g.id, { name: name.trim(), targetHuf, targetDate: date });
    setEditing(false);
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3">
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            className="min-w-[8rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="text"
            inputMode="numeric"
            className="w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            type="date"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button className="btn-primary" onClick={saveEdit}>
            <Check className="h-4 w-4" /> Mentés
          </button>
          <button className="btn-ghost" onClick={() => setEditing(false)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium">{g.name}</div>
            <div className="text-xs text-[var(--color-muted)]">
              Cél: <span className="amt">{formatMoney(g.targetHuf)}</span> ·{" "}
              {formatDate(g.targetDate)}
              {p.daysLeft > 0 ? ` · ${p.monthsLeft} hónap` : " · lejárt"}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
              onClick={startEdit}
              title="Cél szerkesztése"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              className="text-[var(--color-muted)] hover:text-[var(--color-negative)]"
              onClick={() => onRemove(g.id)}
              title="Cél törlése"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Progress bar: today (solid) + projected-to-date (lighter) */}
      <div className="relative mt-2 h-2.5 rounded-full bg-[var(--color-surface-2)]">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-brand)]/40"
          style={{ width: `${barPct}%` }}
          title="Céldátumra várható"
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-brand)]"
          style={{ width: `${todayPct}%` }}
          title="Jelenlegi érték"
        />
      </div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="tabular-nums text-[var(--color-muted)]">
          Most: <span className="amt">{formatMoney(p.assignedValueHuf)}</span> (
          {Math.round(p.progressPct * 100)}%)
        </span>
        <span className="tabular-nums text-[var(--color-muted)]">
          Céldátumra: <span className="amt">{formatMoney(p.projectedHuf)}</span>{" "}
          ({Math.round(p.projectedPct * 100)}%)
        </span>
      </div>

      {/* Verdict */}
      <div className="mt-2 text-sm">
        {p.reached ? (
          <span className="text-[var(--color-positive)]">
            ✓ A cél a jelenlegi eszközökből (és a beszámított kamatokból)
            teljesül a céldátumra.
          </span>
        ) : p.daysLeft > 0 ? (
          <span>
            Havi{" "}
            <span className="amt font-semibold text-[var(--color-brand)]">
              {formatMoney(p.monthlyNeededHuf)}
            </span>{" "}
            félretétel kell a cél eléréséhez (
            <span className="amt">{formatMoney(p.gapHuf)}</span> hiányzik).
          </span>
        ) : (
          <span className="text-[var(--color-warning,#fbbf24)]">
            A céldátum elmúlt, még{" "}
            <span className="amt">{formatMoney(p.gapHuf)}</span> hiányzik.
          </span>
        )}
      </div>

      {/* Coupon toggle */}
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={g.includeCoupons}
          onChange={(e) => onUpdate(g.id, { includeCoupons: e.target.checked })}
        />
        A céldátumig beérkező állampapír-kamatok is növeljék
        {g.includeCoupons && p.couponsHuf > 0 && (
          <span className="amt">(+{formatMoney(p.couponsHuf)})</span>
        )}
      </label>

      {/* Assigned instruments */}
      <div className="mt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {g.instrumentKeys.map((key) => (
            <span
              key={key}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs"
            >
              {nameOf(key)}
              <button
                className="text-[var(--color-muted)] hover:text-[var(--color-negative)]"
                onClick={() =>
                  onUpdate(g.id, {
                    instrumentKeys: g.instrumentKeys.filter((k) => k !== key),
                  })
                }
                title="Eltávolítás"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {g.instrumentKeys.length === 0 && (
            <span className="text-xs text-[var(--color-muted)]">
              Rendelj hozzá eszközöket (pl. a célra vett DKJ-t):
            </span>
          )}
        </div>
        {assignable.length > 0 && (
          <select
            className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              onUpdate(g.id, {
                instrumentKeys: [...g.instrumentKeys, e.target.value],
              });
            }}
          >
            <option value="">+ Eszköz hozzárendelése…</option>
            {assignable.map((h) => (
              <option key={h.key} value={h.key}>
                {h.name} ({formatMoney(h.value)})
              </option>
            ))}
          </select>
        )}
      </div>

      <button
        className="btn-ghost mt-2 text-xs"
        onClick={onAddReminder}
        disabled={reminderAdded}
        title={
          reminderAdded
            ? "Már felvetted figyelmeztetésnek"
            : "A cél felvétele a figyelmeztetések közé"
        }
      >
        <BellPlus className="h-4 w-4" />
        {reminderAdded
          ? "Felvéve a figyelmeztetések közé"
          : "Felvétel figyelmeztetésnek"}
      </button>
    </div>
  );
}
