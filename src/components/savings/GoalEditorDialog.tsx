import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Check, Coins, X } from "lucide-react";
import InfoTip from "../InfoTip";
import CouponPickerDialog from "../CouponPickerDialog";
import { AmountInput } from "../ui";
import { usePortfolio, useToday, useValuedInstruments } from "../../lib/store";
import { toLocalDay } from "../../lib/portfolio";
import {
  DEFAULT_MIN_DAYS_TO_MATURITY,
  computeSavingsProgress,
  maturityDay,
  maturityFitsGoal,
  reminderSettings,
  type CouponOption,
  type SavingsGoal,
} from "../../lib/savings";
import { formatDate, formatMoney } from "../../lib/format";

export type EditorSection = "basic" | "cover" | "reminder";
type CouponMode = "none" | "picked" | "all";

const INPUT =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm";

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `sg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/** Today + n months as a local day (a month-end rolls to the last day). */
function inMonths(today: string, n: number): string {
  const d = new Date(+today.slice(0, 4), +today.slice(5, 7) - 1 + n, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(+today.slice(8, 10), last));
  return toLocalDay(d);
}

/**
 * One dialog for adding and editing a medium-term goal, in the order the goal
 * is thought through: basics and start, what covers it (instruments, coupons),
 * the reminder. A live preview at the bottom shows what the draft would mean
 * (monthly amount, start, surplus). Esc, the backdrop or "Mégse" close it
 * without saving.
 */
export default function GoalEditorDialog({
  goal,
  goals,
  holdings,
  coupons,
  nameOf,
  section,
  onSave,
  onClose,
}: {
  /** The goal to edit; undefined = a new one. */
  goal?: SavingsGoal;
  /** All goals (the preview replaces / adds this one; the coupon picker leaves out taken coupons). */
  goals: SavingsGoal[];
  holdings: { key: string; name: string; value: number }[];
  coupons: CouponOption[];
  nameOf: (key: string) => string;
  /** Scroll to this section on open. */
  section?: EditorSection;
  onSave: (goal: SavingsGoal) => void;
  onClose: () => void;
}) {
  const today = useToday();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const instruments = useValuedInstruments();
  const imap = useMemo(() => new Map(instruments.map((i) => [i.key, i])), [instruments]);

  const [name, setName] = useState(goal?.name ?? "");
  const [amount, setAmount] = useState(goal ? String(Math.round(goal.targetHuf)) : "");
  const [date, setDate] = useState(goal?.targetDate.slice(0, 10) ?? "");
  const [later, setLater] = useState(!!goal?.saveFrom);
  const [saveFrom, setSaveFrom] = useState(goal?.saveFrom?.slice(0, 10) ?? "");
  const [keys, setKeys] = useState<string[]>(goal?.instrumentKeys ?? []);
  const [unbuyable, setUnbuyable] = useState<string[]>(goal?.unbuyableKeys ?? []);
  const [mode, setMode] = useState<CouponMode>(
    goal?.includeCoupons ? "all" : goal?.couponIds?.length ? "picked" : "none",
  );
  const [couponIds, setCouponIds] = useState<string[]>(goal?.couponIds ?? []);
  const [reminder, setReminder] = useState(!!goal?.monthlyReminder);
  const [minDays, setMinDays] = useState(
    String(goal?.minDaysToMaturity ?? DEFAULT_MIN_DAYS_TO_MATURITY),
  );
  const [picking, setPicking] = useState(false);
  const [tried, setTried] = useState(false);

  const closeRef = useRef<HTMLButtonElement>(null);
  const basicRef = useRef<HTMLElement>(null);
  const coverRef = useRef<HTMLElement>(null);
  const reminderRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const target = section === "cover" ? coverRef : section === "reminder" ? reminderRef : undefined;
    if (target) target.current?.scrollIntoView({ block: "start" });
    else closeRef.current?.focus();
    return () => prevFocus?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !picking) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, picking]);

  const targetHuf = Number(amount.replace(/\s/g, "").replace(",", "."));
  const draft: SavingsGoal = {
    id: goal?.id ?? "draft",
    name: name.trim(),
    targetHuf,
    targetDate: date,
    instrumentKeys: keys,
    includeCoupons: mode === "all",
    ...reminderSettings(goal, keys.length > 0, reminder, minDays),
    unbuyableKeys: unbuyable.filter((k) => keys.includes(k)).length
      ? unbuyable.filter((k) => keys.includes(k))
      : undefined,
    createdAt: goal?.createdAt ?? new Date().toISOString(),
    reserves: goal?.reserves,
    couponIds: mode === "none" || couponIds.length === 0 ? undefined : couponIds,
    saveFrom: later && saveFrom ? saveFrom : undefined,
  };

  const validate = (): string => {
    if (!draft.name) return "Adj nevet a célnak.";
    if (!Number.isFinite(targetHuf) || targetHuf <= 0) return "A célösszeg legyen pozitív.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Add meg a céldátumot.";
    if (!goal && date <= today) return "A céldátum legyen a jövőben.";
    if (later && !saveFrom) return "Add meg a félretétel kezdetét, vagy válaszd a „Mostantól” lehetőséget.";
    if (later && saveFrom > date) return "A félretétel kezdete nem lehet a céldátum után.";
    return "";
  };

  // What the draft means, computed like the card does it.
  const preview = useMemo(() => {
    if (validate()) return undefined;
    const others = goals.filter((g) => g.id !== draft.id);
    const all = [...others, draft];
    const p = computeSavingsProgress(all, accounts, transactions, imap, prices, fx).find(
      (x) => x.goal.id === draft.id,
    );
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, amount, date, later, saveFrom, keys, unbuyable, mode, couponIds, reminder, minDays, today, goals, accounts, transactions, imap, prices, fx]);

  // After a failed save the message follows the fields: it goes away once fixed.
  const shownError = tried ? validate() : "";

  function save() {
    setTried(true);
    if (validate()) return;
    onSave(goal ? draft : { ...draft, id: newId() });
    onClose();
  }

  const toggleKey = (key: string) => {
    setKeys((ks) => (ks.includes(key) ? ks.filter((k) => k !== key) : [...ks, key]));
  };
  const toggleUnbuyable = (key: string) =>
    setUnbuyable((us) => (us.includes(key) ? us.filter((k) => k !== key) : [...us, key]));

  // Held instruments, plus any already assigned one that is no longer held.
  const options = [
    ...holdings,
    ...keys.filter((k) => !holdings.some((h) => h.key === k)).map((k) => ({ key: k, name: nameOf(k), value: 0 })),
  ];

  // The coupon picker is its own portal, kept OUT of the backdrop below: its
  // clicks would bubble (React tree) to the backdrop and close this dialog.
  return (
    <>
      {createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={goal ? `Cél szerkesztése – ${goal.name}` : "Új cél"}
        className="flex max-h-[92vh] w-full max-w-xl flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold">{goal ? "Cél szerkesztése" : "Új középtávú cél"}</h2>
          <button ref={closeRef} className="btn-ghost" onClick={onClose} aria-label="Bezárás">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="-mx-1 flex-1 space-y-5 overflow-y-auto px-1">
          <section ref={basicRef} className="space-y-2">
            <h3 className="text-sm font-semibold">1. Mire és mikorra?</h3>
            <label className="block text-xs text-[var(--color-muted)]">
              Cél neve
              <input
                type="text"
                placeholder="pl. Autó"
                className={`${INPUT} priv mt-1 w-full`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="text-xs text-[var(--color-muted)]">
                Célösszeg (Ft)
                <AmountInput
                  className={`${INPUT} mt-1 block w-36 text-right tabular-nums`}
                  value={amount}
                  onValueChange={setAmount}
                />
              </label>
              <label className="text-xs text-[var(--color-muted)]">
                Céldátum
                <input
                  type="date"
                  className={`${INPUT} mt-1 block`}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
              Gyorsan:
              {[6, 12, 24].map((n) => (
                <button key={n} className="btn-ghost px-2 py-1 text-xs" onClick={() => setDate(inMonths(today, n))}>
                  +{n} hónap
                </button>
              ))}
            </div>
            <fieldset className="space-y-1 text-sm">
              <legend className="mb-1 text-xs text-[var(--color-muted)]">Mikortól tegyél félre?</legend>
              <label className="flex items-center gap-2">
                <input type="radio" checked={!later} onChange={() => setLater(false)} /> Mostantól
              </label>
              <label className="flex flex-wrap items-center gap-2">
                <input type="radio" checked={later} onChange={() => setLater(true)} /> Későbbi dátumtól
                {later && (
                  <input
                    type="date"
                    className={`${INPUT} py-1 text-xs`}
                    value={saveFrom}
                    max={date || undefined}
                    onChange={(e) => setSaveFrom(e.target.value)}
                  />
                )}
              </label>
            </fieldset>
          </section>

          <section ref={coverRef} className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              2. Mi fedezi?
              <InfoTip>
                A célhoz rendelt eszközök értéke (a céldátumig lejáró papír névértéken) és a
                beszámított kuponok számítanak bele. A hiányzó részt havi félretétellel kell
                pótolni.
              </InfoTip>
            </h3>
            {options.length === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">
                Nincs tartott eszköz — a cél készpénz-félretétellel is teljesíthető, az eszközt
                később is hozzárendelheted.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {options.map((h) => {
                  const on = keys.includes(h.key);
                  const mat = maturityDay(imap.get(h.key));
                  const fits = mat && date ? maturityFitsGoal(mat, draft, today) : undefined;
                  return (
                    <li key={h.key} className="flex flex-wrap items-center gap-2 rounded-lg px-1 py-1 text-sm hover:bg-[var(--color-surface-2)]">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                        <input type="checkbox" checked={on} onChange={() => toggleKey(h.key)} />
                        <span className={`priv truncate ${on && unbuyable.includes(h.key) ? "line-through opacity-60" : ""}`}>
                          {h.name}
                        </span>
                      </label>
                      {mat && (
                        <span
                          className={`whitespace-nowrap text-xs ${
                            fits === false ? "text-[var(--color-warning,#fbbf24)]" : "text-[var(--color-muted)]"
                          }`}
                          title={
                            fits === false
                              ? "A céldátum után jár le (vagy túl közel van): újabb vétel nem javasolt belőle"
                              : "A céldátumig lejár: névértéken számít"
                          }
                        >
                          lejár: {formatDate(mat)}
                          {fits ? " ✓" : ""}
                        </span>
                      )}
                      {h.value > 0 && <span className="amt text-xs tabular-nums text-[var(--color-muted)]">{formatMoney(h.value)}</span>}
                      {on && (
                        <button
                          className={
                            unbuyable.includes(h.key)
                              ? "text-[var(--color-warning,#fbbf24)]"
                              : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                          }
                          onClick={() => toggleUnbuyable(h.key)}
                          title={
                            unbuyable.includes(h.key)
                              ? "Jelölve: már nem vásárolható — kattints, ha mégis vehető"
                              : "Már nem vásárolható (pl. lezárult a sorozat értékesítése): ne javasolja a vételét"
                          }
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <fieldset className="space-y-1 pt-1 text-sm">
              <legend className="mb-1 text-xs text-[var(--color-muted)]">Kuponok a céldátumig</legend>
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === "none"} onChange={() => setMode("none")} /> Nem számítanak
              </label>
              <label className="flex flex-wrap items-center gap-2">
                <input type="radio" checked={mode === "picked"} onChange={() => setMode("picked")} /> Csak a kijelöltek
                {mode === "picked" && (
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPicking(true)}>
                    <Coins className="h-3.5 w-3.5" />
                    {couponIds.length ? `Kijelölve: ${couponIds.length} — módosítás…` : "Kijelölés…"}
                  </button>
                )}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === "all"} onChange={() => setMode("all")} /> Minden szabad kupon (más célhoz nem rendelt)
              </label>
            </fieldset>
          </section>

          <section ref={reminderRef} className="space-y-2">
            <h3 className="text-sm font-semibold">3. Emlékeztető</h3>
            {keys.length === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">
                Rendelj hozzá eszközt, hogy havi vásárlás-emlékeztetőt kérhess.
              </p>
            ) : (
              <>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={reminder} onChange={(e) => setReminder(e.target.checked)} />
                  Havonta figyelmeztessen, amíg meg nem vettem a szükséges összeget
                </label>
                {reminder && (
                  <label className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
                    Ne javasoljon a vétel után
                    <AmountInput
                      className="w-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-xs tabular-nums"
                      value={minDays}
                      onValueChange={setMinDays}
                    />
                    napon belül vagy a céldátum után lejáró eszközt.
                  </label>
                )}
              </>
            )}
          </section>
        </div>

        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <div className="mb-2 min-h-[2.5rem] rounded-lg bg-[var(--color-surface-2)]/60 p-2 text-xs" aria-live="polite">
            {shownError ? (
              <span className="text-[var(--color-negative)]">{shownError}</span>
            ) : preview ? (
              <Preview p={preview} />
            ) : (
              <span className="text-[var(--color-muted)]">Töltsd ki a nevet, az összeget és a dátumot az előnézethez.</span>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Mégse
            </button>
            <button className="btn-primary" onClick={save}>
              <Check className="h-4 w-4" /> {goal ? "Mentés" : "Cél felvétele"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
      )}
      {picking && (
        <CouponPickerDialog
          goal={draft}
          goals={goals.filter((g) => g.id !== draft.id)}
          coupons={coupons}
          onSave={setCouponIds}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

function Preview({ p }: { p: ReturnType<typeof computeSavingsProgress>[number] }) {
  if (p.daysLeft <= 0)
    return <span className="text-[var(--color-warning,#fbbf24)]">A céldátum már elmúlt.</span>;
  if (p.reached)
    return (
      <span className="text-[var(--color-positive)]">
        ✓ Teljesül a jelenlegi fedezetből
        {p.surplusHuf > 1 && (
          <>
            {" "}· <span className="amt">+{formatMoney(p.surplusHuf)}</span> többlet a céldátum után
          </>
        )}
        {p.unneededCouponsHuf > 1 && (
          <>
            {" "}· a kuponokból <span className="amt">{formatMoney(p.unneededCouponsHuf)}</span> már nem kell
          </>
        )}
      </span>
    );
  return (
    <span>
      Havi{" "}
      <span className="amt font-semibold text-[var(--color-brand)]">{formatMoney(p.plannedMonthlyHuf)}</span>
      {p.savingStartsOn ? ` ${formatDate(p.savingStartsOn)}-tól` : ""}
      , összesen <span className="amt">{formatMoney(p.gapHuf)}</span> hiányzik · most{" "}
      <span className="amt">{formatMoney(p.assignedValueHuf)}</span> ({Math.round(p.progressPct * 100)}%)
    </span>
  );
}
