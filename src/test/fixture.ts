// ---------------------------------------------------------------------------
// An INVENTED portfolio for the end-to-end tests (Vitest pipeline snapshot and
// the Playwright browser tests). Its shape mirrors real use — two Lightyear
// TBSZ vintages with a funding cash account, a treasury account with a FixMÁP
// and two DKJ series, savings goals, a DCA goal, a glide path, broker fees,
// account limits — but every name, amount and date is made up.
//
// Every timestamp is built from LOCAL time, like the importers do, so the
// fixture means the same calendar days in any time zone — hence functions,
// not constants: they are evaluated in the zone the test has set.
// ---------------------------------------------------------------------------

import type { Account, Instrument, Transaction } from "../lib/model";
import type { PortfolioSnapshot } from "../lib/sync";
import type { SyncedPrefs, StampedPref } from "../lib/prefs";
import type { SavingsGoal } from "../lib/savings";
import type { GlideConfig } from "../lib/glidePath";
import type { Goal } from "../lib/goals";
import type { HistoryFile, LiveQuote, PriceFile } from "../lib/prices";

/** Local wall-clock time → the ISO instant the importers store. */
export const local = (y: number, m: number, d: number, hh = 10, mi = 0) =>
  new Date(y, m - 1, d, hh, mi).toISOString();

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

// ---- accounts ---------------------------------------------------------------

export const ACCOUNTS: Account[] = [
  {
    id: "ly-cash",
    name: "Lightyear pénzszámla (LY-TESZT00)",
    provider: "lightyear",
    kind: "cash",
    currency: "HUF",
    externalRef: "LY-TESZT00",
  },
  {
    id: "ly-tbsz25",
    name: "Lightyear TBSZ 2025 (LY-TESZT25)",
    provider: "lightyear",
    kind: "tbsz",
    tbszYear: 2025,
    currency: "HUF",
    externalRef: "LY-TESZT25",
    linkedCashAccountId: "ly-cash",
  },
  {
    id: "ly-tbsz26",
    name: "Lightyear TBSZ 2026 (LY-TESZT26)",
    provider: "lightyear",
    kind: "tbsz",
    tbszYear: 2026,
    currency: "HUF",
    externalRef: "LY-TESZT26",
    linkedCashAccountId: "ly-cash",
  },
  {
    id: "mak",
    name: "Államkincstár (12345678)",
    provider: "allamkincstar",
    kind: "treasury",
    currency: "HUF",
    externalRef: "12345678",
  },
];

// ---- instruments ------------------------------------------------------------

export const VWCE = "IE00BK5BQT80";
export const WBIT = "GB00BJYDH287";
export const FIX = "HU0000TESZT1";
export const DKJ1 = "HU0000TESZT2";
export const DKJ2 = "HU0000TESZT3";
export const DKJ3 = "HU0000TESZT4";

export const instruments = (): Instrument[] => [
  { key: VWCE, name: "VWCE", ticker: "VWCE", isin: VWCE, type: "etf", currency: "EUR", terPct: 0.0019 },
  { key: WBIT, name: "WBIT", ticker: "WBIT", isin: WBIT, type: "etf", currency: "EUR", terPct: 0.0015 },
  {
    key: FIX,
    name: "Fix Magyar Állampapír 2030/I",
    isin: FIX,
    type: "gov_bond",
    currency: "HUF",
    faceValue: 1,
    maturity: "2030-03-15",
    bond: {
      issueDate: "2024-03-15",
      couponRate: 0.065,
      couponIntervalMonths: 12,
      firstCouponDate: "2025-03-15",
      maturity: "2030-03-15",
    },
  },
  {
    key: DKJ1,
    name: "Diszkont Kincstárjegy D261118",
    isin: DKJ1,
    type: "tbill",
    currency: "HUF",
    faceValue: 1,
    // Stored like the settings dialog does: the ISO instant of LOCAL midnight
    // (in Budapest "2026-11-17T23:00:00.000Z") — it must still read as 18 Nov.
    maturity: new Date(2026, 10, 18).toISOString(),
  },
  {
    key: DKJ2,
    name: "Diszkont Kincstárjegy D270512",
    isin: DKJ2,
    type: "tbill",
    currency: "HUF",
    faceValue: 1,
    maturity: "2027-05-12",
  },
  {
    key: DKJ3,
    name: "Diszkont Kincstárjegy D270310",
    isin: DKJ3,
    type: "tbill",
    currency: "HUF",
    faceValue: 1,
    maturity: "2027-03-10",
    // Marked "nem vehető" in the settings (its sale has closed).
    notBuyable: true,
  },
];

