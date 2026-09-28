// Account rules for planning: per-account limits (money may not leave the
// account until a day — e.g. a TBSZ's lock-in; no deposits from a day — e.g. a
// TBSZ after its gyűjtőév) and, per instrument, a dated "account for new
// buys" schedule. Both are synced prefs (see planPrefs), set by the user.
//
// Pure: the monthly plan, the band rule and the Telegram bot resolve where a
// buy goes (the "venue") and what money may move through an AccountContext.

import type { Account, AccountKind, Provider, Transaction } from "./model";
import type { PortfolioSummary } from "./portfolio";
import { toHuf } from "./portfolio";
import { accountKindLabel, providerLabel } from "./labels";
import type { BrokerFee, BrokerFees } from "./planPrefs";
import type { Alert } from "./alerts";
import { freeCashOf } from "./savings";

export interface AccountLimit {
  /** Money may not leave the account up to and including this day. */
  noOutflowUntil?: string;
  noOutflowNote?: string;
  /** No deposits into the account from this day on. */
  noDepositFrom?: string;
  noDepositNote?: string;
}

/** Account id → its limits. */
export type AccountLimits = Record<string, AccountLimit>;

/**
 * An account not in the ledger yet (e.g. next year's TBSZ): bound to the
 * first account that matches provider + kind (+ TBSZ year) once imported.
 */
export interface PendingAccount {
  provider: Provider;
  kind: AccountKind;
  tbszYear?: number;
}

export type PurchaseTarget = { accountId: string } | { pending: PendingAccount };

export interface PurchaseEntry {
  /** In force from this day (YYYY-MM-DD) until the next entry's day. */
  from: string;
  target: PurchaseTarget;
}

/** Instrument key → its dated "account for new buys" schedule. */
export type PurchaseAccounts = Record<string, PurchaseEntry[]>;

// ---- Limits -----------------------------------------------------------------

/** Money may not leave `accountId` on `day`. */
export function outflowBlocked(limits: AccountLimits, accountId: string, day: string): boolean {
  const until = limits[accountId]?.noOutflowUntil;
  return !!until && day <= until;
}

/** `accountId` takes no deposits on `day`. */
export function depositBlocked(limits: AccountLimits, accountId: string, day: string): boolean {
  const from = limits[accountId]?.noDepositFrom;
  return !!from && day >= from;
}

/**
 * The TBSZ rule as a prefill (never saved on its own): deposits only in the
 * gyűjtőév, the money stays in until the end of the 5-year lock-in.
 */
export function tbszLimitSuggestion(account: Account): AccountLimit | null {
  if (account.kind !== "tbsz" || !account.tbszYear) return null;
  const y = account.tbszYear;
  return {
    noDepositFrom: `${y + 1}-01-01`,
    noDepositNote: `TBSZ: befizetés csak a ${y}-es gyűjtőévben`,
    noOutflowUntil: `${y + 5}-12-31`,
    noOutflowNote: "TBSZ lekötési idő (kivét esetén megszűnik az adókedvezmény)",
  };
}

// ---- Labels -----------------------------------------------------------------

/** "Lightyear TBSZ 2026 (LY-8WRK5A8)", "Államkincstár (60179832)". */
export function accountLabel(a: Account): string {
  return `${kindWithProvider(a.provider, a)}${a.externalRef ? ` (${a.externalRef})` : ""}`;
}

/** "Lightyear TBSZ 2027". */
export function pendingLabel(p: PendingAccount): string {
  return kindWithProvider(p.provider, { kind: p.kind, tbszYear: p.tbszYear } as Account);
}

/** The treasury account names its provider already. */
function kindWithProvider(provider: string, a: Account): string {
  const kind = accountKindLabel(a);
  return a.kind === "treasury" ? kind : `${providerLabel(provider)} ${kind}`;
}

/** The ledger account a pending one binds to (provider + kind + TBSZ year). */
export function resolvePending(p: PendingAccount, accounts: Account[]): Account | undefined {
  return accounts.find(
    (a) =>
      a.provider === p.provider &&
      a.kind === p.kind &&
      (p.kind !== "tbsz" || a.tbszYear === p.tbszYear),
  );
}

// ---- Context ----------------------------------------------------------------

