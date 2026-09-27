// The monthly plan ("Havi terv"): one split of this month's saving across
// every goal, in a user-settable order —
//  1. medium-term (dated) goals: this month's quota, into the goal's own
//     instrument (the maturity filter applies; with none left: hold cash);
//  2. DCA goals: this month's part, into the goal's instrument;
//  3. the glide path: whatever is left, routed like any incoming money.
// Money runs out in order: an earlier item is filled completely, a later one
// gets the rest, and every item left short says by how much. What a goal has
// already received this month is not planned again.
// With an AccountContext every buy gets its account (the instrument's account
// for new buys on the day, see accountRules): a buy into an account that takes
// no deposits is not planned — its money moves on in the order — and the plan
// sums up how much to send to each account.
// Pure: the Teendők panel, the goal cards and the Telegram bot all read it.

import type { Account, Instrument, Transaction } from "./model";
import {
  savingsMonthStates,
  type SavingsGoal,
  type SavingsMonthlyStatus,
} from "./savings";
import { computeGoalProgress, type Goal, type GoalProgress } from "./goals";
import type { PriceMap } from "./portfolio";
import { instrumentTypeLabel } from "./labels";
import { formatMoney } from "./format";
import {
  DEFAULT_QTY_DECIMALS,
  isActive,
  type GlideConfig,
  type InstrumentRule,
} from "./glidePath";
import {
  costFor,
  estimateCost,
  formatQuantity,
  planCashflow,
  suggestionText,
  type AllocationState,
  type FlowTargets,
  type Position,
  type RebalancePlan,
} from "./rebalance";
import { BOND_TYPES } from "./bonds";
import {
  blockedText,
  feeOf,
  purchaseVenue,
  upcomingVenueChange,
  type AccountContext,
  type Venue,
} from "./accountRules";

export type PlanItemKind = "savings" | "dca";

/** One goal's claim on this month's saving. */
export interface PlanNeed {
  /** `savings:<id>` / `dca:<id>` — what the user's order refers to. */
  key: string;
  kind: PlanItemKind;
  /** Goal name ("Babaváró", "WBIT (havi DCA)"). */
  name: string;
  /** Still owed this month (HUF). */
  needHuf: number;
  /** Already covered this month (HUF) — left out of the default amount. */
  doneHuf: number;
  /** The instrument to buy; undefined = hold cash or a category goal. */
  instrumentKey?: string;
  /** Display name of where the money goes. */
  target: string;
  /** Keep the money in cash until the goal's date (nothing buyable). */
  holdCash: boolean;
}

/** The claims of every goal, in the default order: dated goals by date, then DCA. */
export function planNeeds(
  savings: SavingsMonthlyStatus[],
  savingsDates: Map<string, string>,
  dca: GoalProgress[],
  instruments: Map<string, Instrument>,
): PlanNeed[] {
  const dated = [...savings]
    .sort((a, b) =>
      (savingsDates.get(a.goalId) ?? "").localeCompare(savingsDates.get(b.goalId) ?? ""),
    )
    .map((s): PlanNeed => ({
      key: `savings:${s.goalId}`,
      kind: "savings",
      name: s.name,
      needHuf: s.planHuf,
      // What this month's saving already put in (the coupon share aside).
      doneHuf: Math.min(s.baseNeededHuf, Math.max(0, s.boughtHuf - s.couponHuf)),
      instrumentKey: s.buyKey,
      target: s.buyKey
        ? (instruments.get(s.buyKey)?.name ?? s.buyKey)
        : "készpénz a céldátumig",
      holdCash: s.holdCash,
    }));
  const recurring = [...dca]
    .sort((a, b) => a.goal.createdAt.localeCompare(b.goal.createdAt))
    .map((p): PlanNeed => ({
      key: `dca:${p.goal.id}`,
      kind: "dca",
      name: `${p.instrumentName} (DCA)`,
      needHuf: p.monthPartHuf,
      doneHuf: Math.min(
        p.investedThisMonthHuf,
        p.goal.amountHuf / p.goal.periodMonths,
      ),
      instrumentKey: p.goal.instrumentKey,
      target: p.goal.instrumentType
        ? `bármely ${instrumentTypeLabel[p.goal.instrumentType]}`
        : p.instrumentName,
      holdCash: false,
    }));
  return [...dated, ...recurring];
}

/**
 * Every goal's claim this month, in the user's order — the one entry point the
 * app and the Telegram bot share, so both plan the same amounts.
 */