// ---- transactions -----------------------------------------------------------

let seq = 0;
const tx = (t: Omit<Transaction, "id">): Transaction => ({ id: `t${++seq}`, ...t });

/** Monthly flow: HUF in via the cash account → TBSZ → EUR → VWCE (+ some WBIT). */
function lightyearMonth(acct: string, y: number, m: number, huf: number, eurHuf: number, vwce: number, wbit: number): Transaction[] {
  const eur = Math.round((huf / eurHuf) * 100) / 100;
  const out: Transaction[] = [
    tx({ accountId: "ly-cash", date: local(y, m, 3, 9), type: "deposit", currency: "HUF", grossAmount: huf, netAmount: huf, reference: `DEP-${y}${m}` }),
    tx({ accountId: "ly-cash", date: local(y, m, 3, 9, 5), type: "withdrawal", currency: "HUF", grossAmount: huf, netAmount: -huf, reference: `IT-${y}${m}` }),
    tx({ accountId: acct, date: local(y, m, 3, 9, 5), type: "deposit", currency: "HUF", grossAmount: huf, netAmount: huf, reference: `IT-${y}${m}` }),
    tx({ accountId: acct, date: local(y, m, 3, 9, 10), type: "conversion", currency: "HUF", grossAmount: -huf, netAmount: -huf, fxRate: eurHuf, reference: `CV-${acct}-${y}${m}` }),
    tx({ accountId: acct, date: local(y, m, 3, 9, 10), type: "conversion", currency: "EUR", grossAmount: eur, netAmount: eur, fxRate: eurHuf, reference: `CV-${acct}-${y}${m}` }),
  ];
  const buy = (key: string, price: number, budget: number, min: number) => {
    const qty = Math.floor((budget / price) * 1e4) / 1e4;
    // Lightyear: the gross amount of a buy includes its fee.
    const gross = Math.round((qty * price + 1) * 100) / 100;
    out.push(tx({ accountId: acct, date: local(y, m, 3, 15, min), type: "buy", instrumentKey: key, quantity: qty, pricePerUnit: price, currency: "EUR", grossAmount: gross, fee: 1, netAmount: -gross }));
  };
  const wbitBudget = Math.round(eur * 0.1 * 100) / 100;
  buy(VWCE, vwce, eur - wbitBudget - 3, 30);
  buy(WBIT, wbit, wbitBudget - 1, 31);
  return out;
}

function buildTransactions(): Transaction[] {
  seq = 0;
  const txs: Transaction[] = [];
  // TBSZ 2025: January–December 2025.
  for (let m = 1; m <= 12; m++)
    txs.push(...lightyearMonth("ly-tbsz25", 2025, m, 150_000, 400 + m, 125 + m * 2, 9 + m * 0.4));
  // TBSZ 2026: January–September 2026.
  for (let m = 1; m <= 9; m++)
    txs.push(...lightyearMonth("ly-tbsz26", 2026, m, 400_000, 390 - m, 150 + m * 2, 14 + m * 0.3));

  // Treasury: FixMÁP bought in 2025, coupon in 2026, two DKJ series.
  txs.push(
    tx({ accountId: "mak", date: local(2025, 3, 1, 0), type: "deposit", currency: "HUF", grossAmount: 4_000_000, netAmount: 4_000_000 }),
    tx({ accountId: "mak", date: local(2025, 3, 4, 0), type: "buy", instrumentKey: FIX, quantity: 2_500_000, pricePerUnit: 1.012, currency: "HUF", grossAmount: 2_530_000, netAmount: -2_530_000 }),
    tx({ accountId: "mak", date: local(2025, 3, 17, 0), type: "interest", instrumentKey: FIX, currency: "HUF", grossAmount: 162_500, netAmount: 162_500 }),
    tx({ accountId: "mak", date: local(2025, 11, 20, 0), type: "buy", instrumentKey: DKJ1, quantity: 1_000_000, pricePerUnit: 0.9602, currency: "HUF", grossAmount: 960_200, netAmount: -960_200 }),
    tx({ accountId: "mak", date: local(2026, 2, 10, 0), type: "buy", instrumentKey: DKJ3, quantity: 300_000, pricePerUnit: 0.9644, currency: "HUF", grossAmount: 289_320, netAmount: -289_320 }),
    tx({ accountId: "mak", date: local(2026, 3, 16, 0), type: "interest", instrumentKey: FIX, currency: "HUF", grossAmount: 162_500, netAmount: 162_500 }),
    tx({ accountId: "mak", date: local(2026, 5, 14, 0), type: "buy", instrumentKey: DKJ2, quantity: 500_000, pricePerUnit: 0.9641, currency: "HUF", grossAmount: 482_050, netAmount: -482_050 }),
    tx({ accountId: "mak", date: local(2026, 8, 28, 0), type: "deposit", currency: "HUF", grossAmount: 300_000, netAmount: 300_000 }),
  );
  return txs;
}