export interface AccountHolding {
  accountId: string;
  valueHuf: number;
  quantity: number;
}

/** What account-aware planning needs to know, for one day. */
export interface AccountContext {
  day: string;
  accounts: Account[];
  limits: AccountLimits;
  purchase: PurchaseAccounts;
  fees: BrokerFees;
  /** Instrument key → where it is held (largest first). */
  holdings: Map<string, AccountHolding[]>;
  /** Account id → cash per currency (native amounts). */
  cash: Map<string, Record<string, number>>;
  /** Instrument key → the account of its latest buy. */
  lastBought: Map<string, string>;
  /** Instrument key → its trading currency. */
  currency: Map<string, string>;
  fx: Record<string, number>;
}

export function accountContext(a: {
  summary: PortfolioSummary;
  transactions: Transaction[];
  fx: Record<string, number>;
  day: string;
  limits: AccountLimits;
  purchase: PurchaseAccounts;
  fees: BrokerFees;
  /** Cash set aside for savings goals, per account — not free to move. */
  reserved?: Map<string, number>;
}): AccountContext {
  const holdings = new Map<string, AccountHolding[]>();
  const cash = new Map<string, Record<string, number>>();
  const currency = new Map<string, string>();
  for (const acc of a.summary.accounts) {
    const r = a.reserved?.get(acc.account.id);
    cash.set(acc.account.id, r ? freeCashOf(acc.cash, r, a.fx) : { ...acc.cash });
    for (const h of acc.holdings) {
      if (h.instrument) currency.set(h.instrumentKey, h.instrument.currency);
      if (h.quantity <= 0) continue;
      const list = holdings.get(h.instrumentKey) ?? [];
      list.push({
        accountId: acc.account.id,
        valueHuf: h.marketValueHuf ?? 0,
        quantity: h.quantity,
      });
      holdings.set(h.instrumentKey, list);
    }
  }
  for (const list of holdings.values()) list.sort((x, y) => y.valueHuf - x.valueHuf);
  const lastBought = new Map<string, string>();
  const lastDay = new Map<string, string>();
  for (const t of a.transactions) {
    if (t.type !== "buy" || !t.instrumentKey) continue;
    if ((lastDay.get(t.instrumentKey) ?? "") <= t.date) {
      lastDay.set(t.instrumentKey, t.date);
      lastBought.set(t.instrumentKey, t.accountId);
    }
  }
  return {
    day: a.day,
    accounts: a.summary.accounts.map((x) => x.account),
    limits: a.limits,
    purchase: a.purchase,
    fees: a.fees,
    holdings,
    cash,
    lastBought,
    currency,
    fx: a.fx,
  };
}

/** Free cash of an account in HUF (all currencies). */
export function accountCashHuf(ctx: AccountContext, accountId: string): number {
  const c = ctx.cash.get(accountId) ?? {};
  return Object.entries(c).reduce((s, [ccy, amt]) => s + toHuf(amt, ccy, ctx.fx), 0);
}

export function accountById(ctx: AccountContext, id: string | undefined): Account | undefined {
  return id ? ctx.accounts.find((a) => a.id === id) : undefined;
}

/** The provider's fee settings for an account (or a pending one). */
export function feeOf(ctx: AccountContext, provider: string | undefined): BrokerFee | undefined {
  return provider ? ctx.fees[provider] : undefined;
}

// ---- Venue: where a new buy goes --------------------------------------------

export interface Venue {
  /** The ledger account (undefined: pending and not imported yet, or unknown). */
  account?: Account;
  /** Set when the schedule names an account not in the ledger yet. */
  pending?: PendingAccount;
  provider?: string;
  label: string;
  /** How it was chosen. */
  source: "setting" | "largest" | "last" | "none";
  /** The account takes no deposits on this day. */
  depositBlocked: boolean;
  /** Its noDepositFrom (for the message). */
  blockedFrom?: string;
}

/** The schedule entry in force on `day`. */
export function purchaseEntryAt(
  purchase: PurchaseAccounts,
  key: string,
  day: string,
): PurchaseEntry | undefined {
  let best: PurchaseEntry | undefined;
  for (const e of purchase[key] ?? [])
    if (e.from <= day && (!best || e.from > best.from)) best = e;
  return best;
}

