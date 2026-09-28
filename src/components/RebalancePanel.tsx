import { useMemo, useState } from "react";
import { ListChecks, BellPlus, FlaskConical } from "lucide-react";
import {
  usePortfolio,
  useGlideVersions,
  useGlideState,
  useIncomeQueue,
  useMonthlyBudget,
  useToday,
  useAccountContext,
} from "../lib/store";
import IncomeQueue, { CouponWarning } from "./IncomeQueue";
import MonthlyPlanPanel from "./MonthlyPlanPanel";
import { latestConfig, type GlideConfig } from "../lib/glidePath";
import type { AccountContext } from "../lib/accountRules";
import {
  allocationState,
  applyShock,
  bandRule,
  formatQuantity,
  freeCashHuf,
  incomingBuyOptions,
  placeIncoming,
  planCashflow,
  planSummary,
  plannedTrade,
  suggestionText,
  type AllocationState,
  type BandStatus,
  type RebalancePlan,
  type Suggestion,
} from "../lib/rebalance";
import { formatMoney } from "../lib/format";
import { AmountInput, Amt, Badge, Card } from "./ui";
import { PctInput } from "./GlidePathEditor";

const pct = (v: number) =>
  `${(v * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })}%`;

const SIDE: Record<Suggestion["side"], { label: string; tone: "positive" | "warning" | "neutral" }> = {
  buy: { label: "Vétel", tone: "positive" },
  sell: { label: "Eladás", tone: "warning" },
  redirect: { label: "Átirányítás", tone: "neutral" },
  transfer: { label: "Utalás", tone: "neutral" },
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
                    {s.side === "redirect"
                      ? s.redirectIn
                        ? "Jövőbeli befizetések ide"
                        : "Jövőbeli befizetések máshová"
                      : s.side === "transfer"
                        ? `${s.fromLabel ?? "?"} → ${s.toLabel ?? "?"}`
                        : (s.instrumentName ?? "—")}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {s.side === "transfer" ? "" : s.bucketName}
                    {s.accountLabel && s.side !== "transfer" && ` · ${s.accountLabel}`}
                    {s.side === "buy" && s.venueChange && ` · ${s.venueChange.from}-tól: ${s.venueChange.label}`}
                  </span>
                </span>
                <span className="tabular-nums">
                  <Amt className="font-medium">{formatMoney(s.amountHuf)}</Amt>
                  {s.quantity != null && s.quantity !== s.amountHuf && (
                    <span className="text-xs text-[var(--color-muted)]"> · <Amt>{formatQuantity(s.quantity)} db</Amt></span>
                  )}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap justify-between gap-2 text-xs text-[var(--color-muted)]">
                <span>
                  {ok
                    ? s.reason
                    : s.status === "account-locked"
                      ? `Nem hajtható végre — ${s.reason}`
                      : `Nem javasolt — ${s.reason}`}
                </span>
                <span className="tabular-nums">
                  {s.costHuf > 0 && (
                    <>
                      költség ≈ <Amt>{formatMoney(s.costHuf)}</Amt> ·{" "}
                    </>
                  )}
                  {s.fxCostHuf != null && s.fxCostHuf >= 1 && (
                    <>
                      váltás ≈ <Amt>{formatMoney(s.fxCostHuf)}</Amt> ·{" "}
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

/** What the plan moves and costs: totals, the cost split, the transfers. */
function PlanSummaryBox({ plan }: { plan: RebalancePlan }) {
  const s = planSummary(plan);
  if (s.sellHuf + s.buyHuf + s.transferHuf < 1 && s.blocked.length === 0) return null;
  const row = (label: string, v: number) =>
    v >= 1 && (
      <li className="flex justify-between gap-2">
        <span>{label}</span>
        <Amt className="tabular-nums">{formatMoney(v)}</Amt>
      </li>
    );
  return (
    <div className="mt-3 rounded-xl border border-[var(--color-border)] px-3 py-2 text-xs">
      <div className="mb-1 font-medium text-[var(--color-muted)]">Összesítés</div>
      <ul className="space-y-0.5">
        {row("Eladások", s.sellHuf)}
        {row("Vételek", s.buyHuf)}
        {row("Utalások számlák között", s.transferHuf)}
        {row("Tranzakciós díj", s.tradeCostHuf)}
        {row("Idő előtti visszaváltás", s.redemptionCostHuf)}
        {row("Devizaváltás", s.fxCostHuf)}
        {row("Utalási díj", s.transferCostHuf)}
        <li className="flex justify-between gap-2 border-t border-[var(--color-border)] pt-0.5 font-medium">
          <span>Összes költség</span>
          <Amt className="tabular-nums">{formatMoney(s.totalCostHuf)}</Amt>
        </li>
      </ul>
      {s.transfers.length > 0 && (
        <>
          <div className="mt-2 mb-0.5 font-medium text-[var(--color-muted)]">Utalások</div>
          <ul className="space-y-0.5">
            {s.transfers.map((t, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2">
                <span>
                  {t.fromLabel} → {t.toLabel}
                </span>
                <Amt className="tabular-nums">{formatMoney(t.amountHuf)}</Amt>
              </li>
            ))}
          </ul>
        </>
      )}
      {s.blocked.length > 0 && (
        <p className="mt-2 text-[var(--color-warning)]">
          {s.blocked.length} lépés a számlakorlátok miatt nem hajtható végre (fent halványan, indoklással).
        </p>
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
      plan: steps.map(plannedTrade),
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

  // Extra money only (a dividend, an extra deposit): the monthly saving is
  // split by the Havi terv above — defaulting to it here would route the
  // glide path's share twice. Coupons go through the "Beérkezett" list.
  const { couponGoals } = useMonthlyBudget();
  const income = useIncomeQueue();
  const [pickedIncome, setPickedIncome] = useState<string | null>(null);
  const [amountRaw, setAmountRaw] = useState<string | null>(null);
  const amount = amountRaw != null ? Number(amountRaw) || 0 : 0;

  // Free cash = cash balances outside every bucket (the source of new money).
  const freeCash = useMemo(() => (state ? freeCashHuf(state) : 0), [state]);
  const [useCash, setUseCash] = useState(true);
  const [shocks, setShocks] = useState<Record<string, number | undefined>>({});
  const accounts = useAccountContext();

  // Extra money arrives from outside: each buy goes to its account for new
  // buys (none into an account that takes no deposits).
  const flowPlan = useMemo(() => {
    if (!cfg || !state) return null;
    const p = planCashflow(cfg, state, amount, incomingBuyOptions(accounts));
    return { ...placeIncoming(p, accounts), flow: p.flow };
  }, [cfg, state, amount, accounts]);
  const bandPlan = useMemo(
    () => (cfg && state ? bandRule(cfg, state, useCash ? freeCash : 0, accounts) : null),
    [cfg, state, useCash, freeCash, accounts],
  );
  const sim = useMemo(
    () => simulate(cfg, state, shocks, useCash ? freeCash : 0, accounts),
    [cfg, state, shocks, useCash, freeCash, accounts],
  );

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

      <MonthlyPlanPanel />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <h3 className="text-sm font-semibold">1. Bejövő pénz elosztása</h3>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Elsődleges eszköz: a pénz a pályához képest leginkább alulsúlyozott
            csoportokba megy, eladás nélkül. Itt az extra pénzt (osztalék, rendkívüli
            befizetés) oszthatod el — a havi megtakarítást a Havi terv, a kuponokat
            a „Beérkezett” lista.
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
                törlés
              </button>
            )}
          </div>
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
            Másodlagos eszköz, csak ha egy csoport kilépett a sávjából. A kezelés
            (a pályacélig, a sávhatárig vagy kereskedés nélkül) csoportonként
            állítható; a cél lépésenként egy: {flow.label}, a mai sávba szorítva.
          </p>
          {outOfBand.length > 0 && freeCash >= cfg.minTradeHuf && (
            <label className="mb-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={useCash} onChange={(e) => setUseCash(e.target.checked)} />
              A csoporton kívüli szabad készpénz (<Amt>{formatMoney(freeCash)}</Amt>) is felhasználható
            </label>
          )}
          <SuggestionList plan={bandPlan} empty="Minden csoport a sávján belül — nincs teendő." />
          <PlanSummaryBox plan={bandPlan} />
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
            <PlanSummaryBox plan={sim.plan} />
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
  accounts: AccountContext,
): { state: AllocationState; plan: RebalancePlan } | null {
  if (!cfg || !state) return null;
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(shocks))
    if (v != null && Number.isFinite(v) && v !== 0) clean[k] = v;
  if (Object.keys(clean).length === 0) return null;
  const held = [...state.positions.filter((p) => p.valueHuf !== 0), ...state.unassigned];
  const shocked = allocationState(cfg, applyShock(cfg, held, clean), state.day);
  return { state: shocked, plan: bandRule(cfg, shocked, cash, accounts) };
}
