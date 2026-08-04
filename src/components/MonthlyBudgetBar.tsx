import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PiggyBank, ArrowRight } from "lucide-react";
import {
  usePortfolio,
  usePortfolioSummary,
  useSavingsGoals,
} from "../lib/store";
import { computeSavingsProgress } from "../lib/savings";
import { detectRecurringSavings, loadForecastSettings } from "../lib/forecast";
import { PREFS_EVENT } from "../lib/prefs";
import { Card } from "./ui";
import { formatMoney } from "../lib/format";

/**
 * "Havi keret" summary strip on the Goals page: the monthly saving (same
 * source as the Forecast page — manual override, else detected), how much of
 * it the goals below already commit (DCA goals' monthly equivalent + the
 * medium-term goals' required monthly saving), and what remains free. Pure
 * display — it changes no calculation, it only makes the relationship between
 * the three "monthly amount" concepts visible in one place.
 */
export default function MonthlyBudgetBar() {
  const summary = usePortfolioSummary();
  const accounts = usePortfolio((s) => s.accounts);
  const transactions = usePortfolio((s) => s.transactions);
  const instruments = usePortfolio((s) => s.instruments);
  const prices = usePortfolio((s) => s.prices);
  const fx = usePortfolio((s) => s.fx);
  const dcaGoals = usePortfolio((s) => s.goals);
  const savingsGoals = useSavingsGoals();

  // Re-read the forecast settings when any pref changes (e.g. a sync pull
  // brings a new monthly override from another device).
  const [prefsBump, setPrefsBump] = useState(0);
  useEffect(() => {
    const on = () => setPrefsBump((n) => n + 1);
    window.addEventListener(PREFS_EVENT, on);
    return () => window.removeEventListener(PREFS_EVENT, on);
  }, []);

  // Same monthly saving as the Forecast page and the allocation card.
  const budget = useMemo(() => {
    void prefsBump;
    const fs = loadForecastSettings();
    const det = detectRecurringSavings(transactions, fx);
    return Math.round(fs.monthlySavingOverride ?? det.monthlyHuf);
  }, [transactions, fx, prefsBump]);

  // DCA goals as monthly equivalents (a quarterly 300k goal is 100k/month).
  const dcaMonthly = useMemo(
    () =>
      Math.round(
        dcaGoals.reduce((s, g) => s + g.amountHuf / g.periodMonths, 0),
      ),
    [dcaGoals],
  );

  // Medium-term goals: the required monthly saving of every goal still ahead.
  const savingsMonthly = useMemo(() => {
    const map = new Map(instruments.map((i) => [i.key, i]));
    const progress = computeSavingsProgress(
      savingsGoals,
      accounts,
      transactions,
      map,
      prices,
      fx,
    );
    return Math.round(
      progress.reduce(
        (s, p) => s + (p.daysLeft > 0 && !p.reached ? p.monthlyNeededHuf : 0),
        0,
      ),
    );
  }, [savingsGoals, accounts, transactions, instruments, prices, fx]);

  void summary; // subscribes the strip to portfolio changes like the cards below

  const committed = dcaMonthly + savingsMonthly;
  const free = budget - committed;
  const over = budget > 0 && free < 0;
  const pct = (n: number) =>
    budget > 0 ? Math.max(0, Math.min(100, (n / budget) * 100)) : 0;

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
          <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
            <div
              className="h-full bg-[var(--color-brand)]"
              style={{ width: `${pct(savingsMonthly)}%` }}
              title="Középtávú célok havi igénye"
            />
            <div
              className="h-full bg-[var(--color-accent,#22d3ee)]"
              style={{ width: `${pct(dcaMonthly)}%` }}
              title="Rendszeres (DCA) célok havi összege"
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
            {savingsMonthly > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[var(--color-brand)]" />
                Középtávú célok{" "}
                <span className="amt tabular-nums">
                  {formatMoney(savingsMonthly)}
                </span>
              </span>
            )}
            {dcaMonthly > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[var(--color-accent,#22d3ee)]" />
                DCA célok{" "}
                <span className="amt tabular-nums">
                  {formatMoney(dcaMonthly)}
                </span>
              </span>
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
                  Túllépés: <span className="amt">{formatMoney(-free)}</span> —
                  a célok többet kívánnak, mint a havi keret
                </>
              ) : (
                <>
                  Szabad: <span className="amt">{formatMoney(free)}</span>
                </>
              )}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}