export function computePlanNeeds(a: {
  savingsGoals: SavingsGoal[];
  dcaGoals: Goal[];
  accounts: Account[];
  transactions: Transaction[];
  instruments: Instrument[];
  prices: PriceMap;
  fx: Record<string, number>;
  order: string[];
  now?: Date;
}): PlanNeed[] {
  const map = new Map(a.instruments.map((i) => [i.key, i]));
  const now = a.now ?? new Date();
  return orderNeeds(
    planNeeds(
      savingsMonthStates(a.savingsGoals, a.accounts, a.transactions, map, a.prices, a.fx, now),
      new Map(a.savingsGoals.map((g) => [g.id, g.targetDate])),
      computeGoalProgress(a.dcaGoals, a.transactions, a.instruments, a.fx, now),
      map,
    ),
    a.order,
  );
}

/** `needs` in the user's order; items it doesn't list keep their default place after. */
export function orderNeeds(needs: PlanNeed[], order: string[]): PlanNeed[] {
  const rank = new Map(order.map((k, i) => [k, i]));
  const listed = needs
    .filter((n) => rank.has(n.key))
    .sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...listed, ...needs.filter((n) => !rank.has(n.key))];
}

/** Move `key` one step up (-1) or down (+1) in the plan order; returns the new order. */
export function moveInOrder(needs: PlanNeed[], key: string, dir: -1 | 1): string[] {
  const keys = needs.map((n) => n.key);
  const i = keys.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return keys;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  return keys;
}

/** The default amount: the monthly budget minus what goals already got this month. */
export function defaultPlanAmount(budgetHuf: number, needs: PlanNeed[]): number {
  const done = needs.reduce((s, n) => s + n.doneHuf, 0);
  return Math.max(0, Math.round(budgetHuf - done));
}

export interface PlanTrade {
  /** HUF of the instrument bought (whole units / its decimals). */
  amountHuf: number;
  /** Units; undefined when the price is unknown. */
  quantity?: number;
  costHuf: number;
  /** Currency conversion of the HUF deposit into the instrument's currency. */
  fxCostHuf?: number;
}

export interface PlanLine {
  need: PlanNeed;
  /** Money the plan gives the item (HUF). */
  allocatedHuf: number;
  /** need − allocated: how much the item was left short (0 = fully covered). */
  shortHuf: number;
  /** The buy (none for a hold-cash item, a category goal or 0 allocated). */
  trade?: PlanTrade;
  /** Where the buy goes (account-aware plans). */
  venue?: Venue;
  /** Not bought: the account takes no deposits (the money moved on). */
  blocked?: boolean;
  /** A scheduled change of the account within ~2 months. */
  upcoming?: { from: string; label: string };
}

/** Money to send to one account this month (buys + their costs). */
export interface PlanDeposit {
  label: string;
  accountId?: string;
  /** The account isn't in the ledger yet — open it first. */
  pending: boolean;
  amountHuf: number;
  costHuf: number;
  fxCostHuf: number;
  totalHuf: number;
}

export interface MonthlyPlan {
  amountHuf: number;
  lines: PlanLine[];
  /** What the glide path gets (after the goals, capped by its monthly amount). */
  glideHuf: number;
  glidePlan: (RebalancePlan & { flow: FlowTargets }) | null;
  /** Left over and not planned (the glide path's fixed / % amount was smaller). */
  freeHuf: number;
  /** Σ shortfall of the goals left short. */
  shortHuf: number;
  /** Per account: what to send there (empty without an AccountContext). */
  deposits: PlanDeposit[];
}

export interface PlanInput {
  amountHuf: number;
  /** In plan order (see orderNeeds). */
  needs: PlanNeed[];
  /** The glide path version in force and today's state (null = off). */
  glide: GlideConfig | undefined;
  state: AllocationState | null;
  /** The monthly budget — the base of a "% of the budget" glide amount. */
  budgetHuf: number;
  /** Every held position at MARKET value (prices, brokers) — see positionsFromSummary. */
  positions: Position[];
  instruments: Map<string, Instrument>;
  /** Accounts, limits and the accounts for new buys (omitted: not account-aware). */
  accounts?: AccountContext;
}

/** Quantity rounding for a goal's instrument: the glide rule's, else fractional ETFs, whole bonds. */
function decimalsFor(rule: InstrumentRule | undefined, inst: Instrument | undefined): number {
  if (rule) return rule.fractional ? Math.min(8, Math.max(0, Math.round(rule.qtyDecimals ?? DEFAULT_QTY_DECIMALS))) : 0;
  return inst && BOND_TYPES.has(inst.type) ? 0 : DEFAULT_QTY_DECIMALS;
}

