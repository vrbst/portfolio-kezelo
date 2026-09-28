import { useEffect, useMemo, useState } from "react";
import { Target, Plus, Trash2, X, Pencil, Check, BellPlus, Coins } from "lucide-react";
import { usePortfolio, usePortfolioSummary, useToday } from "../lib/store";
import { consolidatedHoldings } from "../lib/portfolio";
import {
  computeSavingsProgress,
  savingsMonthStates,
  DEFAULT_MIN_DAYS_TO_MATURITY,
  suitableForGoalBuy,
  loadSavingsGoals,
  saveSavingsGoals,
  reserveConflicts,
  futureCouponOptions,
  type CouponOption,
  type ReserveConflict,
  type SavingsGoal,
} from "../lib/savings";
import GoalReserves from "./GoalReserves";
import CouponPickerDialog from "./CouponPickerDialog";
import { parseCouponId } from "../lib/incomeClaims";
import { PREFS_EVENT } from "../lib/prefs";
import { Card, AmountInput } from "./ui";
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

  // --- add-goal form (hidden behind "+ Új cél" — rarely used) ---
  const [adding, setAdding] = useState(false);
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
    setAdding(false);
  }

  function update(id: string, patch: Partial<SavingsGoal>) {
    persist(goals.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }
  function remove(id: string) {
    persist(goals.filter((g) => g.id !== id));
  }

  return (
    <Card className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <Target className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Középtávú célok</h2>
      </div>
      <p className="mb-4 max-w-3xl text-sm text-[var(--color-muted)]">
        Célösszeg egy dátumra, mögé rendelt eszközökkel (pl. DKJ). Az app
        mutatja az előrehaladást és a havi szükséges félretételt.
      </p>

      {progress.length > 0 && (
        <div className="mb-4 grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] gap-4">
          {progress.map((p) => (
            <GoalRow
              key={p.goal.id}
              progress={p}
              planHuf={planHuf.get(p.goal.id) ?? 0}
              conflicts={conflicts.filter((c) => c.goalId === p.goal.id)}
              holdings={holdings}
              nameOf={nameOf}
              goals={goals}
              coupons={coupons}
              onUpdate={update}
              onRemove={remove}
            />
          ))}
        </div>
      )}

      {/* Új cél */}
      {!adding ? (
        <button className="btn-ghost text-sm" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Új cél
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Cél neve (pl. Autó)"
            className="min-w-[8rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <AmountInput
            placeholder="Összeg (Ft)"
            className="w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
            value={amount}
            onValueChange={setAmount}
          />
          <input
            type="date"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button
            className="btn-ghost"
            onClick={addGoal}
            title="Cél hozzáadása"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            className="btn-ghost"
            onClick={() => setAdding(false)}
            title="Mégse"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

    </Card>
  );
}

function GoalRow({
  progress: p,
  planHuf,
  conflicts,
  holdings,
  nameOf,
  goals,
  coupons,
  onUpdate,
  onRemove,
}: {
  progress: ReturnType<typeof computeSavingsProgress>[number];
  /** Buys that may have been paid from this goal's reserves. */
  conflicts: ReserveConflict[];
  /** This month's remaining quota (savingsMonthStates — the Havi terv's figure). */
  planHuf: number;
  holdings: { key: string; name: string; value: number }[];
  nameOf: (key: string) => string;
  /** All goals (the coupon picker leaves out the ones others took). */
  goals: SavingsGoal[];
  /** Future bond coupons to pick from. */
  coupons: CouponOption[];
  onUpdate: (id: string, patch: Partial<SavingsGoal>) => void;
  onRemove: (id: string) => void;
}) {
  const g = p.goal;
  const instruments = usePortfolio((s) => s.instruments);
  const today = useToday();
  const assignable = holdings.filter((h) => !g.instrumentKeys.includes(h.key));
  const barPct = Math.min(p.projectedPct * 100, 100);
  const todayPct = Math.min(p.progressPct * 100, 100);

  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const couponIds = g.couponIds ?? [];
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
          <AmountInput
            className="w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right text-sm tabular-nums"
            value={amount}
            onValueChange={setAmount}
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
            <div className="priv font-medium">{g.name}</div>
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
          title="Hozzárendelt eszközök beszámított értéke"
        />
      </div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span
          className="tabular-nums text-[var(--color-muted)]"
          title="Ami most a célra számít: a hozzárendelt eszközök (állampapír/DKJ névértéken, ha a céldátumig lejár; egyébként a céldátumra várható értéken), a lejárt papír kifizetése, a tartási időszak kamata és a félretett készpénz."
        >
          Most:{" "}
          <span className="amt">{formatMoney(p.assignedValueHuf)}</span> (
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
        ) : p.daysLeft > 0 && p.savingStartsOn ? (
          <span>
            A havi félretétel {formatDate(p.savingStartsOn)}-tól indul: akkortól
            havi{" "}
            <span className="amt font-semibold text-[var(--color-brand)]">
              {formatMoney(p.plannedMonthlyHuf)}
            </span>{" "}
            (összesen <span className="amt">{formatMoney(p.gapHuf)}</span>{" "}
            hiányzik). Addig nincs havi teendő.
          </span>
        ) : p.daysLeft > 0 ? (
          <span>
            Havi{" "}
            <span className="amt font-semibold text-[var(--color-brand)]">
              {formatMoney(p.monthlyNeededHuf)}
            </span>{" "}
            félretétel kell a cél eléréséhez
            {p.goal.instrumentKeys.length > 0 || (p.goal.reserves?.length ?? 0) > 0 ? (
              // The quota is per month; what this month's net purchases
              // already covered is shown apart from the total gap, so
              // "gap ÷ months" reading doesn't clash with the quota.
              planHuf > 1 ? (
                <>
                  . A {p.monthAdjective} keretből még{" "}
                  <span className="amt font-semibold">
                    {formatMoney(planHuf)}
                  </span>{" "}
                  van hátra (összesen{" "}
                  <span className="amt">{formatMoney(p.gapHuf)}</span>{" "}
                  hiányzik).
                </>
              ) : (
                <>
                  . A {p.monthAdjective} keret teljesítve ✓ (összesen{" "}
                  <span className="amt">{formatMoney(p.gapHuf)}</span>{" "}
                  hiányzik).
                </>
              )
            ) : (
              <>
                {" "}
                (<span className="amt">{formatMoney(p.gapHuf)}</span>{" "}
                hiányzik).
              </>
            )}
          </span>
        ) : (
          <span className="text-[var(--color-warning,#fbbf24)]">
            A céldátum elmúlt, még{" "}
            <span className="amt">{formatMoney(p.gapHuf)}</span> hiányzik.
          </span>
        )}
      </div>
      {!p.reached &&
        p.daysLeft > 0 &&
        p.goal.instrumentKeys.length > 0 &&
        !p.goal.instrumentKeys.some((k) =>
          suitableForGoalBuy(
            instruments.find((i) => i.key === k),
            p.goal,
            today,
          ),
        ) && (
          <p className="mt-1 text-xs text-[var(--color-warning,#fbbf24)]">
            A hozzárendelt eszközök a vétel után{" "}
            {p.goal.minDaysToMaturity ?? DEFAULT_MIN_DAYS_TO_MATURITY} napon
            belül vagy a céldátum után járnak le — tartsd készpénzben a
            céldátumig.
          </p>
        )}

      {p.daysLeft > 0 && (
        <GoalReserves
          progress={p}
          conflicts={conflicts}
          onChange={(patch) => onUpdate(g.id, patch)}
        />
      )}

      {/* Saving start */}
      {p.daysLeft > 0 && (
        <label className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
          Félretétel kezdete:
          <input
            type="date"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
            value={g.saveFrom ?? ""}
            max={g.targetDate.slice(0, 10)}
            onChange={(e) =>
              onUpdate(g.id, { saveFrom: e.target.value || undefined })
            }
            title="Ettől a hónaptól kell havonta félretenni (készpénzt vagy a célhoz rendelt eszközt); üresen hagyva már most"
          />
          {g.saveFrom ? (
            <button
              className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
              onClick={() => onUpdate(g.id, { saveFrom: undefined })}
              title="Kezdés most"
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <span>(üres = már most)</span>
          )}
        </label>
      )}

      {/* Picked coupons */}
      <div className="mt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {couponIds
            .map((id) => {
              const o = coupons.find((c) => c.id === id);
              const c = parseCouponId(id);
              return {
                id,
                day: o?.day ?? c?.day ?? "",
                name: o?.name ?? (c ? nameOf(c.instrumentKey) : id),
                amountHuf: o?.amountHuf,
              };
            })
            .sort((a, b) => a.day.localeCompare(b.day))
            .map((c) => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs"
                title={c.amountHuf == null ? "Jóváírva (vagy már nem várható) — a cél pénzébe számít" : "Várható kupon"}
              >
                <Coins className="h-3 w-3 text-[var(--color-brand)]" />
                <span className="tabular-nums">{c.day ? formatDate(c.day) : ""}</span>
                <span className="priv">{c.name}</span>
                {c.amountHuf != null ? (
                  <span className="amt">{formatMoney(c.amountHuf)}</span>
                ) : (
                  <span className="text-[var(--color-positive)]">✓</span>
                )}
                <button
                  className="text-[var(--color-muted)] hover:text-[var(--color-negative)]"
                  onClick={() =>
                    onUpdate(g.id, { couponIds: couponIds.filter((x) => x !== c.id) })
                  }
                  title="Eltávolítás"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          {p.daysLeft > 0 && (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPicking(true)}>
              <Coins className="h-3.5 w-3.5" />
              {couponIds.length ? "Kuponok módosítása…" : "Kupon hozzárendelése…"}
            </button>
          )}
        </div>
        {p.pickedCouponsHuf > 0 && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            A kijelölt kuponokból még{" "}
            <span className="amt">{formatMoney(p.pickedCouponsHuf)}</span> érkezik a
            céldátumig.
          </p>
        )}
      </div>
      {picking && (
        <CouponPickerDialog
          goal={g}
          goals={goals}
          coupons={coupons}
          onSave={(ids) => onUpdate(g.id, { couponIds: ids.length ? ids : undefined })}
          onClose={() => setPicking(false)}
        />
      )}

      {/* Coupon toggle */}
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={g.includeCoupons}
          onChange={(e) => onUpdate(g.id, { includeCoupons: e.target.checked })}
        />
        A céldátumig beérkező (más célhoz nem rendelt) összes állampapír-kamat
        is növelje
        {g.includeCoupons && p.couponsHuf - p.pickedCouponsHuf > 0 && (
          <span className="amt">(+{formatMoney(p.couponsHuf - p.pickedCouponsHuf)})</span>
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
              <span className="priv">{nameOf(key)}</span>
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
            className="priv mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
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

      {g.instrumentKeys.length > 0 ? (
        <button
          className="btn-ghost mt-2 text-xs"
          onClick={() =>
            onUpdate(g.id, { monthlyReminder: !g.monthlyReminder })
          }
          title={
            g.monthlyReminder
              ? "Havi vásárlás-emlékeztető kikapcsolása"
              : "Havi emlékeztető: figyelmeztet, amíg a hónapban meg nem vetted"
          }
        >
          <BellPlus className="h-4 w-4" />
          {g.monthlyReminder
            ? "Havi emlékeztető bekapcsolva"
            : "Felvétel havi figyelmeztetésnek"}
        </button>
      ) : (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Rendelj hozzá eszközt, hogy havi vásárlás-emlékeztetőt kérhess.
        </p>
      )}
      {g.monthlyReminder && g.instrumentKeys.length > 0 && (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Minden hónapban figyelmeztet, amíg meg nem veszed a szükséges havi
          összegben a hozzárendelt eszközt (a hónap utolsó munkanapja már a
          következő hónaphoz számít).
          {g.includeCoupons
            ? " A hónapban beérkezett kötvénykamatot is hozzáadja a szükséges összeghez — azaz azt is fektesd be az eszközbe."
            : ""}
        </p>
      )}
      {g.monthlyReminder && g.instrumentKeys.length > 0 && (
        <label className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
          Ne javasoljon a vétel után
          <AmountInput
            className="w-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-xs tabular-nums"
            value={g.minDaysToMaturity ?? DEFAULT_MIN_DAYS_TO_MATURITY}
            onValueChange={(v) =>
              onUpdate(g.id, {
                minDaysToMaturity: v === "" ? undefined : Number(v),
              })
            }
          />
          napon belül vagy a céldátum után lejáró eszközt — ha nincs más,
          tartsd készpénzben a céldátumig.
        </label>
      )}
    </div>
  );
}
