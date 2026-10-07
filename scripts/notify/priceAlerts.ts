import type { Context } from "./data";
import type { PriceAlert, State } from "./state";
import { esc, px } from "./reports";

export const PRICE_ALERT_MAX = 20;

const BELOW = /^(<|alá|ala|alatt)$/i;
const ABOVE = /^(>|fölé|fole|felett|fölött|folott)$/i;
const DELETE = /^(töröl|torol|törlés|torles|törlöm|del|delete)$/i;

type Target = Pick<PriceAlert, "key" | "label" | "currency" | "fx">;

const fxLevel = (n: number) =>
  n.toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const levelText = (a: Pick<PriceAlert, "fx" | "currency">, n: number) =>
  a.fx ? fxLevel(n) : px(n, a.currency);

const opText = (op: PriceAlert["op"]) => (op === "below" ? "alá" : "fölé");

export function alertPrice(ctx: Context, a: Target): number | undefined {
  const p = a.fx ? ctx.fx[a.key] : ctx.prices.get(a.key);
  return p != null && Number.isFinite(p) && p > 0 ? p : undefined;
}

export function resolveTarget(ctx: Context, query: string): Target | string {
  const q = query.trim().toUpperCase().replace(/\/HUF$/, "");
  if (q !== "HUF" && /^[A-Z]{3}$/.test(q) && ctx.fx[q])
    return { key: q, label: `${q}/HUF`, currency: "HUF", fx: true };
  const exact = ctx.instruments.filter(
    (i) => i.ticker?.toUpperCase() === q || i.isin?.toUpperCase() === q || i.key.toUpperCase() === q,
  );
  const byName = exact.length
    ? exact
    : ctx.instruments.filter((i) => i.name.toUpperCase().includes(q));
  const found = byName.filter((i) => ctx.prices.has(i.key));
  if (found.length === 1) {
    const i = found[0];
    return { key: i.key, label: i.ticker ?? i.name, currency: i.currency, fx: false };
  }
  if (found.length > 1)
    return `Több papír is illik rá (${found.slice(0, 4).map((i) => esc(i.ticker ?? i.name)).join(", ")}) – add meg a tickert vagy az ISIN-t.`;
  return byName.length
    ? `A(z) ${esc(query)} papírnak nincs árfolyama, így nem tudom figyelni.`
    : `Nem ismerem ezt a papírt vagy devizát: ${esc(query)}`;
}

const parseLevel = (s: string) => {
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const HELP = [
  "Új riasztás: <code>/riasztas VWCE 100 alatt</code> vagy <code>/riasztas EUR 400 felett</code>",
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

export function priceAlertCommand(
  ctx: Context,
  args: string,
  alerts: PriceAlert[],
): { html: string; alerts: PriceAlert[] } {
  const words = args.replace(/([<>])/g, " $1 ").trim().split(/\s+/).filter(Boolean);
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

  const opIdx = words.findIndex((w, i) => i > 0 && (BELOW.test(w) || ABOVE.test(w)));
  const level = opIdx > 0 ? parseLevel(words.filter((_, i) => i > 0 && i !== opIdx).join("")) : undefined;
  if (opIdx < 0 || level == null)
    return { html: `❌ Ezt nem értem: <code>${esc(args.trim())}</code>\n\n${HELP}`, alerts };
  const op: PriceAlert["op"] = BELOW.test(words[opIdx]) ? "below" : "above";

  const target = resolveTarget(ctx, words[0]);
  if (typeof target === "string") return { html: `❌ ${target}`, alerts };
  const now = alertPrice(ctx, target)!;
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
  return {
    html: `🔔 Rendben: szólok, ha a(z) ${esc(target.label)} ${levelText(target, level)} ${opText(op)} megy (most ${levelText(target, now)}).`,
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
