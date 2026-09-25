// Client-side tools the AI chat may call (opt-in, off by default): each runs
// the app's own functions in the browser on the data already here and returns
// a compact JSON string. They let the model answer "what if…" and detail
// questions without the whole transaction history being sent up front.

import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Instrument, Transaction } from "./model";
import {
  asOf,
  assetClassOf,
  isInternalTransfer,
  toHuf,
  type PortfolioSummary,
  type PriceMap,
  type ValuePoint,
} from "./portfolio";
import type { HistoryFile } from "./prices";
import type { Cashflow } from "./bonds";
import {
  forecastMilestones,
  projectFromSettings,
  type PlannedExpense,
  type ForecastAssumptions,
} from "./forecast";
import { assetClassLabel, txTypeLabel } from "./labels";

/** Everything the tools read — the same state the pages show. */
export interface ToolEnv {
  summary: PortfolioSummary;
  transactions: Transaction[];
  instruments: Instrument[];
  prices: PriceMap;
  fx: Record<string, number>;
  history: HistoryFile | null | undefined;
  series: ValuePoint[];
  cashflows: Cashflow[];
  /** Savings goals as planned expenses (for projections). */
  goalExpenses: PlannedExpense[];
}

export interface ClientTool {
  def: BetaTool;
  /** Short Hungarian label for the UI chip, from the call's input. */
  label: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>, env: ToolEnv) => string;
}

// ---- input helpers (inputs are validated, never trusted) -------------------

const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: "null" }],
});
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const int = (v: unknown, min: number, max: number): number | null => {
  const n = num(v);
  return n == null ? null : Math.min(max, Math.max(min, Math.round(n)));
};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const isoDate = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const round = (n: number) => Math.round(n);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (d: number) =>
  new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

/** Instrument by ticker / ISIN / name fragment (case-insensitive). */
function findInstrument(env: ToolEnv, q: string): Instrument | undefined {
  const s = q.toLowerCase();
  return (
    env.instruments.find(
      (i) =>
        i.ticker?.toLowerCase() === s ||
        i.key.toLowerCase() === s ||
        i.isin?.toLowerCase() === s,
    ) ?? env.instruments.find((i) => i.name.toLowerCase().includes(s))
  );
}

/**
 * Weekly samples of an ascending dated series: walking back from the latest
 * row, keep a row whenever it is at least 7 calendar days before the last kept
 * one (series have trading days only, so "every 7th row" would be ~10 days).
 */
function weekly<T>(rows: T[], dateOf: (r: T) => string): T[] {
  const out: T[] = [];
  let lastMs = Infinity;
  for (let i = rows.length - 1; i >= 0; i--) {
    const ms = Date.parse(dateOf(rows[i]));
    if (lastMs - ms >= 7 * 86_400_000 || out.length === 0) {
      out.push(rows[i]);
      lastMs = ms;
    }
  }
  return out.reverse();
}

// ---- the tools --------------------------------------------------------------