// ---- planning prefs ---------------------------------------------------------

const STAMP = "2026-09-01T08:00:00.000Z";
const stamped = <T>(value: T): StampedPref<T> => ({ updatedAt: STAMP, value });

export const savingsGoals = (): SavingsGoal[] => [
  {
    id: "g-babavaro",
    name: "Babakocsi",
    targetHuf: 1_300_000,
    targetDate: "2026-12-20",
    instrumentKeys: [DKJ1],
    includeCoupons: true,
    monthlyReminder: true,
    createdAt: local(2025, 11, 1),
    reserves: [{ id: "r1", amountHuf: 100_000, date: "2026-08-31", accountId: "mak" }],
  },
  {
    id: "g-auto",
    name: "Autó",
    targetHuf: 2_500_000,
    targetDate: "2027-09-30",
    instrumentKeys: [DKJ2],
    includeCoupons: false,
    monthlyReminder: true,
    createdAt: local(2026, 5, 1),
    saveFrom: "2026-10-01",
  },
  {
    // Its only instrument is marked "nem vehető" in the settings: the goal
    // holds cash; the FixMÁP coupon of March (before that) is not its money.
    id: "g-nyaralas",
    name: "Nyaralás",
    targetHuf: 600_000,
    targetDate: "2027-06-30",
    instrumentKeys: [DKJ3],
    includeCoupons: true,
    monthlyReminder: true,
    createdAt: local(2026, 2, 1),
  },
];

export const dcaGoals = (): Goal[] => [
  { id: "dca-vwce", instrumentKey: VWCE, amountHuf: 100_000, periodMonths: 1, createdAt: local(2025, 1, 1) },
];

export const glideConfig = (): GlideConfig => ({
  id: "glide-v1",
  validFrom: "2026-01-01",
  savedAt: local(2026, 1, 1),
  buckets: [
    {
      id: "eq",
      name: "Részvény",
      finalWeight: 0.5,
      start: { mode: "manual", weight: 0.6 },
      startDate: "2026-01-01",
      endDate: "2030-01-01",
      interpolation: "linear",
      band: { kind: "abs", pp: 0.05 },
    },
    {
      id: "crypto",
      name: "Kripto",
      finalWeight: 0.05,
      start: { mode: "manual", weight: 0.05 },
      startDate: "2026-01-01",
      endDate: "2030-01-01",
      interpolation: "linear",
      band: { kind: "rel", pct: 0.3, minPp: 0.01 },
    },
    {
      id: "bond",
      name: "Kötvény",
      finalWeight: 0.45,
      start: { mode: "manual", weight: 0.35 },
      startDate: "2026-01-01",
      endDate: "2030-01-01",
      interpolation: "linear",
      band: { kind: "abs", pp: 0.05 },
    },
  ],
  instruments: {
    [VWCE]: { bucketId: "eq", sellable: true, acceptsContributions: true, fractional: true },
    [WBIT]: { bucketId: "crypto", sellable: true, acceptsContributions: true, fractional: true },
    [FIX]: { bucketId: "bond", sellable: false, acceptsContributions: true },
    [DKJ1]: { bucketId: "bond", sellable: false, acceptsContributions: true },
    [DKJ2]: { bucketId: "bond", sellable: false, acceptsContributions: true },
    "cash:HUF": { bucketId: "bond", sellable: true, acceptsContributions: true },
  },
  checkFrequency: "monthly",
  minTradeHuf: 10_000,
  restoreTo: "path",
  maxCostRatio: 0.01,
  bondsAtFace: true,
  defaultCost: {},
  realertStepPp: 0.02,
  deepAlertsInQuietHours: false,
  monthlyAmount: { kind: "remainder" },
  flowTarget: { kind: "today" },
  buyCostMode: "included",
});

