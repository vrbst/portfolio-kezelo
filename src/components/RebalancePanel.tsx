import { useMemo, useState } from "react";
import { ListChecks, BellPlus, FlaskConical } from "lucide-react";
import {
  usePortfolio,
  useGlideVersions,
  useGlideState,
  useIncomeQueue,
  useMonthlyBudget,
  useToday,
} from "../lib/store";
import IncomeQueue, { CouponWarning } from "./IncomeQueue";
import { latestConfig, type GlideConfig } from "../lib/glidePath";
import {
  allocationState,
  applyShock,
  bandRule,
  formatQuantity,
  freeCashHuf,
  planCashflow,
  suggestionText,
  type AllocationState,
  type BandStatus,
  type RebalancePlan,
  type Suggestion,
} from "../lib/rebalance";
import type { PlannedTrade } from "../lib/alerts";
import { glideAmountSource } from "../lib/budget";
import { formatMoney } from "../lib/format";
import { AmountInput, Amt, Badge, Card } from "./ui";
import { PctInput } from "./GlidePathEditor";

const pct = (v: number) =>
  `${(v * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })}%`;

const SIDE: Record<Suggestion["side"], { label: string; tone: "positive" | "warning" | "neutral" }> = {
  buy: { label: "Vétel", tone: "positive" },
  sell: { label: "Eladás", tone: "warning" },
  redirect: { label: "Átirányítás", tone: "neutral" },
};

const STATUS_LABEL: Record<BandStatus, string> = {
  within: "sávon belül",
  below: "sáv alatt",
  above: "sáv fölött",
  empty: "nincs adat",
};