const runForecast: ClientTool = {
  def: {
    name: "run_forecast",
    description:
      "Runs the app's wealth projection (the same engine as the Forecast page) with optional what-if changes. Use it for any question about future wealth, e.g. saving more per month, a different return, a one-off expense. Omitted (null) fields keep the user's saved settings. Returns yearly milestones (pessimistic / realistic / optimistic, contributed capital) in nominal HUF and the month the liquid money would run out, if ever.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        monthly_saving_huf: nullable({ type: "number" }),
        realistic_return_pct: {
          ...nullable({ type: "number" }),
          description:
            "Annual realistic return in percent; pessimistic/optimistic shift by the same amount.",
        },
        saving_growth_pct: nullable({ type: "number" }),
        years: nullable({ type: "integer" }),
        one_off_expense: nullable({
          type: "object",
          properties: {
            date: { type: "string", format: "date" },
            amount_huf: { type: "number" },
          },
          required: ["date", "amount_huf"],
          additionalProperties: false,
        }),
      },
      required: [
        "monthly_saving_huf",
        "realistic_return_pct",
        "saving_growth_pct",
        "years",
        "one_off_expense",
      ],
      additionalProperties: false,
    },
  },
  label: (i) => {
    const parts: string[] = [];
    const m = num(i.monthly_saving_huf);
    if (m != null) parts.push(`havi ${round(m).toLocaleString("hu-HU")} Ft`);
    const r = num(i.realistic_return_pct);
    if (r != null) parts.push(`${r}% hozam`);
    const y = num(i.years);
    if (y != null) parts.push(`${y} év`);
    return `Előrejelzés${parts.length ? ` (${parts.join(", ")})` : ""}`;
  },
  run: (i, env) => {
    const base = projectFromSettings(
      env.summary,
      env.transactions,
      env.fx,
      env.goalExpenses,
    ).assumptions;
    const over: Partial<ForecastAssumptions> = {};
    const m = num(i.monthly_saving_huf);
    if (m != null) over.monthlySavingHuf = Math.max(0, m);
    const r = num(i.realistic_return_pct);
    if (r != null) {
      const d = r / 100 - base.annualReturn.real;
      over.annualReturn = {
        pess: base.annualReturn.pess + d,
        real: base.annualReturn.real + d,
        opt: base.annualReturn.opt + d,
      };
    }
    const g = num(i.saving_growth_pct);
    if (g != null) over.savingGrowth = g / 100;
    const y = int(i.years, 1, 40);
    if (y != null) over.months = y * 12;
    const extra: PlannedExpense[] = [...env.goalExpenses];
    const e = i.one_off_expense as Record<string, unknown> | null;
    const eDate = e ? isoDate(e.date) : null;
    const eAmt = e ? num(e.amount_huf) : null;
    if (eDate && eAmt && eAmt > 0)
      extra.push({ id: "ai-what-if", date: eDate, amountHuf: eAmt, note: "what-if" });
    const { assumptions, result } = projectFromSettings(
      env.summary,
      env.transactions,
      env.fx,
      extra,
      over,
    );
    return JSON.stringify({
      used: {
        monthly_saving_huf: round(assumptions.monthlySavingHuf),
        returns_pct: {
          pess: +(assumptions.annualReturn.pess * 100).toFixed(2),
          real: +(assumptions.annualReturn.real * 100).toFixed(2),
          opt: +(assumptions.annualReturn.opt * 100).toFixed(2),
        },
        saving_growth_pct: +((assumptions.savingGrowth ?? 0) * 100).toFixed(2),
        years: assumptions.months / 12,
      },
      start_value_huf: round(result.startValueHuf),
      milestones: forecastMilestones(result).map((ms) => ({
        years: ms.years,
        month: ms.point.month,
        pessimistic: round(ms.point.pess),
        realistic: round(ms.point.real),
        optimistic: round(ms.point.opt),
        contributed: round(ms.point.contributed),
      })),
      end: {
        month: result.points.at(-1)?.month,
        realistic: round(result.points.at(-1)?.real ?? 0),
      },
      liquid_money_runs_out: result.shortfall.real ?? result.shortfall.pess,
    });
  },
};

