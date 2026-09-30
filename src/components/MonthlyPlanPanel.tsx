import { useState } from "react";
import { ArrowDown, ArrowUp, BellPlus, CalendarCheck, PiggyBank } from "lucide-react";
import {
  usePortfolio,
  useIncomeQueue,
  useLeftoverPlan,
  useLeftoverSettings,
  useMonthlyBudget,
  useMonthlyPlan,
  useToday,
} from "../lib/store";
import {
  leftoverStatusLines,
  leftoverTextLines,
  leftoverTitle,
  recordedLeftover,
} from "../lib/leftover";
import { CouponWarning } from "./IncomeQueue";
import {
  moveInOrder,
  planTextLines,
  type MonthlyPlan,
  type PlanLine,
} from "../lib/monthlyPlan";
import { blockedText } from "../lib/accountRules";
import { savePlanOrder } from "../lib/planPrefs";
import { formatQuantity, plannedTrade, suggestionText } from "../lib/rebalance";
import type { PlannedTrade } from "../lib/alerts";
import { effectiveMonthLabel } from "../lib/goals";
import { formatMoney } from "../lib/format";
import { AmountInput, Amt, Badge } from "./ui";
import PrivateText from "./PrivateText";

/** The whole plan as planned trades (goal buys, hold-cash lines, glide buys). */
function plannedTrades(plan: MonthlyPlan): PlannedTrade[] {
  const out: PlannedTrade[] = [];
  for (const l of plan.lines) {
    if (l.allocatedHuf < 1) continue;
    const n = l.need;
    if (n.holdCash) {
      out.push({ side: "hold", bucketName: n.name, amountHuf: Math.round(l.allocatedHuf) });
      continue;
    }
    out.push({
      side: "buy",
      bucketName: n.name,
      instrumentKey: n.instrumentKey,
      instrumentName: n.target,
      amountHuf: Math.round(l.trade?.amountHuf ?? l.allocatedHuf),
      quantity: l.trade?.quantity,
      costHuf: l.trade?.costHuf ? Math.round(l.trade.costHuf) : undefined,
      accountLabel: l.venue && l.venue.source !== "none" ? l.venue.label : undefined,
    });
  }
  for (const s of plan.glidePlan?.suggestions ?? []) if (s.status === "ok") out.push(plannedTrade(s));
  return out;
}

