// The AI's portfolio snapshot from plain data (no React hooks), so the app's
// AI page and the nightly analysis job (scripts/notify/analysis/) send the
// model exactly the same picture.

import type { Account, Instrument, Transaction } from "./model";
import {
  computeReturns,
  consolidatedHoldings,
  futureBondCashflows,
  isInternalTransfer,
  toHuf,
  toLocalDay,
  type DayChange,
  type PortfolioSummary,
  type PriceMap,
  type ValuePoint,
} from "./portfolio";
import { buildAiPortfolioContext } from "./ai";
import { bondAdvice, bondMarket } from "./bondSwitch";
import type { BondRatesFile } from "./bondRates";
import { upcomingEvents } from "./events";
import { tbszStatus } from "./tbsz";
import {
  computeSavingsProgress,
  savingsGoalExpenses,
  type SavingsGoal,
} from "./savings";
import { effectiveMonthKey, type GoalProgress } from "./goals";
import { forecastMilestones, projectFromSettings } from "./forecast";
import type { Alert } from "./alerts";
import type { AllocationState } from "./rebalance";
import { txDay } from "./day";

export interface AiContextInput {
  summary: PortfolioSummary;
  accounts: Account[];
  transactions: Transaction[];
  instruments: Instrument[];
  prices: PriceMap;
  fx: Record<string, number>;
  historyFile: Parameters<typeof computeReturns>[5];
  bondRates: BondRatesFile | null;
  series: ValuePoint[];
  dayChange: DayChange | null;
  goals: GoalProgress[];
  alerts: Alert[];
  savingsGoals: SavingsGoal[];
  glide: AllocationState | null;
  now?: Date;
}

export function buildFullAiContext(i: AiContextInput): string {
  const now = i.now ?? new Date();
  const { summary, transactions, fx } = i;
  const instMap = new Map(i.instruments.map((x) => [x.key, x]));
  const returns = computeReturns(
    i.accounts,
    transactions,
    instMap,
    i.prices,
    fx,
    i.historyFile,
    now,
  );
  const savingsProgress = computeSavingsProgress(
    i.savingsGoals,
    i.accounts,
    transactions,
    instMap,
    i.prices,
    fx,
  );
  const goalExpenses = savingsGoalExpenses(i.savingsGoals, savingsProgress);
  const { assumptions, result } = projectFromSettings(
    summary,
    transactions,
    fx,
    goalExpenses,
    {},
    now,
  );
  const cashflows = futureBondCashflows(summary, now, transactions);
  const today = toLocalDay(now);
  const bonds = {
    advice: bondAdvice(consolidatedHoldings(summary), i.bondRates, today, i.savingsGoals),
    market: bondMarket(i.bondRates, today),
  };
  // The effective month: payday deposits count toward the next month.
  const monthKey = effectiveMonthKey(now);
  const yearAgo = new Date(now);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const yearAgoIso = toLocalDay(yearAgo);
  const inYear = new Date(now);
  inYear.setFullYear(inYear.getFullYear() + 1);
  const inYearIso = toLocalDay(inYear);
  let thisMonthNet = 0;
  let last12 = 0;
  for (const t of transactions) {
    if (t.internal || isInternalTransfer(t)) continue;
    const huf = toHuf(Math.abs(t.grossAmount ?? t.netAmount ?? 0), t.currency, fx);
    if (effectiveMonthKey(t.date) === monthKey) {
      if (t.type === "deposit") thisMonthNet += huf;
      if (t.type === "withdrawal") thisMonthNet -= huf;
    }
    if ((t.type === "interest" || t.type === "dividend") && txDay(t.date) >= yearAgoIso)
      last12 += huf;
  }
  const next12 = cashflows.filter((c) => txDay(c.date) < inYearIso);
  return buildAiPortfolioContext(summary, fx, returns, {
    dayChange: i.dayChange,
    series: i.series,
    goals: i.goals,
    alerts: i.alerts,
    events: upcomingEvents(summary, now, transactions),
    // Every TBSZ account on its own (two can share a vintage), oldest first.
    tbsz: summary.accounts
      .filter(
        (a) =>
          a.account.kind === "tbsz" &&
          a.account.tbszYear &&
          Math.abs(a.totalValueHuf) >= 1,
      )
      .sort((a, b) => a.account.tbszYear! - b.account.tbszYear!)
      .map((a) => ({
        name: a.account.name,
        status: tbszStatus(a.account.tbszYear!, now),
        grossHuf: a.totalValueHuf,
        gainHuf: a.totalValueHuf - a.capitalBasisHuf,
      })),
    savings: savingsProgress,
    forecast: {
      monthlySavingHuf: assumptions.monthlySavingHuf,
      milestones: forecastMilestones(result)
        .filter((m) => [1, 5, 10].includes(m.years))
        .map((m) => ({
          years: m.years,
          real: m.point.real,
          pess: m.point.pess,
          opt: m.point.opt,
        })),
      shortfall: result.shortfall.real ?? result.shortfall.pess,
    },
    glide: i.glide,
    bonds,
    budget: {
      monthlyHuf: assumptions.monthlySavingHuf,
      thisMonthNetHuf: thisMonthNet,
    },
    passive: {
      last12Huf: last12,
      next12CouponHuf: next12
        .filter((c) => c.kind === "coupon")
        .reduce((s, c) => s + c.amountHuf, 0),
      next12MaturityHuf: next12
        .filter((c) => c.kind === "maturity")
        .reduce((s, c) => s + c.amountHuf, 0),
    },
  });
}