const getHoldings: ClientTool = {
  def: {
    name: "get_holdings",
    description:
      "Lists every current position by account (account kind, TBSZ vintage year, cash), with quantity, market value, cost basis and unrealized P/L in HUF. Use it for questions about which account holds what, position sizes or per-position returns. Optionally filter by an account name fragment.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { account: nullable({ type: "string" }) },
      required: ["account"],
      additionalProperties: false,
    },
  },
  label: (i) => `Pozíciók${str(i.account) ? `: ${str(i.account)}` : ""}`,
  run: (i, env) => {
    const q = str(i.account)?.toLowerCase();
    const total = env.summary.totalValueHuf || 1;
    return JSON.stringify(
      env.summary.accounts
        .filter((a) => !q || a.account.name.toLowerCase().includes(q))
        .map((a) => ({
          account: a.account.name,
          kind: a.account.kind,
          tbsz_year: a.account.tbszYear ?? null,
          value_huf: round(a.totalValueHuf),
          cash_huf: round(a.cashValueHuf),
          holdings: a.holdings
            .filter((h) => h.quantity > 0)
            .map((h) => ({
              name: h.instrument?.name ?? h.instrumentKey,
              isin: h.instrument?.isin ?? h.instrumentKey,
              class: assetClassLabel[assetClassOf(h.instrument)],
              currency: h.currency,
              quantity: h.quantity,
              value_huf: round(h.marketValueHuf ?? 0),
              weight_pct: +(((h.marketValueHuf ?? 0) / total) * 100).toFixed(2),
              cost_huf: round(h.costBasisHuf),
              unrealized_pl_huf: round(h.unrealizedPlHuf ?? 0),
            })),
        })),
    );
  },
};

const TX_TYPES = [
  "buy",
  "sell",
  "deposit",
  "withdrawal",
  "interest",
  "dividend",
  "redemption",
  "fee",
  "tax",
];

const getTransactions: ClientTool = {
  def: {
    name: "get_transactions",
    description:
      "Returns individual transactions, newest first (max 50), optionally filtered by instrument (ticker, ISIN or name fragment), type and date range. Internal transfers between the user's own accounts are excluded. Amounts are converted to HUF.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        instrument: nullable({ type: "string" }),
        type: nullable({ type: "string", enum: TX_TYPES }),
        from: nullable({ type: "string", format: "date" }),
        to: nullable({ type: "string", format: "date" }),
        limit: nullable({ type: "integer" }),
      },
      required: ["instrument", "type", "from", "to", "limit"],
      additionalProperties: false,
    },
  },
  label: (i) =>
    `Tranzakciók${str(i.instrument) ? `: ${str(i.instrument)}` : ""}${str(i.type) ? ` (${txTypeLabel[i.type as keyof typeof txTypeLabel] ?? i.type})` : ""}`,
  run: (i, env) => {
    const instQ = str(i.instrument);
    const inst = instQ ? findInstrument(env, instQ) : undefined;
    if (instQ && !inst)
      return JSON.stringify({ error: `Nincs ilyen eszköz: ${instQ}` });
    const type = str(i.type);
    const from = isoDate(i.from);
    const to = isoDate(i.to);
    const limit = int(i.limit, 1, 50) ?? 20;
    const names = new Map(env.instruments.map((x) => [x.key, x.name]));
    const rows = env.transactions
      .filter((t) => !t.internal && !isInternalTransfer(t))
      .filter((t) => !inst || t.instrumentKey === inst.key)
      .filter((t) => !type || t.type === type)
      .filter((t) => (!from || t.date.slice(0, 10) >= from) && (!to || t.date.slice(0, 10) <= to))
      .sort((a, b) => b.date.localeCompare(a.date));
    return JSON.stringify({
      total_matching: rows.length,
      transactions: rows.slice(0, limit).map((t) => ({
        date: t.date.slice(0, 10),
        type: t.type,
        instrument: t.instrumentKey ? (names.get(t.instrumentKey) ?? t.instrumentKey) : null,
        quantity: t.quantity ?? null,
        amount_huf: round(
          toHuf(Math.abs(t.grossAmount ?? t.netAmount ?? 0), t.currency, env.fx),
        ),
        currency: t.currency,
      })),
    });
  },
};