/** The buy of `moneyHuf` into `key`: cost per costFor, taken out of the money unless "extra". */
export function planBuy(
  key: string,
  moneyHuf: number,
  glide: GlideConfig | undefined,
  positions: Position[],
  instruments: Map<string, Instrument>,
  /** Currency conversion on the way in (fraction; taken out like the cost). */
  fxPct = 0,
): PlanTrade {
  const rule = glide?.instruments[key];
  const pos: Position = positions.find((p) => p.key === key) ?? {
    key,
    name: instruments.get(key)?.name ?? key,
    valueHuf: 0,
  };
  const cost = costFor(glide, { ...pos, rule }, "buy");
  const included = glide?.buyCostMode !== "extra";
  let target = moneyHuf;
  if (included)
    target = Math.max(0, (moneyHuf - (cost?.fixedHuf ?? 0)) / (1 + (cost?.pct ?? 0) + fxPct));
  let amount = target;
  let quantity: number | undefined;
  if (pos.unitPriceHuf && pos.unitPriceHuf > 0) {
    const f = 10 ** decimalsFor(rule, instruments.get(key));
    quantity = Math.floor((target / pos.unitPriceHuf) * f + 1e-9) / f;
    amount = quantity * pos.unitPriceHuf;
  }
  return {
    amountHuf: amount,
    quantity,
    costHuf: estimateCost(cost, amount),
    fxCostHuf: fxPct > 0 ? amount * fxPct : undefined,
  };
}

/**
 * Conversion rate of a HUF deposit into `key` at its venue: the venue
 * broker's fxPct when the instrument trades in another currency.
 */
export function depositFxPct(
  ctx: AccountContext,
  key: string,
  venue: Venue,
  instruments: Map<string, Instrument>,
): number {
  const ccy = instruments.get(key)?.currency ?? ctx.currency.get(key) ?? "HUF";
  return ccy === "HUF" ? 0 : (feeOf(ctx, venue.provider)?.fxPct ?? 0);
}

/** The glide path's share of what the goals left: its monthly amount, at most. */
function glideShare(glide: GlideConfig, left: number, budgetHuf: number): number {
  const spec = glide.monthlyAmount;
  if (!spec || spec.kind === "remainder") return left;
  const cap =
    spec.kind === "fixed" ? spec.huf : Math.max(0, budgetHuf) * spec.pct;
  return Math.max(0, Math.min(left, Math.round(cap)));
}

export function buildMonthlyPlan(input: PlanInput): MonthlyPlan {
  const { glide, state, positions, instruments } = input;
  const ctx = input.accounts;
  const venues = new Map<string, Venue>();
  const venueOf = (key: string) => {
    if (!ctx) return undefined;
    let v = venues.get(key);
    if (!v) venues.set(key, (v = purchaseVenue(ctx, key)));
    return v;
  };
  const fxOf = (key: string) => {
    const v = venueOf(key);
    return ctx && v ? depositFxPct(ctx, key, v, instruments) : 0;
  };
  let left = Math.max(0, input.amountHuf);
  const lines: PlanLine[] = [];
  for (const need of input.needs) {
    const key = need.holdCash ? undefined : need.instrumentKey;
    const venue = key ? venueOf(key) : undefined;
    const upcoming = ctx && key ? upcomingVenueChange(ctx, key) : undefined;
    if (venue?.depositBlocked && need.needHuf >= 1) {
      // Nothing can go in there: the item is left short, the money moves on.
      lines.push({ need, allocatedHuf: 0, shortHuf: need.needHuf, venue, blocked: true, upcoming });
      continue;
    }
    const give = Math.min(left, Math.max(0, need.needHuf));
    left -= give;
    const line: PlanLine = {
      need,
      allocatedHuf: give,
      shortHuf: Math.max(0, need.needHuf - give),
      venue,
      upcoming,
    };
    if (give >= 1 && key)
      line.trade = planBuy(key, give, glide, positions, instruments, fxOf(key));
    lines.push(line);
  }
  let glideHuf = 0;
  let glidePlan: MonthlyPlan["glidePlan"] = null;
  if (isActive(glide) && state && left >= 1) {
    glideHuf = glideShare(glide, left, input.budgetHuf);
    if (glideHuf >= 1) {
      glidePlan = planCashflow(
        glide,
        state,
        glideHuf,
        ctx ? { canBuy: (k) => !venueOf(k)!.depositBlocked, fxPct: fxOf } : {},
      );
      if (ctx) {
        for (const s of glidePlan.suggestions) {
          const v = s.instrumentKey ? venueOf(s.instrumentKey) : undefined;
          if (v?.account) s.accountId = v.account.id;
          if (v) s.accountLabel = v.label;
        }
        for (const p of state.positions)
          if (p.rule.acceptsContributions && venueOf(p.key)!.depositBlocked)
            glidePlan.notes.push(
              `${p.name}: nem vehető — ${blockedText(venueOf(p.key)!)}; állíts be új vételi számlát.`,
            );
      }
    }
  }
  return {
    amountHuf: Math.max(0, input.amountHuf),
    lines,
    glideHuf,
    glidePlan,
    freeHuf: left - glideHuf,
    shortHuf: lines.reduce((s, l) => s + l.shortHuf, 0),
    deposits: ctx
      ? planDeposits(lines, glidePlan, (k) => venueOf(k))
      : [],
  };
}