function LineRow({
  line,
  first,
  last,
  onMove,
  leftover,
}: {
  line: PlanLine;
  first: boolean;
  last: boolean;
  /** Omitted: the order is fixed here (the leftover split). */
  onMove?: (dir: -1 | 1) => void;
  /** The leftover split: what's still missing is the later months' job, not a shortfall. */
  leftover?: boolean;
}) {
  const n = line.need;
  const done = n.needHuf < 1;
  const arrow =
    "rounded p-0.5 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] disabled:opacity-30";
  return (
    <li className={`rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm ${done ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {onMove && (
            <span className="flex flex-col">
              <button className={arrow} disabled={first} onClick={() => onMove(-1)} title="Előrébb a sorrendben">
                <ArrowUp className="h-3 w-3" />
              </button>
              <button className={arrow} disabled={last} onClick={() => onMove(1)} title="Hátrébb a sorrendben">
                <ArrowDown className="h-3 w-3" />
              </button>
            </span>
          )}
          <Badge tone={n.ahead ? "positive" : n.kind === "savings" ? "warning" : "neutral"}>
            {n.ahead ? "Előrehozás" : n.kind === "savings" ? "Határidős cél" : "DCA"}
          </Badge>
          <span className={`truncate font-medium ${n.kind === "savings" ? "priv" : ""}`}>{n.name}</span>
        </span>
        <span className="tabular-nums">
          {done ? (
            <span className="text-xs text-[var(--color-positive)]">e havi rész teljesítve ✓</span>
          ) : (
            <Amt className="font-medium">{formatMoney(line.allocatedHuf)}</Amt>
          )}
        </span>
      </div>
      {!done && line.blocked && line.venue && (
        <div className="mt-0.5 text-xs text-[var(--color-warning)]">
          Nem vehető — {blockedText(line.venue)}. Állíts be új vételi számlát
          (Beállítások → Vételi számlák); a pénz a sorrendben továbbment.
        </div>
      )}
      {!done && !line.blocked && (
        <div className="mt-0.5 flex flex-wrap justify-between gap-2 text-xs text-[var(--color-muted)]">
          <span>
            {n.holdCash
              ? "Tartsd készpénzben a céldátumig"
              : line.trade
                ? `${n.target} vétel`
                : `${n.target}`}
            {line.venue && line.venue.source !== "none" && (
              <>
                {" → "}
                {line.venue.label}
                {line.venue.pending && (
                  <span className="text-[var(--color-warning)]">
                    {" "}(még nincs a nyilvántartásban — nyisd meg; az első import után ide kötődik)
                  </span>
                )}
              </>
            )}
          </span>
          <span className="tabular-nums">
            {line.trade?.quantity != null && (
              <>
                <Amt>{formatQuantity(line.trade.quantity)} db</Amt> ·{" "}
              </>
            )}
            {line.trade && (
              <>
                díj ≈ <Amt>{formatMoney(line.trade.costHuf)}</Amt>
                {line.trade.fxCostHuf != null && line.trade.fxCostHuf >= 1 && (
                  <>
                    {" "}+ váltás <Amt>{formatMoney(line.trade.fxCostHuf)}</Amt>
                  </>
                )}
              </>
            )}
          </span>
        </div>
      )}
      {!done && n.holdCash && n.holdReason && (
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">
          Nem vehető, ezért készpénz: {n.holdReason}
        </div>
      )}
      {line.upcoming && (
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">
          {line.upcoming.from}-tól: {line.upcoming.label}
        </div>
      )}
      {line.shortHuf >= 1 &&
        (leftover ? (
          <div className="mt-0.5 text-xs text-[var(--color-muted)]">
            A célból még hiányzik: <Amt>{formatMoney(line.shortHuf)}</Amt>
          </div>
        ) : (
          <div className="mt-0.5 text-xs text-[var(--color-negative)]">
            Alul maradt: −<Amt>{formatMoney(line.shortHuf)}</Amt> (kellene{" "}
            <Amt>{formatMoney(n.needHuf)}</Amt>)
          </div>
        ))}
    </li>
  );
}

/**
 * "Havi terv": this month's saving split across every goal in order — dated
 * goals, DCA goals, then the glide path with whatever is left. The goal cards
 * and reminders read the same numbers (see monthlyPlan.ts).
 */
export default function MonthlyPlanPanel() {
  const [amountRaw, setAmountRaw] = useState<string | null>(null);
  const override = amountRaw != null ? Number(amountRaw) || 0 : null;
  const { plan, needs, budgetHuf, defaultAmount } = useMonthlyPlan(override);
  const addReminder = usePortfolio((s) => s.addReminder);
  const reminders = usePortfolio((s) => s.reminders);
  const today = useToday();

  const doneHuf = needs.reduce((s, n) => s + n.doneHuf, 0);
  const monthLabel = effectiveMonthLabel(new Date(`${today}T12:00:00`));
  const title = `Havi terv – ${monthLabel} (${formatMoney(plan.amountHuf)})`;
  const steps = plannedTrades(plan);
  const added = reminders.some((r) => r.title === title);

  return (
    <section className="mb-6">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <CalendarCheck className="h-4 w-4 text-[var(--color-brand)]" />
        Havi terv — {monthLabel}
      </h3>
      <p className="mb-2 text-xs text-[var(--color-muted)]">
        A havi megtakarítás sorrendben: előbb a határidős célok e havi része, majd a
        DCA-célok, a maradék a célpályán. Ha nem elég a pénz, az előrébb álló kap
        teljesen — a sorrend a nyilakkal állítható. A kuponokat lent, a
        „Beérkezett” lista osztja el.
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <AmountInput
          value={String(plan.amountHuf)}
          onValueChange={(raw) => setAmountRaw(raw)}
          className="w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right tabular-nums"
        />
        <span className="text-[var(--color-muted)]">Ft</span>
        {amountRaw != null && (
          <button className="text-xs text-[var(--color-muted)] underline" onClick={() => setAmountRaw(null)}>
            vissza az alapértékre (<Amt>{formatMoney(defaultAmount)}</Amt>)
          </button>
        )}
      </div>
      <p className="mb-2 text-xs text-[var(--color-muted)]">
        Alapérték: havi keret <Amt>{formatMoney(budgetHuf)}</Amt>
        {doneHuf >= 1 && (
          <>
            {" "}− e hónapban már teljesítve <Amt>{formatMoney(doneHuf)}</Amt>
          </>
        )}
        {amountRaw != null && " (most kézzel átírva)"}
      </p>

      <PlanBody
        plan={plan}
        onMove={(key, dir) => savePlanOrder(moveInOrder(needs, key, dir))}
      />
      {steps.length > 0 && (
        <button
          className="btn-ghost mt-2 text-xs"
          disabled={added}
          onClick={() =>
            void addReminder({
              severity: "info",
              title,
              detail: planTextLines(plan).join("; ") + ".",
              to: "/goals",
              plan: steps,
            })
          }
          title={
            added
              ? "Ez a terv már a teendők között van"
              : "Az egész terv egy tervezett tranzakcióként a figyelmeztetések közé (szinkron után Telegramon is)"
          }
        >
          <BellPlus className="h-4 w-4" />
          {added ? "Felvéve a teendők közé" : "Rögzítés tervezett tranzakcióként"}
        </button>
      )}
      <LeftoverSection />
    </section>
  );
}

/** The plan's lines, the glide path, the per-account deposits and the shortfall. */
function PlanBody({
  plan,
  onMove,
  capped = true,
}: {
  plan: MonthlyPlan;
  onMove?: (key: string, dir: -1 | 1) => void;
  /** The glide path's monthly cap applies (not for the leftover). */
  capped?: boolean;
}) {
  const glideSteps = plan.glidePlan?.suggestions.filter((s) => s.status === "ok") ?? [];
  // The leftover shows only what gets money; the Havi terv shows every goal.
  const leftover = !capped;
  const lines = leftover ? plan.lines.filter((l) => l.allocatedHuf >= 1) : plan.lines;
  return (
    <>
    <ul className="space-y-2">
      {lines.map((l, i) => (
        <LineRow
          key={l.need.key}
          line={l}
          first={i === 0}
          last={i === lines.length - 1}
          onMove={onMove && ((dir) => onMove(l.need.key, dir))}
          leftover={leftover}
        />
      ))}
      {(!leftover || plan.glideHuf >= 1) && (
        <li className="rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Badge tone="positive">Célpálya</Badge>
              <span className="text-xs text-[var(--color-muted)]">
                {capped ? "a maradék — mindig az utolsó" : "a teljes maradék — mindig az utolsó"}
              </span>
            </span>
            <Amt className="font-medium tabular-nums">{formatMoney(plan.glideHuf)}</Amt>
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-muted)]">
            {plan.glidePlan ? (
              <>
                Célpont: {plan.glidePlan.flow.label} —{" "}
                {glideSteps.length ? (
                  <PrivateText text={glideSteps.map(suggestionText).join("; ")} amounts />
                ) : (
                  "nincs javasolt vétel"
                )}
                {glideSteps.some((s) => s.costHuf > 0) && (
                  <>
                    {" "}(díj ≈ <Amt>{formatMoney(glideSteps.reduce((a, s) => a + s.costHuf, 0))}</Amt>)
                  </>
                )}
              </>
            ) : (
              "A célok után nem marad rá pénz."
            )}
          </div>
          {plan.glidePlan && plan.glidePlan.notes.length > 0 && (
            <ul className="mt-0.5 text-xs text-[var(--color-warning)]">
              {plan.glidePlan.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          )}
        </li>
      )}
      {plan.freeHuf >= 1 && (
        <li className="px-3 text-xs text-[var(--color-muted)]">
          Szabad maradék (a célpálya havi összegén felül): <Amt>{formatMoney(plan.freeHuf)}</Amt>
        </li>
      )}
    </ul>
    {plan.deposits.length > 0 && (
      <div className="mt-3 rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm">
        <div className="mb-1 text-xs font-medium text-[var(--color-muted)]">
          Hová utald? — a fenti tételek számlánként összesítve (vétel + díj + váltás),
          nem újabb tételek
        </div>
        <ul className="space-y-0.5">
          {plan.deposits.map((d) => (
            <li key={d.label} className="flex flex-wrap justify-between gap-2">
              <span>
                {d.label}
                {d.pending && (
                  <span className="text-xs text-[var(--color-warning)]"> — még nincs, nyisd meg</span>
                )}
                {d.items.length > 0 && (
                  <span className="text-xs text-[var(--color-muted)]">
                    {" "}= <PrivateText text={d.items.join(" + ")} />
                  </span>
                )}
              </span>
              <span className="tabular-nums">
                <Amt className="font-medium">{formatMoney(d.totalHuf)}</Amt>
                {d.fxCostHuf >= 1 && (
                  <span className="text-xs text-[var(--color-muted)]">
                    {" "}(ebből váltás <Amt>{formatMoney(d.fxCostHuf)}</Amt>)
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    )}
    {plan.shortHuf >= 1 && !leftover && (
      <p className="mt-2 text-xs text-[var(--color-negative)]">
        Nem elég a pénz minden célra — összesen <Amt>{formatMoney(plan.shortHuf)}</Amt> hiányzik
        (a sorrend szerint a hátsó célok maradtak alul).
      </p>
    )}
    </>
  );
}

/**
 * "Maradt pénz a hónapból?": the closing month's leftover, split like the
 * Havi terv — open goal parts, next month's parts pulled forward, then the
 * glide path with all the rest (see leftover.ts). The Telegram bot's
 * /maradek answers with the same numbers.
 */
function LeftoverSection() {
  const [amountRaw, setAmountRaw] = useState<string | null>(null);
  const amount = amountRaw != null ? Number(amountRaw) || 0 : 0;
  const { plan, leftover, budgetHuf } = useLeftoverPlan(amount);
  const settings = useLeftoverSettings();
  const addReminder = usePortfolio((s) => s.addReminder);
  const reminders = usePortfolio((s) => s.reminders);
  const today = useToday();
  const { couponGoals } = useMonthlyBudget();
  const income = useIncomeQueue();
  const recorded = recordedLeftover(reminders, leftover.month);
  const [open, setOpen] = useState(false);
  const month = leftover.month;
  const isPayday = new Date(`${today}T12:00:00`).getDate() >= month.lastWorkday;
  const status = leftoverStatusLines(leftover, budgetHuf);
  const steps = plannedTrades(plan);
  const title = leftoverTitle(month, amount);

  return (
    <div className="mt-4 rounded-xl border border-[var(--color-border)] px-3 py-2">
      <button
        className="flex w-full items-center justify-between gap-2 text-left text-sm font-semibold"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open || isPayday}
      >
        <span className="flex items-center gap-2">
          <PiggyBank className="h-4 w-4 text-[var(--color-brand)]" />
          Maradt pénz a hónapból? — {month.label}
        </span>
        {recorded ? (
          <Badge tone="positive">rögzítve</Badge>
        ) : (
          <span className="text-xs font-normal text-[var(--color-muted)]">{open || isPayday ? "▲" : "▼"}</span>
        )}
      </button>
      {(open || isPayday) && (
        <div className="mt-2">
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Ha kevesebbet költöttél, írd be, mennyi maradt. Előbb a hónap még
            hiányzó célrészei kapnak (a Havi terv sorrendjében)
            {settings.pullForward &&
              `, majd a ${settings.pullForwardMonths} hónapon belül esedékes határidős célok mindazt megkapják, ami a céldátumig még hiányzik (a későbbi célok csak az e havi részüket)`}
            , a maradék pedig — mind — a célpályán megy. Ami már teljesült vagy
            a Havi tervben rögzítve van, nem kerül újra elosztásra. A hónap
            utolsó munkanapja: {month.lastWorkday}.
          </p>
          <ul className="mb-2 text-xs text-[var(--color-muted)]">
            {status.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {recorded && (
            <p className="mb-2 text-xs text-[var(--color-positive)]">
              Erre a hónapra már rögzítettél maradékot: „{recorded.title}”.
            </p>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <AmountInput
              value={String(amount)}
              onValueChange={(raw) => setAmountRaw(raw)}
              className="w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right tabular-nums"
            />
            <span className="text-[var(--color-muted)]">Ft maradt</span>
            {amountRaw != null && (
              <button className="text-xs text-[var(--color-muted)] underline" onClick={() => setAmountRaw(null)}>
                törlés
              </button>
            )}
          </div>
          {amountRaw != null && (
            <CouponWarning goals={couponGoals} allocations={income.allocations} onPick={() => setAmountRaw(null)} />
          )}
          {amount >= 1 ? (
            <>
              <PlanBody plan={plan} capped={false} />
              {steps.length > 0 && (
                <button
                  className="btn-ghost mt-2 text-xs"
                  disabled={!!recorded}
                  onClick={() =>
                    void addReminder({
                      severity: "info",
                      title,
                      detail: leftoverTextLines(plan).join("; ") + ".",
                      to: "/goals",
                      plan: steps,
                    })
                  }
                  title={
                    recorded
                      ? "Erre a hónapra már van rögzített maradék — előbb töröld a teendők közül"
                      : "A maradék elosztása egy tervezett tranzakcióként a teendők közé (szinkron után a bot is látja)"
                  }
                >
                  <BellPlus className="h-4 w-4" />
                  {recorded ? "Már rögzítve" : "Rögzítés tervezett tranzakcióként"}
                </button>
              )}
            </>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">Adj meg egy összeget a javaslathoz.</p>
          )}
        </div>
      )}
    </div>
  );
}