function SuggestionList({
  plan,
  empty,
  targetNote,
}: {
  plan: RebalancePlan;
  empty: string;
  /** Extra text after the weight-after (the targets it compares to). */
  targetNote?: (s: Suggestion) => string | null;
}) {
  if (plan.suggestions.length === 0)
    return (
      <div className="text-sm text-[var(--color-muted)]">
        {plan.notes.length ? plan.notes.join(" ") : empty}
      </div>
    );
  return (
    <div>
      <ul className="space-y-2">
        {plan.suggestions.map((s, i) => {
          const ok = s.status === "ok";
          return (
            <li
              key={i}
              className={`rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm ${ok ? "" : "opacity-60"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge tone={ok ? SIDE[s.side].tone : "neutral"}>{SIDE[s.side].label}</Badge>
                  <span className="truncate">
                    {s.side === "redirect" ? "Jövőbeli befizetések" : (s.instrumentName ?? "—")}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">{s.bucketName}</span>
                </span>
                <span className="tabular-nums">
                  <Amt className="font-medium">{formatMoney(s.amountHuf)}</Amt>
                  {s.quantity != null && s.quantity !== s.amountHuf && (
                    <span className="text-xs text-[var(--color-muted)]"> · <Amt>{formatQuantity(s.quantity)} db</Amt></span>
                  )}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap justify-between gap-2 text-xs text-[var(--color-muted)]">
                <span>{ok ? s.reason : `Nem javasolt — ${s.reason}`}</span>
                <span className="tabular-nums">
                  {s.costHuf > 0 && (
                    <>
                      költség ≈ <Amt>{formatMoney(s.costHuf)}</Amt> ·{" "}
                    </>
                  )}
                  {s.weightAfter != null && `utána ${pct(s.weightAfter)}`}
                  {targetNote?.(s) && ` · ${targetNote(s)}`}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {plan.notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-warning)]">
          {plan.notes.map((n, i) => (
            <li key={i}>• {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Saves the plan's suggested ("ok") steps as ONE reminder. Never executes. */
function SaveAsReminder({ plan, title }: { plan: RebalancePlan; title: string }) {
  const addReminder = usePortfolio((s) => s.addReminder);
  const reminders = usePortfolio((s) => s.reminders);
  const steps = plan.suggestions.filter((s) => s.status === "ok");
  if (steps.length === 0) return null;
  const added = reminders.some((r) => r.title === title);
  const save = () =>
    void addReminder({
      severity: "info",
      title,
      detail: steps.map(suggestionText).join("; ") + ".",
      to: "/goals",
      plan: steps.map(
        (s): PlannedTrade => ({
          side: s.side,
          bucketName: s.bucketName,
          instrumentKey: s.instrumentKey,
          instrumentName: s.instrumentName,
          amountHuf: Math.round(s.amountHuf),
          quantity: s.quantity,
          costHuf: s.costHuf ? Math.round(s.costHuf) : undefined,
        }),
      ),
    });
  return (
    <button
      className="btn-ghost mt-2 text-xs"
      onClick={save}
      disabled={added}
      title={
        added
          ? "Ez a terv már a teendők között van"
          : "Tervezett tranzakcióként a figyelmeztetések közé (szinkron után Telegramon is)"
      }
    >
      <BellPlus className="h-4 w-4" />
      {added ? "Felvéve a teendők közé" : "Rögzítés tervezett tranzakcióként"}
    </button>
  );
}

/** Instrument display names for positions assigned but not held (key only). */
function useNamed(state: AllocationState | null): AllocationState | null {
  const instruments = usePortfolio((s) => s.instruments);
  return useMemo(() => {
    if (!state) return null;
    const names = new Map(instruments.map((i) => [i.key, i.name]));
    return {
      ...state,
      positions: state.positions.map((p) =>
        p.name === p.key && names.has(p.key) ? { ...p, name: names.get(p.key)! } : p,
      ),
    };
  }, [state, instruments]);
}

/**
 * "Teendők": what to do now, along the glide path.
 *  1. Incoming money (monthly saving, coupon, dividend, deposit) — routed to the
 *     buckets furthest below their path (the primary tool);
 *  2. the band rule — only for buckets outside their band;
 *  3. a what-if simulation: shock a bucket by ±X%.
 * Any plan can be saved as a planned transaction (reminder); the app never
 * executes anything — the real trade comes in through the statement import.
 */
export default function RebalancePanel() {
  const versions = useGlideVersions();
  const cfg = latestConfig(versions);
  const state = useNamed(useGlideState(versions));
  const today = useToday();

  // Default: the glide path's own monthly amount (its slice of the budget);
  // overwritable for a coupon, dividend or extra deposit.
  const { breakdown, couponGoals } = useMonthlyBudget();
  const income = useIncomeQueue();
  const [pickedIncome, setPickedIncome] = useState<string | null>(null);
  const defaultAmount = breakdown.glideHuf;
  const source = glideAmountSource(breakdown, cfg);
  const [amountRaw, setAmountRaw] = useState<string | null>(null);
  const amount = amountRaw != null ? Number(amountRaw) || 0 : defaultAmount;

  // Free cash = cash balances outside every bucket (the source of new money).
  const freeCash = useMemo(() => (state ? freeCashHuf(state) : 0), [state]);
  const [useCash, setUseCash] = useState(true);
  const [shocks, setShocks] = useState<Record<string, number | undefined>>({});

  const flowPlan = useMemo(
    () => (cfg && state ? planCashflow(cfg, state, amount) : null),
    [cfg, state, amount],
  );
  const bandPlan = useMemo(
    () => (cfg && state ? bandRule(cfg, state, useCash ? freeCash : 0) : null),
    [cfg, state, useCash, freeCash],
  );
  const sim = useMemo(() => simulate(cfg, state, shocks, useCash ? freeCash : 0), [
    cfg,
    state,
    shocks,
    useCash,
    freeCash,
  ]);

  if (!cfg || !state || !flowPlan || !bandPlan) return null;
  const flow = flowPlan.flow;
  const todayTarget = new Map(state.buckets.map((b) => [b.bucket.id, b.target]));
  const flowNote = (s: Suggestion) => {
    const today = todayTarget.get(s.bucketId);
    if (today == null) return null;
    const ahead = flow.weights.get(s.bucketId);
    return flow.ahead && ahead != null
      ? `mai pályacél ${pct(today)}, célpont ${pct(ahead)}`
      : `pályacél ${pct(today)}`;
  };
  const outOfBand = state.buckets.filter((b) => b.status === "below" || b.status === "above");

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <ListChecks className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Teendők</h2>
      </div>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Javaslatok a célpálya alapján — az app semmit nem hajt végre. A rögzített
        terv teendőként jelenik meg; a valódi tranzakció a szokásos importtal
        kerül be.
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <h3 className="text-sm font-semibold">1. Bejövő pénz elosztása</h3>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Elsődleges eszköz: a pénz a pályához képest leginkább alulsúlyozott
            csoportokba megy, eladás nélkül.
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <AmountInput
              value={String(amount)}
              onValueChange={(raw) => setAmountRaw(raw)}
              className="w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right tabular-nums"
            />
            <span className="text-[var(--color-muted)]">Ft</span>
            {amountRaw != null && (
              <button className="text-xs text-[var(--color-muted)] underline" onClick={() => setAmountRaw(null)}>
                vissza a célpálya havi összegére (<Amt>{formatMoney(defaultAmount)}</Amt>)
              </button>
            )}
          </div>
          {source && (
            <p
              className={`mb-2 text-xs ${
                breakdown.glideMode === "legacy" ? "text-[var(--color-warning)]" : "text-[var(--color-muted)]"
              }`}
            >
              Alapérték — {source}
              {amountRaw != null && " (most kézzel átírva)"}
            </p>
          )}
          {amountRaw != null && (
            <CouponWarning
              goals={couponGoals}
              allocations={income.allocations}
              onPick={(id) => {
                setAmountRaw(null);
                setPickedIncome(id);
              }}
            />
          )}
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Célpont: {flow.label}
            {flow.ahead && " (előretekintés — a sáv és az állapot továbbra is a mai pályacélhoz mér)"}
          </p>
          <SuggestionList plan={flowPlan} targetNote={flowNote} empty="Adj meg egy összeget (havi megtakarítás, kupon, osztalék, befizetés)." />
          <SaveAsReminder plan={flowPlan} title={`Célpálya – ${formatMoney(amount)} elosztása (${today})`} />
          <IncomeQueue allocations={income.allocations} since={income.since} highlightId={pickedIncome} />
        </section>

        <section>
          <h3 className="text-sm font-semibold">2. Sávon kívüli csoportok</h3>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Másodlagos eszköz, csak ha egy csoport kilépett a sávjából
            ({cfg.restoreTo === "path" ? "visszaállítás a pályacélig" : "visszaállítás a sávhatárig"}).
          </p>
          {outOfBand.length > 0 && freeCash >= cfg.minTradeHuf && (
            <label className="mb-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={useCash} onChange={(e) => setUseCash(e.target.checked)} />
              A csoporton kívüli szabad készpénz (<Amt>{formatMoney(freeCash)}</Amt>) is felhasználható
            </label>
          )}
          <SuggestionList plan={bandPlan} empty="Minden csoport a sávján belül — nincs teendő." />
          <SaveAsReminder plan={bandPlan} title={`Célpálya – sávkorrekció (${today})`} />
        </section>
      </div>

      <section className="mt-6 border-t border-[var(--color-border)] pt-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <FlaskConical className="h-4 w-4" /> 3. Szimuláció: mi lenne, ha…
        </h3>
        <p className="mb-3 text-xs text-[var(--color-muted)]">
          Add meg, hány százalékot esne (negatív) vagy emelkedne egy csoport. A
          készpénz és a csoporton kívüli tételek nem változnak.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--color-muted)]">
                <th className="py-1 pr-2 font-medium">Csoport</th>
                <th className="py-1 pr-2 font-medium">Változás</th>
                <th className="py-1 pr-2 text-right font-medium">Most</th>
                <th className="py-1 pr-2 text-right font-medium">Utána</th>
                <th className="py-1 font-medium">Állapot utána</th>
              </tr>
            </thead>
            <tbody>
              {state.buckets.map((b) => {
                const after = sim?.state.buckets.find((x) => x.bucket.id === b.bucket.id);
                return (
                  <tr key={b.bucket.id} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-2">{b.bucket.name}</td>
                    <td className="py-1.5 pr-2">
                      <span className="flex items-center gap-1">
                        <PctInput
                          value={shocks[b.bucket.id]}
                          onChange={(v) => setShocks((s) => ({ ...s, [b.bucket.id]: v }))}
                          className="w-16"
                          placeholder="0"
                        />
                        <span className="text-xs text-[var(--color-muted)]">%</span>
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{pct(b.weight)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{after ? pct(after.weight) : "—"}</td>
                    <td className="py-1.5">
                      {after && (
                        <Badge tone={after.status === "within" ? "positive" : after.status === "empty" ? "neutral" : "warning"}>
                          {STATUS_LABEL[after.status]}
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {sim && (
          <div className="mt-3">
            <p className="mb-2 text-xs font-medium text-[var(--color-muted)]">Szükséges lépések a szimulált helyzetben</p>
            <SuggestionList plan={sim.plan} empty="A szimulált helyzetben minden csoport a sávján belül marad." />
          </div>
        )}
      </section>
    </Card>
  );
}

/** The shocked state and its band-rule plan; null while no shock is entered. */
function simulate(
  cfg: GlideConfig | undefined,
  state: AllocationState | null,
  shocks: Record<string, number | undefined>,
  cash: number,
): { state: AllocationState; plan: RebalancePlan } | null {
  if (!cfg || !state) return null;
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(shocks))
    if (v != null && Number.isFinite(v) && v !== 0) clean[k] = v;
  if (Object.keys(clean).length === 0) return null;
  const held = [...state.positions.filter((p) => p.valueHuf !== 0), ...state.unassigned];
  const shocked = allocationState(cfg, applyShock(cfg, held, clean), state.day);
  return { state: shocked, plan: bandRule(cfg, shocked, cash) };
}