const getPriceHistory: ClientTool = {
  def: {
    name: "get_price_history",
    description:
      "Daily closing price history of one security (ETF / stock) from the app's price file, sampled weekly, plus the change over the period. Use for questions about how a holding moved.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        instrument: { type: "string", description: "Ticker, ISIN or name fragment." },
        days: nullable({ type: "integer" }),
      },
      required: ["instrument", "days"],
      additionalProperties: false,
    },
  },
  label: (i) => `Árfolyam-előzmény: ${str(i.instrument) ?? "?"}`,
  run: (i, env) => {
    const q = str(i.instrument) ?? "";
    const inst = findInstrument(env, q);
    if (!inst) return JSON.stringify({ error: `Nincs ilyen eszköz: ${q}` });
    const series = env.history?.prices[inst.key];
    if (!series?.length)
      return JSON.stringify({ error: `Nincs árfolyam-előzmény ehhez: ${inst.name}` });
    const days = int(i.days, 7, 730) ?? 90;
    const from = daysAgo(days);
    const rows = series.filter(([d]) => d >= from);
    const now = env.prices.get(inst.key) ?? rows.at(-1)?.[1];
    const start = asOf(series, from) ?? rows[0]?.[1];
    return JSON.stringify({
      instrument: inst.name,
      currency: inst.currency,
      current_price: now,
      change_pct: start && now ? +((now / start - 1) * 100).toFixed(2) : null,
      weekly_closes: weekly(rows, (r) => r[0]).map(([d, p]) => [d, +p.toFixed(4)]),
    });
  },
};

const getValueHistory: ClientTool = {
  def: {
    name: "get_value_history",
    description:
      "The whole portfolio's value over time, sampled weekly: value, net invested capital and the market result (value minus invested). Use for trend questions.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { days: nullable({ type: "integer" }) },
      required: ["days"],
      additionalProperties: false,
    },
  },
  label: () => "Vagyon-előzmény",
  run: (i, env) => {
    const days = int(i.days, 7, 1460) ?? 180;
    const from = daysAgo(days);
    const rows = env.series.filter((p) => p.date >= from);
    return JSON.stringify({
      until: today(),
      weekly: weekly(rows, (p) => p.date).map((p) => ({
        date: p.date,
        value_huf: round(p.value),
        invested_huf: round(p.invested),
        market_result_huf: round(p.value - p.invested),
      })),
    });
  },
};

const getCashflows: ClientTool = {
  def: {
    name: "get_cashflows",
    description:
      "Expected future bond cash flows (coupons and maturities) of the current holdings, by date, if held to maturity.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { months: nullable({ type: "integer" }) },
      required: ["months"],
      additionalProperties: false,
    },
  },
  label: () => "Várható pénzáramlás",
  run: (i, env) => {
    const months = int(i.months, 1, 120) ?? 24;
    const lim = new Date();
    lim.setMonth(lim.getMonth() + months);
    const until = lim.toISOString().slice(0, 10);
    return JSON.stringify(
      env.cashflows
        .filter((c) => c.date.slice(0, 10) <= until)
        .map((c) => ({
          date: c.date.slice(0, 10),
          kind: c.kind,
          title: c.title,
          amount_huf: round(c.amountHuf),
        })),
    );
  },
};

export const CLIENT_TOOLS: ClientTool[] = [
  runForecast,
  getHoldings,
  getTransactions,
  getPriceHistory,
  getValueHistory,
  getCashflows,
];

/** Run one tool call; errors become an error result the model can read. */
export function runTool(
  name: string,
  input: unknown,
  env: ToolEnv,
): { content: string; isError: boolean } {
  const tool = CLIENT_TOOLS.find((t) => t.def.name === name);
  if (!tool) return { content: `Ismeretlen eszköz: ${name}`, isError: true };
  if (typeof input !== "object" || input == null)
    return { content: "Érvénytelen bemenet.", isError: true };
  try {
    return { content: tool.run(input as Record<string, unknown>, env), isError: false };
  } catch (e) {
    return { content: `Hiba: ${(e as Error).message}`, isError: true };
  }
}

export function toolLabel(name: string, input: unknown): string {
  const tool = CLIENT_TOOLS.find((t) => t.def.name === name);
  if (!tool) return name;
  try {
    return tool.label((input ?? {}) as Record<string, unknown>);
  } catch {
    return name;
  }
}