/** What to send to each account: the buys plus their costs, by venue. */
function planDeposits(
  lines: PlanLine[],
  glidePlan: MonthlyPlan["glidePlan"],
  venueOf: (key: string) => Venue | undefined,
): PlanDeposit[] {
  const by = new Map<string, PlanDeposit>();
  const add = (v: Venue | undefined, amount: number, cost: number, fx: number) => {
    const label = v?.label ?? "ismeretlen számla";
    const d: PlanDeposit = by.get(label) ?? {
      label,
      accountId: v?.account?.id,
      pending: !!v?.pending,
      amountHuf: 0,
      costHuf: 0,
      fxCostHuf: 0,
      totalHuf: 0,
    };
    d.amountHuf += amount;
    d.costHuf += cost;
    d.fxCostHuf += fx;
    d.totalHuf += amount + cost + fx;
    by.set(label, d);
  };
  for (const l of lines)
    if (l.trade) add(l.venue, l.trade.amountHuf, l.trade.costHuf, l.trade.fxCostHuf ?? 0);
  for (const s of glidePlan?.suggestions ?? [])
    if (s.status === "ok" && s.side === "buy" && s.instrumentKey)
      add(venueOf(s.instrumentKey), s.amountHuf, s.costHuf, s.fxCostHuf ?? 0);
  return [...by.values()].sort((a, b) => b.totalHuf - a.totalHuf);
}

// ---- Text (reminder detail, Telegram) --------------------------------------

/** "Babaváró: DKJ D261028 206 667 Ft (210 db, díj 0 Ft)" / "… tartsd készpénzben". */
export function planLineText(l: PlanLine): string {
  const n = l.need;
  const short = l.shortHuf >= 1 ? ` — alul maradt: −${formatMoney(l.shortHuf)}` : "";
  if (n.needHuf < 1) return `${n.name}: e havi rész teljesítve ✓`;
  if (l.blocked && l.venue)
    return `${n.name}: nem vehető — ${blockedText(l.venue)}; állíts be új vételi számlát${short}${upcomingText(l)}`;
  if (l.allocatedHuf < 1) return `${n.name}: nem jut rá pénz${short}`;
  if (n.holdCash)
    return `${n.name}: tartsd készpénzben a céldátumig ${formatMoney(l.allocatedHuf)}${short}`;
  if (!l.trade) return `${n.name}: ${n.target} vétel ${formatMoney(l.allocatedHuf)}${short}`;
  const qty = l.trade.quantity != null ? `${formatQuantity(l.trade.quantity)} db, ` : "";
  const fx = l.trade.fxCostHuf ? `, váltás ${formatMoney(l.trade.fxCostHuf)}` : "";
  return `${n.name}: ${n.target} vétel ${formatMoney(l.trade.amountHuf)} (${qty}díj ${formatMoney(l.trade.costHuf)}${fx})${venueText(l)}${short}${upcomingText(l)}`;
}

/** " → Lightyear TBSZ 2026" (+ a warning when it isn't in the ledger yet). */
function venueText(l: PlanLine): string {
  const v = l.venue;
  if (!v || v.source === "none") return "";
  return ` → ${v.label}${v.pending ? " (még nincs a nyilvántartásban — nyisd meg)" : ""}`;
}

function upcomingText(l: PlanLine): string {
  return l.upcoming ? ` · ${l.upcoming.from}-tól: ${l.upcoming.label}` : "";
}

/** Every line of the plan, the glide path's buys and the leftover included. */
export function planTextLines(p: MonthlyPlan): string[] {
  const out = p.lines.map(planLineText);
  if (p.glidePlan) {
    const steps = p.glidePlan.suggestions.filter((s) => s.status === "ok");
    out.push(
      `Célpálya (${formatMoney(p.glideHuf)}, célpont: ${p.glidePlan.flow.label}): ${
        steps.length ? steps.map(suggestionText).join("; ") : "nincs javasolt vétel"
      }`,
    );
  } else if (p.lines.length && p.freeHuf < 1 && p.glideHuf < 1) {
    out.push("Célpálya: a célok után nem marad rá pénz");
  }
  if (p.freeHuf >= 1) out.push(`Szabad maradék: ${formatMoney(p.freeHuf)}`);
  if (p.deposits.length)
    out.push(`Befizetések: ${p.deposits.map(depositText).join("; ")}`);
  return out;
}

/** "Lightyear TBSZ 2026: 150 000 Ft (váltás 525 Ft)". */
export function depositText(d: PlanDeposit): string {
  const fx = d.fxCostHuf >= 1 ? ` (ebből váltás ${formatMoney(d.fxCostHuf)})` : "";
  return `${d.label}${d.pending ? " (még nincs — nyisd meg)" : ""}: ${formatMoney(d.totalHuf)}${fx}`;
}