function venueOf(
  ctx: AccountContext,
  target: PurchaseTarget,
  source: Venue["source"],
): Venue {
  if ("accountId" in target) {
    const account = accountById(ctx, target.accountId);
    if (account) return fromAccount(ctx, account, source);
    return { label: "törölt számla", source, depositBlocked: false };
  }
  const bound = resolvePending(target.pending, ctx.accounts);
  if (bound) return fromAccount(ctx, bound, source);
  return {
    pending: target.pending,
    provider: target.pending.provider,
    label: pendingLabel(target.pending),
    source,
    depositBlocked: false,
  };
}

function fromAccount(ctx: AccountContext, account: Account, source: Venue["source"]): Venue {
  const blocked = depositBlocked(ctx.limits, account.id, ctx.day);
  return {
    account,
    provider: account.provider,
    label: accountLabel(account),
    source,
    depositBlocked: blocked,
    blockedFrom: blocked ? ctx.limits[account.id]?.noDepositFrom : undefined,
  };
}

/**
 * Where a new buy of `key` goes on the context's day: the schedule's entry in
 * force, else the account holding most of it, else the account of its latest
 * buy; `source: "none"` when nothing is known.
 */
export function purchaseVenue(ctx: AccountContext, key: string): Venue {
  const entry = purchaseEntryAt(ctx.purchase, key, ctx.day);
  if (entry) return venueOf(ctx, entry.target, "setting");
  const largest = ctx.holdings.get(key)?.[0];
  if (largest) return venueOf(ctx, { accountId: largest.accountId }, "largest");
  const last = ctx.lastBought.get(key);
  if (last && accountById(ctx, last)) return venueOf(ctx, { accountId: last }, "last");
  return { label: "ismeretlen számla", source: "none", depositBlocked: false };
}

/** A scheduled change of the venue within `horizonDays` after the day. */
export function upcomingVenueChange(
  ctx: AccountContext,
  key: string,
  horizonDays = 62,
): { from: string; label: string } | undefined {
  const until = new Date(Date.parse(ctx.day) + horizonDays * 86_400_000).toISOString().slice(0, 10);
  const next = (ctx.purchase[key] ?? [])
    .filter((e) => e.from > ctx.day && e.from <= until)
    .sort((x, y) => x.from.localeCompare(y.from))[0];
  if (!next) return undefined;
  const v = venueOf({ ...ctx, day: next.from }, next.target, "setting");
  return { from: next.from, label: v.label };
}

/** "nem fogad befizetést 2027-01-01 óta" — the reason a venue can't be used. */
export function blockedText(v: Venue): string {
  return `${v.label} ${v.blockedFrom ? `${v.blockedFrom} óta ` : ""}nem fogad befizetést`;
}

/**
 * One alert per account that new buys should go to from today but that isn't
 * in the ledger yet (naming every instrument waiting for it) — it disappears
 * once a matching account is imported.
 */
export function missingVenueAlerts(
  purchase: PurchaseAccounts,
  accounts: Account[],
  day: string,
  instrumentName: (key: string) => string,
): Alert[] {
  const byAccount = new Map<string, { label: string; from: string; names: string[] }>();
  for (const key of Object.keys(purchase).sort()) {
    const e = purchaseEntryAt(purchase, key, day);
    if (!e || !("pending" in e.target)) continue;
    if (resolvePending(e.target.pending, accounts)) continue;
    const label = pendingLabel(e.target.pending);
    const p = e.target.pending;
    const id = `${p.provider}:${p.kind}:${p.tbszYear ?? ""}`;
    const cur = byAccount.get(id) ?? { label, from: e.from, names: [] };
    cur.names.push(instrumentName(key));
    if (e.from < cur.from) cur.from = e.from;
    byAccount.set(id, cur);
  }
  return [...byAccount].map(([id, a]) => ({
    id: `venue-missing:${id}:${a.from}`,
    severity: "medium" as const,
    title: `Hiányzó vételi számla – ${a.label}`,
    detail: `${a.names.join(", ")} új vételei ${a.from}-tól ide mennek, de a számla még nincs a nyilvántartásban. Nyisd meg; az első import után automatikusan ide kötődik.`,
    to: "/settings",
    actionLabel: "Vételi számlák",
  }));
}
