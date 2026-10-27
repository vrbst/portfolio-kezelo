import { useState } from "react";
import { BellRing, CalendarClock, ChartLine, CircleCheck, Coins, Pencil, Trash2, Wallet } from "lucide-react";
import InfoTip from "../InfoTip";
import GoalReserves from "../GoalReserves";
import { Badge } from "../ui";
import { useToday, useValuedInstruments } from "../../lib/store";
import {
  DEFAULT_MIN_DAYS_TO_MATURITY,
  suitableForGoalBuy,
  type ReserveConflict,
  type SavingsGoal,
  type SavingsProgress,
} from "../../lib/savings";
import { formatDate, formatMoney } from "../../lib/format";
import type { EditorSection } from "./GoalEditorDialog";

const WARN = "text-[var(--color-warning,#fbbf24)]";

/**
 * One medium-term goal: where it stands (segmented bar, three numbers, a
 * surplus when the assignments bring more than the goal needs), the one thing
 * to do now, and read-only chips of what is set — everything is changed in
 * the editor dialog; the schedule dialog shows the timeline.
 */
export default function GoalCard({
  progress: p,
  planHuf,
  conflicts,
  nameOf,
  onEdit,
  onSchedule,
  onUpdate,
  onRemove,
  onClose,
}: {
  progress: SavingsProgress;
  /** This month's remaining quota (savingsMonthStates — the Havi terv's figure). */
  planHuf: number;
  /** Buys that may have been paid from this goal's reserves. */
  conflicts: ReserveConflict[];
  nameOf: (key: string) => string;
  onEdit: (section: EditorSection) => void;
  onSchedule: () => void;
  onUpdate: (id: string, patch: Partial<SavingsGoal>) => void;
  onRemove: (id: string) => void;
  /** Close the goal by hand (achieved or given up): it drops to the end, dimmed. */
  onClose: (id: string) => void;
}) {
  const g = p.goal;
  const instruments = useValuedInstruments();
  const today = useToday();
  const [confirming, setConfirming] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [showReserves, setShowReserves] = useState(false);

  const expired = p.daysLeft <= 0;
  const status = expired && !p.reached
    ? { tone: "warning" as const, text: "Lejárt, hiányzik" }
    : p.reached
      ? p.surplusHuf > 1
        ? { tone: "positive" as const, text: "Többlet" }
        : { tone: "positive" as const, text: "Teljesül" }
      : p.savingStartsOn
        ? { tone: "neutral" as const, text: "Még nem indult" }
        : { tone: "brand" as const, text: "Úton" };

  // Segments on a scale of max(target, projected): papers | automatic cash |
  // set aside | coupons still to come (pale) — a surplus overshoots the target mark.
  const scale = Math.max(p.targetHuf, p.projectedHuf, 1);
  const papers = Math.max(0, p.assignedValueHuf - p.autoCashHuf - p.reservedHuf);
  const seg = (v: number) => `${Math.min(100, (Math.max(0, v) / scale) * 100)}%`;
  const targetAt = `${(p.targetHuf / scale) * 100}%`;
  const overshoot = p.projectedHuf > p.targetHuf + 1;

  const noBuy =
    !p.reached &&
    p.daysLeft > 0 &&
    g.instrumentKeys.length > 0 &&
    !g.instrumentKeys.some((k) =>
      suitableForGoalBuy(instruments.find((i) => i.key === k), g, today),
    );
  const hasSource = g.instrumentKeys.length > 0 || (g.reserves?.length ?? 0) > 0;
  const couponIds = g.couponIds ?? [];

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="priv font-medium">{g.name}</span>
            <Badge tone={status.tone}>{status.text}</Badge>
          </div>
          <div className="text-xs text-[var(--color-muted)]">
            Cél: <span className="amt">{formatMoney(g.targetHuf)}</span> · {formatDate(g.targetDate)}
            {p.daysLeft > 0 ? ` · ${p.monthsLeft} hónap` : " · lejárt"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
            onClick={onSchedule}
            title="Ütemterv: grafikon és tervezett összegek"
            aria-label="Ütemterv"
          >
            <ChartLine className="h-4 w-4" />
          </button>
          <button
            className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
            onClick={() => onEdit("basic")}
            title="Cél szerkesztése"
            aria-label="Cél szerkesztése"
          >
            <Pencil className="h-4 w-4" />
          </button>
          {confirmingClose ? (
            <span className="flex items-center gap-1 text-xs">
              <button className="text-[var(--color-brand)] underline" onClick={() => onClose(g.id)}>
                Lezárás
              </button>
              <button className="text-[var(--color-muted)] underline" onClick={() => setConfirmingClose(false)}>
                Mégse
              </button>
            </span>
          ) : (
            <button
              className="text-[var(--color-muted)] hover:text-[var(--color-positive)]"
              onClick={() => setConfirmingClose(true)}
              title="Cél lezárása (teljesült vagy elengedted)"
              aria-label="Cél lezárása"
            >
              <CircleCheck className="h-4 w-4" />
            </button>
          )}
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

      {/* Segmented bar */}
      <div className="relative mt-3 flex h-2.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
        <span className="bg-[var(--color-brand)]" style={{ width: seg(papers) }} title="Hozzárendelt papírok" />
        <span className="bg-[var(--color-positive)]" style={{ width: seg(p.autoCashHuf) }} title="Automatikusan beszámított pénz (lejárt papír, kupon)" />
        <span className="bg-[var(--color-chart-alt,#a5b4fc)]" style={{ width: seg(p.reservedHuf) }} title="Félretett készpénz" />
        <span className="bg-[var(--color-brand)]/30" style={{ width: seg(p.couponsHuf) }} title="Még érkező kuponok" />
        {overshoot && (
          <span
            className="absolute inset-y-0 right-0 bg-[var(--color-positive)]/30"
            style={{ width: `${100 - (p.targetHuf / scale) * 100}%` }}
            title="A cél feletti rész"
          />
        )}
      </div>
      <div className="relative h-2">
        <span
          className="absolute -top-1 h-2.5 w-px bg-[var(--color-text)]"
          style={{ left: targetAt }}
          title="Célösszeg"
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-muted)]">
        <Dot c="var(--color-brand)" l="papírok" />
        {p.autoCashHuf >= 1 && <Dot c="var(--color-positive)" l="automatikus pénz" />}
        {p.reservedHuf >= 1 && <Dot c="var(--color-chart-alt,#a5b4fc)" l="félretéve" />}
        {p.couponsHuf >= 1 && <Dot c="color-mix(in srgb, var(--color-brand) 30%, transparent)" l="várható kupon" />}
      </div>

      {/* Three numbers */}
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <Num
          label="Most a célra"
          title="Ami most a célra számít: a hozzárendelt eszközök (állampapír/DKJ névértéken, ha a céldátumig lejár; egyébként a céldátumra várható értéken), a lejárt papír kifizetése, a tartási időszak kamata és a félretett készpénz."
          value={formatMoney(p.assignedValueHuf)}
          sub={`${Math.round(p.progressPct * 100)}%`}
        />
        <Num
          label="Céldátumra várható"
          value={formatMoney(p.projectedHuf)}
          sub={`${Math.round(p.projectedPct * 100)}%`}
        />
        {p.reached ? (
          <Num
            label="Többlet"
            tone="positive"
            title="Amennyit a hozzárendelt eszközök, a jóváírt pénz és a kijelölt kuponok a célon felül hoznak a céldátumra: a cél kifizetése után szabad pénz."
            value={p.surplusHuf > 1 ? `+${formatMoney(p.surplusHuf)}` : formatMoney(0)}
            sub={p.surplusHuf > 1 ? "szabad lesz" : "pont fedezi"}
          />
        ) : (
          <Num label="Hiány" tone="warning" value={formatMoney(p.gapHuf)} sub="a céldátumra" />
        )}
      </div>
      {p.reached && p.unneededCouponsHuf > 1 && (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          A „minden szabad kupon” beállításból{" "}
          <span className="amt">{formatMoney(p.unneededCouponsHuf)}</span> már nem kell ide — ez a
          kupon máshol (pl. más célnál vagy befektetésre) is felhasználható.
        </p>
      )}

      {/* The one thing to do */}
      <div className="mt-2 rounded-lg bg-[var(--color-surface-2)]/60 p-2 text-sm">
        {p.reached ? (
          <span className="text-[var(--color-positive)]">
            ✓ Nincs teendő: a cél a jelenlegi eszközökből (és a beszámított kamatokból) teljesül a
            céldátumra.
          </span>
        ) : p.daysLeft > 0 && p.savingStartsOn ? (
          <span>
            A havi félretétel {formatDate(p.savingStartsOn)}-tól indul: akkortól havi{" "}
            <span className="amt font-semibold text-[var(--color-brand)]">
              {formatMoney(p.plannedMonthlyHuf)}
            </span>{" "}
            (összesen <span className="amt">{formatMoney(p.gapHuf)}</span> hiányzik). Addig nincs
            havi teendő.
          </span>
        ) : p.daysLeft > 0 ? (
          <span>
            Havi{" "}
            <span className="amt font-semibold text-[var(--color-brand)]">
              {formatMoney(p.monthlyNeededHuf)}
            </span>{" "}
            félretétel kell
            {hasSource ? (
              planHuf > 1 ? (
                <>
                  . A {p.monthAdjective} keretből még{" "}
                  <span className="amt font-semibold">{formatMoney(planHuf)}</span> van hátra.
                </>
              ) : (
                <>. A {p.monthAdjective} keret teljesítve ✓</>
              )
            ) : (
              "."
            )}
          </span>
        ) : (
          <span className={WARN}>
            A céldátum elmúlt, még <span className="amt">{formatMoney(p.gapHuf)}</span> hiányzik.
          </span>
        )}
      </div>
      {noBuy && (
        <p className={`mt-1 text-xs ${WARN}`}>
          {g.instrumentKeys.every(
            (k) => g.unbuyableKeys?.includes(k) || instruments.find((i) => i.key === k)?.notBuyable,
          )
            ? "A hozzárendelt eszközök már nem vásárolhatók"
            : `A hozzárendelt eszközök a vétel után ${g.minDaysToMaturity ?? DEFAULT_MIN_DAYS_TO_MATURITY} napon belül vagy a céldátum után járnak le, vagy már nem vásárolhatók`}{" "}
          — tartsd készpénzben a céldátumig, és rögzítsd félretételként (pl. a kincstári pénzszámlán).
        </p>
      )}

      {/* What is set (click = change) */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {g.instrumentKeys.map((key) => (
          <Chip key={key} onClick={() => onEdit("cover")} title="Eszközök módosítása">
            <span className={`priv ${g.unbuyableKeys?.includes(key) ? "line-through opacity-60" : ""}`}>
              {nameOf(key)}
            </span>
          </Chip>
        ))}
        {g.instrumentKeys.length === 0 && (
          <Chip onClick={() => onEdit("cover")} title="Eszköz hozzárendelése" muted>
            + eszköz hozzárendelése
          </Chip>
        )}
        {g.includeCoupons ? (
          <Chip onClick={() => onEdit("cover")} title="Kuponok módosítása">
            <Coins className="h-3 w-3 text-[var(--color-brand)]" /> minden szabad kupon
            {p.couponsHuf - p.pickedCouponsHuf > 0 && (
              <span className="amt">(+{formatMoney(p.couponsHuf - p.pickedCouponsHuf)})</span>
            )}
          </Chip>
        ) : couponIds.length > 0 ? (
          <Chip onClick={() => onEdit("cover")} title="Kuponok módosítása">
            <Coins className="h-3 w-3 text-[var(--color-brand)]" /> {couponIds.length} kupon
            {p.pickedCouponsHuf > 0 && <span className="amt">(+{formatMoney(p.pickedCouponsHuf)})</span>}
          </Chip>
        ) : null}
        {g.saveFrom && (
          <Chip onClick={() => onEdit("basic")} title="Félretétel kezdete">
            <CalendarClock className="h-3 w-3" /> indul: {formatDate(g.saveFrom)}
          </Chip>
        )}
        {g.monthlyReminder && (
          <Chip onClick={() => onEdit("reminder")} title="Havi vásárlás-emlékeztető">
            <BellRing className="h-3 w-3" /> havi emlékeztető
          </Chip>
        )}
      </div>

      {/* Cash set aside */}
      {p.daysLeft > 0 && (
        <div className="mt-2">
          <button
            className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
            onClick={() => setShowReserves((v) => !v)}
            aria-expanded={showReserves || conflicts.length > 0}
          >
            <Wallet className="h-3.5 w-3.5 text-[var(--color-brand)]" />
            Félretett készpénz: <span className="amt">{formatMoney(p.reservedHuf)}</span>
            <span className="underline">{showReserves ? "elrejtés" : "Félretettem…"}</span>
            {conflicts.length > 0 && <span className={WARN}>· ellenőrzendő</span>}
            <InfoTip>
              Kézzel rögzített félretétel (pl. a kincstári pénzszámlán): a céldátumig a célba
              számít, és nem számít szabad készpénznek.
            </InfoTip>
          </button>
          {(showReserves || conflicts.length > 0) && (
            <GoalReserves progress={p} conflicts={conflicts} onChange={(patch) => onUpdate(g.id, patch)} />
          )}
        </div>
      )}
    </div>
  );
}

function Dot({ c, l }: { c: string; l: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ background: c }} />
      {l}
    </span>
  );
}

function Num({
  label,
  value,
  sub,
  title,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  title?: string;
  tone?: "positive" | "warning";
}) {
  const color =
    tone === "positive" ? "text-[var(--color-positive)]" : tone === "warning" ? WARN : "";
  return (
    <div title={title}>
      <div className="text-[var(--color-muted)]">{label}</div>
      <div className={`amt text-sm font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}

function Chip({
  children,
  onClick,
  title,
  muted,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition hover:bg-[var(--color-border)] ${
        muted
          ? "border border-dashed border-[var(--color-border)] text-[var(--color-muted)]"
          : "bg-[var(--color-surface-2)]"
      }`}
    >
      {children}
    </button>
  );
}
