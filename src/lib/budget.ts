// The monthly budget ("havi keret") split between the goals: the medium-term
// goals' required monthly saving, the DCA goals' monthly equivalent and the
// glide path's own monthly amount — plus what is left free or overspent.
// Pure: the budget bar, the Teendők panel and the bot all read the same split.

import type { Goal } from "./goals";
import type { SavingsProgress } from "./savings";
import { formatMoney } from "./format";
import { isActive, type GlideConfig, type MonthlyAmount } from "./glidePath";

/** How the glide path's amount was set; "legacy" = no setting (whole budget). */
export type GlideAmountMode = MonthlyAmount["kind"] | "legacy";

export interface BudgetBreakdown {
  budgetHuf: number;
  /** Medium-term goals' required monthly saving (goals still ahead). */
  savingsHuf: number;
  /** DCA goals as monthly equivalents. */
  dcaHuf: number;
  /** The glide path's monthly amount (0 when the glide path is off). */
  glideHuf: number;
  /** null when the glide path is off. */
  glideMode: GlideAmountMode | null;
  /** savings + DCA + glide path. */
  committedHuf: number;
  /** budget − committed, at least 0. */
  freeHuf: number;
  /** committed − budget, at least 0. */
  overHuf: number;
}

/** DCA goals as monthly equivalents (a quarterly 300k goal is 100k/month). */
export function dcaMonthlyHuf(goals: Goal[]): number {
  return Math.round(goals.reduce((s, g) => s + g.amountHuf / g.periodMonths, 0));
}

/** The required monthly saving of every medium-term goal still ahead. */
export function savingsMonthlyHuf(progress: SavingsProgress[]): number {
  return Math.round(
    progress.reduce(
      (s, p) => s + (p.daysLeft > 0 && !p.reached ? p.monthlyNeededHuf : 0),
      0,
    ),
  );
}

/**
 * The glide path's monthly amount under `spec` (undefined = legacy: the whole
 * budget). `otherHuf` is what the DCA and medium-term goals already take —
 * the remainder mode gets what's left of the budget, never below 0.
 */
export function glideMonthlyHuf(
  spec: MonthlyAmount | undefined,
  budgetHuf: number,
  otherHuf: number,
): number {
  const budget = Math.max(0, budgetHuf);
  if (!spec) return budget;
  switch (spec.kind) {
    case "fixed":
      return Math.max(0, Math.round(spec.huf));
    case "pct":
      return Math.max(0, Math.round(budget * spec.pct));
    case "remainder":
      return Math.max(0, budget - otherHuf);
  }
}

export function budgetBreakdown(input: {
  budgetHuf: number;
  dcaHuf: number;
  savingsHuf: number;
  /** The glide-path version in force (the one the Teendők panel uses). */
  glide: GlideConfig | undefined;
}): BudgetBreakdown {
  const { budgetHuf, dcaHuf, savingsHuf, glide } = input;
  const other = dcaHuf + savingsHuf;
  const on = isActive(glide);
  const glideHuf = on ? glideMonthlyHuf(glide.monthlyAmount, budgetHuf, other) : 0;
  const committedHuf = other + glideHuf;
  return {
    budgetHuf,
    savingsHuf,
    dcaHuf,
    glideHuf,
    glideMode: on ? (glide.monthlyAmount?.kind ?? "legacy") : null,
    committedHuf,
    freeHuf: Math.max(0, budgetHuf - committedHuf),
    overHuf: Math.max(0, committedHuf - budgetHuf),
  };
}

/** Short label of the mode ("fix", "a keret 20%-a", …). */
export function glideModeLabel(
  mode: GlideAmountMode,
  spec?: MonthlyAmount,
): string {
  switch (mode) {
    case "fixed":
      return "fix";
    case "pct": {
      const p = spec?.kind === "pct" ? spec.pct : 0;
      return `a havi keret ${(p * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })}%-a`;
    }
    case "remainder":
      return "ami a többi cél után marad";
    case "legacy":
      return "a teljes havi keret — nincs beállítva, ütközhet a többi céllal";
  }
}

/** "Célpálya havi összege: 150 000 Ft — fix" (null when the glide path is off). */
export function glideAmountSource(
  b: BudgetBreakdown,
  glide: GlideConfig | undefined,
): string | null {
  if (b.glideMode == null) return null;
  return `Célpálya havi összege: ${formatMoney(b.glideHuf)} — ${glideModeLabel(b.glideMode, glide?.monthlyAmount)}`;
}

/**
 * Medium-term goals still ahead that earmark every bond coupon
 * (includeCoupons): a coupon routed along the glide path too would be spent
 * twice.
 */
export function couponClaimingGoals(progress: SavingsProgress[]): string[] {
  return progress
    .filter((p) => p.goal.includeCoupons && p.daysLeft > 0 && !p.reached)
    .map((p) => p.goal.name);
}