export const fixturePrefs = (): SyncedPrefs => ({
  savings: stamped(savingsGoals()),
  glidePath: stamped([glideConfig()]),
  brokerFees: stamped({
    lightyear: { buy: { fixedHuf: 400 }, sell: { fixedHuf: 400 }, fxPct: 0.0035 },
    allamkincstar: {},
  }),
  accountLimits: stamped({
    "ly-tbsz25": { noOutflowUntil: "2030-12-31", noOutflowNote: "TBSZ lekötés" },
    "ly-tbsz26": { noDepositFrom: "2027-01-01", noDepositNote: "gyűjtőév vége" },
  }),
  purchaseAccounts: stamped({
    // From 2027 the buys go to next year's TBSZ — not opened yet.
    [VWCE]: [
      { from: "2026-01-01", target: { accountId: "ly-tbsz26" } },
      { from: "2027-01-01", target: { pending: { provider: "lightyear", kind: "tbsz", tbszYear: 2027 } } },
    ],
    [WBIT]: [
      { from: "2026-01-01", target: { accountId: "ly-tbsz26" } },
      { from: "2027-01-01", target: { pending: { provider: "lightyear", kind: "tbsz", tbszYear: 2027 } } },
    ],
    [DKJ1]: [{ from: "2025-01-01", target: { accountId: "mak" } }],
    [DKJ2]: [{ from: "2025-01-01", target: { accountId: "mak" } }],
  }),
  income: stamped({ since: "2026-09-01", allocated: [] }),
});

// ---- prices -----------------------------------------------------------------

/** Deterministic daily closes: a gentle trend with a weekly wiggle. */
function curve(start: number, drift: number, wiggle: number, i: number) {
  return Math.round((start * (1 + drift * i) + wiggle * Math.sin(i / 5)) * 100) / 100;
}

/** Weekday history from 2025-01-01 up to and including `until` (YYYY-MM-DD). */
export function fixtureHistory(until: string): HistoryFile {
  const vw: [string, number][] = [];
  const wb: [string, number][] = [];
  const eur: [string, number][] = [];
  let i = 0;
  for (let t = Date.UTC(2025, 0, 1); ; t += 86_400_000) {
    const d = new Date(t);
    const day = ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (day > until) break;
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    vw.push([day, curve(125, 0.0009, 1.5, i)]);
    wb.push([day, curve(9, 0.0018, 0.6, i)]);
    eur.push([day, curve(405, -0.00005, 2, i)]);
    i++;
  }
  return { updatedAt: STAMP, prices: { [VWCE]: vw, [WBIT]: wb }, fx: { EUR: eur } };
}

export function fixturePriceFile(history: HistoryFile): PriceFile {
  const last = (s: [string, number][]) => s[s.length - 1][1];
  return {
    updatedAt: STAMP,
    fx: { EUR: last(history.fx.EUR) },
    prices: {
      [VWCE]: { price: last(history.prices[VWCE]), currency: "EUR", symbol: `${VWCE}.SG`, label: "VWCE", name: "VWCE" },
      [WBIT]: { price: last(history.prices[WBIT]), currency: "EUR", symbol: `${WBIT}.SG`, label: "WBIT", name: "WBIT" },
    },
  };
}

/** Live quotes: today a little up from the file's last close. */
export function fixtureQuotes(priceFile: PriceFile): {
  fxQuotes: Record<string, LiveQuote>;
  priceQuotes: Record<string, LiveQuote>;
} {
  const eur = priceFile.fx.EUR;
  const vw = priceFile.prices[VWCE].price;
  const wb = priceFile.prices[WBIT].price;
  return {
    fxQuotes: { EUR: { price: Math.round((eur + 0.8) * 100) / 100, prevClose: eur } },
    priceQuotes: {
      [VWCE]: { price: Math.round(vw * 1.006 * 100) / 100, prevClose: vw },
      [WBIT]: { price: Math.round(wb * 0.985 * 100) / 100, prevClose: wb },
    },
  };
}

// ---- the snapshot -----------------------------------------------------------

export function fixtureSnapshot(): PortfolioSnapshot {
  return {
    version: 1,
    exportedAt: STAMP,
    accounts: ACCOUNTS,
    instruments: instruments(),
    transactions: buildTransactions(),
    goals: dcaGoals(),
    reminders: [
      { id: "rem-1", createdAt: local(2026, 9, 10), severity: "info", title: "Kupon-import ellenőrzése" },
    ],
    prefs: fixturePrefs(),
  };
}
