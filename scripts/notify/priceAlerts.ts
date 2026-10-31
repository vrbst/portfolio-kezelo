import type { Context } from "./data";
import type { PriceAlert, State } from "./state";
import { esc, px } from "./reports";
import type { SymbolQuote } from "../../src/lib/prices";

export const PRICE_ALERT_MAX = 20;

const BELOW = /^(<|alá|ala|alatt)$/i;
const ABOVE = /^(>|fölé|fole|felett|fölött|folott)$/i;
const DELETE = /^(töröl|torol|törlés|torles|törlöm|del|delete)$/i;

type Target = Pick<PriceAlert, "key" | "label" | "currency" | "fx" | "symbol">;

/** Key of an alert on a Yahoo symbol outside the portfolio. */
export const symbolKey = (symbol: string) => `yahoo:${symbol}`;

const fxLevel = (n: number) =>
  n.toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const levelText = (a: Pick<PriceAlert, "fx" | "currency">, n: number) =>
  a.fx ? fxLevel(n) : px(n, a.currency);

const opText = (op: PriceAlert["op"]) => (op === "below" ? "alá" : "fölé");

export function alertPrice(ctx: Context, a: Target): number | undefined {
  const p = a.fx ? ctx.fx[a.key] : a.symbol ? ctx.alertPrices?.get(a.key) : ctx.prices.get(a.key);
  return p != null && Number.isFinite(p) && p > 0 ? p : undefined;
}

const normalized = (query: string) => query.trim().toUpperCase().replace(/\/HUF$/, "");
const isFxQuery = (ctx: Context, q: string) => q !== "HUF" && /^[A-Z]{3}$/.test(q) && !!ctx.fx[q];

const portfolioMatches = (ctx: Context, query: string) => {
  const q = normalized(query);
  const exact = ctx.instruments.filter(
    (i) => i.ticker?.toUpperCase() === q || i.isin?.toUpperCase() === q || i.key.toUpperCase() === q,
  );
  return exact.length ? exact : ctx.instruments.filter((i) => i.name.toUpperCase().includes(q));
};

/**
 * `external`: the Yahoo quote of a ticker the portfolio doesn't know (looked
 * up by the caller, see externalQuery); used only when nothing in it matches.
 */
export function resolveTarget(ctx: Context, query: string, external?: SymbolQuote | null): Target | string {
  const q = normalized(query);
  if (isFxQuery(ctx, q)) return { key: q, label: `${q}/HUF`, currency: "HUF", fx: true };
  const byName = portfolioMatches(ctx, query);
  const found = byName.filter((i) => ctx.prices.has(i.key));
  if (found.length === 1) {
    const i = found[0];
    return { key: i.key, label: i.ticker ?? i.name, currency: i.currency, fx: false };
  }
  if (found.length > 1)
    return `Több papír is illik rá (${found.slice(0, 4).map((i) => esc(i.ticker ?? i.name)).join(", ")}) – add meg a tickert vagy az ISIN-t.`;
  if (byName.length) return `A(z) ${esc(query)} papírnak nincs árfolyama, így nem tudom figyelni.`;
  if (external)
    return {
      key: symbolKey(external.symbol),
      label: external.symbol,
      currency: external.currency ?? "",
      fx: false,
      symbol: external.symbol,
    };
  return `Nem ismerem ezt a papírt vagy devizát: ${esc(query)}`;
}

