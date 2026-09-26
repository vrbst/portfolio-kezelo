import { Link } from "react-router-dom";
import { PiggyBank, ArrowRight } from "lucide-react";
import { useMonthlyBudget } from "../lib/store";
import { glideModeLabel } from "../lib/budget";
import { Card } from "./ui";
import { formatMoney } from "../lib/format";

const SEGMENTS = [
  { key: "savingsHuf", label: "Középtávú célok", title: "Középtávú célok havi igénye", color: "var(--color-brand)" },
  { key: "dcaHuf", label: "DCA célok", title: "Rendszeres (DCA) célok havi összege", color: "var(--color-accent)" },
  { key: "glideHuf", label: "Célpálya", title: "A célpálya havi összege (Teendők: bejövő pénz elosztása)", color: "var(--color-brand-2)" },
] as const;

/**
 * "Havi keret" summary strip on the Goals page: the monthly saving (same
 * source as the Forecast page — manual override, else detected), how much of
 * it the goals commit (medium-term goals' required monthly saving, DCA goals'
 * monthly equivalent, the glide path's own monthly amount), and what remains
 * free — or how far the goals overshoot it.
 */
export default function MonthlyBudgetBar() {
  const { breakdown: b, glide } = useMonthlyBudget();
  const budget = b.budgetHuf;
  const over = budget > 0 && b.overHuf > 0;
  // Over budget: scale to the total commitment so every slice stays visible,
  // and mark where the budget ends.
  const scale = Math.max(budget, b.committedHuf);
  const pct = (n: number) =>
    scale > 0 ? Math.max(0, Math.min(100, (n / scale) * 100)) : 0;

  return (
    <Card className="mb-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <PiggyBank className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">Havi keret</h2>
          {budget > 0 && (
            <span className="amt text-lg font-semibold tabular-nums">
              {formatMoney(budget)}
            </span>
          )}
        </div>
        <Link
          to="/forecast"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-brand)] hover:underline"
        >
          Módosítás az Előrejelzésben <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      {budget <= 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Nincs felismert havi megtakarítás — add meg kézzel az Előrejelzés
          oldalon, és itt látszik majd, mennyit kötnek le belőle a célok.
        </p>
      ) : (
        <>
          <div className="relative mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
            {SEGMENTS.map((s) => (
              <div
                key={s.key}
                className="h-full"
                style={{ width: `${pct(b[s.key])}%`, background: s.color }}
                title={s.title}
              />
            ))}
            {over && (
              <div
                className="absolute inset-y-0 w-0.5 bg-[var(--color-negative)]"
                style={{ left: `${pct(budget)}%` }}
                title="A havi keret vége"
              />
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
            {SEGMENTS.map(
              (s) =>
                b[s.key] > 0 && (
                  <span key={s.key} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                    {s.label}{" "}
                    <span className="amt tabular-nums">{formatMoney(b[s.key])}</span>
                    {s.key === "glideHuf" && b.glideMode && b.glideMode !== "legacy" && (
                      <span>({glideModeLabel(b.glideMode, glide?.monthlyAmount)})</span>
                    )}
                  </span>
                ),
            )}
            <span
              className={`ml-auto tabular-nums ${
                over
                  ? "font-medium text-[var(--color-negative)]"
                  : "text-[var(--color-muted)]"
              }`}
            >
              {over ? (
                <>
                  Túllépés: <span className="amt">{formatMoney(b.overHuf)}</span> —
                  a célok többet kívánnak, mint a havi keret
                </>
              ) : (
                <>
                  Szabad: <span className="amt">{formatMoney(b.freeHuf)}</span>
                </>
              )}
            </span>
          </div>
          {b.glideMode === "legacy" && (
            <p className="mt-2 text-xs text-[var(--color-warning)]">
              A célpálya havi összege nincs beállítva, ezért a teljes havi
              keretet használja — ez ütközik a DCA és a középtávú célokkal.
              Állítsd be a Célpálya szerkesztőjében (fix összeg, a keret
              %-a, vagy ami a többi cél után marad).
            </p>
          )}
        </>
      )}
    </Card>
  );
}