const parseLevel = (s: string) => {
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const HELP = [
  "Új riasztás: <code>/riasztas VWCE 100 alatt</code> vagy <code>/riasztas EUR 400 felett</code>",
  "Portfólión kívüli papír Yahoo-tickerrel: <code>/riasztas NVDA 150 alatt</code>, <code>/riasztas ASML.AS 700 felett</code>",
  "Törlés: <code>/riasztas torol 1</code> (vagy <code>torol mind</code>)",
].join("\n");

export function priceAlertList(ctx: Context, alerts: PriceAlert[]): string {
  if (!alerts.length) return `🔔 Nincs beállított árriasztás.\n\n${HELP}`;
  const lines = alerts.map((a, i) => {
    const now = alertPrice(ctx, a);
    return `${i + 1}. ${esc(a.label)} ${levelText(a, a.level)} ${opText(a.op)}${now != null ? ` (most ${levelText(a, now)})` : ""}`;
  });
  return [`🔔 <b>Árriasztások (${alerts.length})</b>`, ...lines, "", HELP].join("\n");
}

const splitArgs = (args: string) => args.replace(/([<>])/g, " $1 ").trim().split(/\s+/).filter(Boolean);

function parseAdd(words: string[]) {
  const opIdx = words.findIndex((w, i) => i > 0 && (BELOW.test(w) || ABOVE.test(w)));
  const level = opIdx > 0 ? parseLevel(words.filter((_, i) => i > 0 && i !== opIdx).join("")) : undefined;
  if (opIdx < 0 || level == null) return null;
  const op: PriceAlert["op"] = BELOW.test(words[opIdx]) ? "below" : "above";
  return { query: words[0], op, level };
}

/**
 * The ticker to look up on Yahoo for a new alert: set only when the command
 * adds one and neither a currency nor anything in the portfolio matches it.
 */
export function externalQuery(ctx: Context, args: string): string | undefined {
  const words = splitArgs(args);
  if (!words.length || DELETE.test(words[0])) return undefined;
  const add = parseAdd(words);
  if (!add || isFxQuery(ctx, normalized(add.query))) return undefined;
  return portfolioMatches(ctx, add.query).length ? undefined : add.query;
}

/** Current prices of the alerts on securities outside the portfolio, by key (failed lookups left out). */
export async function externalAlertPrices(
  alerts: PriceAlert[],
  quote: (symbol: string) => Promise<SymbolQuote | null>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const symbols = [...new Set(alerts.flatMap((a) => (a.symbol ? [a.symbol] : [])))];
  await Promise.all(
    symbols.map(async (s) => {
      const q = await quote(s).catch(() => null);
      if (q && Number.isFinite(q.price) && q.price > 0) out.set(symbolKey(s), q.price);
    }),
  );
  return out;
}

export function priceAlertCommand(
  ctx: Context,
  args: string,
  alerts: PriceAlert[],
  external?: SymbolQuote | null,
): { html: string; alerts: PriceAlert[] } {
  const words = splitArgs(args);
  if (!words.length) return { html: priceAlertList(ctx, alerts), alerts };

  if (DELETE.test(words[0])) {
    const which = words.slice(1).join(" ").toLowerCase();
    if (which === "mind" || which === "all")
      return { html: alerts.length ? "🗑 Minden árriasztást töröltem." : priceAlertList(ctx, alerts), alerts: [] };
    const n = Number(which);
    const idx = Number.isInteger(n) && n >= 1 && n <= alerts.length ? n - 1 : -1;
    if (idx < 0) return { html: `❌ Nincs ilyen sorszámú riasztás.\n\n${priceAlertList(ctx, alerts)}`, alerts };
    const gone = alerts[idx];
    return {
      html: `🗑 Töröltem: ${esc(gone.label)} ${levelText(gone, gone.level)} ${opText(gone.op)}`,
      alerts: alerts.filter((_, i) => i !== idx),
    };
  }

  const add = parseAdd(words);
  if (!add) return { html: `❌ Ezt nem értem: <code>${esc(args.trim())}</code>\n\n${HELP}`, alerts };
  const { op, level } = add;

  const target = resolveTarget(ctx, add.query, external);
  if (typeof target === "string") return { html: `❌ ${target}`, alerts };
  const now = target.symbol ? external!.price : alertPrice(ctx, target)!;
  if (op === "below" ? now <= level : now >= level)
    return {
      html: `❌ Ez már most is teljesül: ${esc(target.label)} most ${levelText(target, now)}.`,
      alerts,
    };
  const id = `${target.key}:${op}:${level}`;
  if (alerts.some((a) => a.id === id))
    return { html: `Ez a riasztás már be van állítva.\n\n${priceAlertList(ctx, alerts)}`, alerts };
  if (alerts.length >= PRICE_ALERT_MAX)
    return { html: `❌ Legfeljebb ${PRICE_ALERT_MAX} riasztás lehet; előbb törölj egyet.`, alerts };
  const alert: PriceAlert = { id, ...target, op, level, createdAt: ctx.at.toISOString() };
  if (!target.symbol) delete alert.symbol;
  const named = target.symbol && external?.name ? ` (${esc(external.name)})` : "";
  return {
    html: `🔔 Rendben: szólok, ha a(z) ${esc(target.label)}${named} ${levelText(target, level)} ${opText(op)} megy (most ${levelText(target, now)}).`,
    alerts: [...alerts, alert],
  };
}

export function priceAlertMessages(ctx: Context, st: State): string[] {
  const alerts = st.priceAlerts ?? [];
  if (!alerts.length) return [];
  const out: string[] = [];
  const keep: PriceAlert[] = [];
  for (const a of alerts) {
    const now = alertPrice(ctx, a);
    const hit = now != null && (a.op === "below" ? now <= a.level : now >= a.level);
    if (!hit) {
      keep.push(a);
      continue;
    }
    out.push(
      `🔔 <b>${esc(a.label)} ${levelText(a, a.level)} ${opText(a.op)} ment</b>: most ${levelText(a, now!)}\n<i>A riasztást töröltem; újat a /riasztas paranccsal állíthatsz be.</i>`,
    );
  }
  st.priceAlerts = keep;
  return out;
}
