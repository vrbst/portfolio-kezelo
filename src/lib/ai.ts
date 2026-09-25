import type { PortfolioSummary, ReturnMetrics } from "./portfolio";
import {
  allocationByClass,
  allocationByCurrency,
  assetClassOf,
} from "./portfolio";
import { assetClassLabel } from "./labels";
import type { GoalProgress } from "./goals";
import type { Alert } from "./alerts";
import type { TbszStatus } from "./tbsz";
import type { UpcomingEvent } from "./events";
import type { SavingsProgress } from "./savings";
import type { DriftRow } from "./allocation";
import type { ValuePoint } from "./series";
import type { DayChange } from "./store";
// The SDK is loaded on first use (dynamic import → its own chunk), so it
// doesn't weigh on the app's startup; only the types are static.
type AnthropicSdk = typeof import("@anthropic-ai/sdk").default;
let sdk: Promise<AnthropicSdk> | null = null;
const loadSdk = () =>
  (sdk ??= import("@anthropic-ai/sdk").then((m) => m.default));
import type {
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * Browser-direct Claude API client + compact portfolio context builder.
 *
 * The app is static (GitHub Pages, no backend), so we call the Anthropic API
 * straight from the browser with the user's own key. The key lives only in this
 * device's localStorage (like the sync token) and is NEVER synced to the cloud.
 * The `anthropic-dangerous-direct-browser-access` header opts into browser CORS.
 *
 * Token budget: we only ever send a pre-aggregated snapshot (totals, allocation
 * %, top holdings, returns, goals, alerts, upcoming events, TBSZ status) — never
 * raw transactions — so a call is a few thousand input tokens at most.
 *
 * Responses stream (SSE) so text appears as it's generated, and capable models
 * run with adaptive thinking for more nuanced analysis. Each call's token usage
 * is turned into an estimated cost and accumulated per month in localStorage —
 * the API has no way to read a key's remaining prepaid balance, so a local
 * spend estimate is the closest useful thing.
 */

const KEY = "pf-ai-key";
const MODEL_KEY = "pf-ai-model";
const SPEND_KEY = "pf-ai-spend";

export interface AiModelInfo {
  id: string;
  label: string;
  hint: string;
  /** USD per 1M input / output / cache-read tokens (first-party API rates). */
  inPrice: number;
  outPrice: number;
  cacheReadPrice: number;
  /** Model supports adaptive thinking + effort (Haiku 4.5 does not). */
  thinking: boolean;
  /**
   * Opt into server-side refusal fallbacks (`fallbacks: "default"`): if the
   * model's safety classifier declines, the API re-runs the request on
   * Anthropic's recommended fallback model instead of returning a refusal.
   */
  fallback: boolean;
}

/**
 * Models the user can pick from in Settings (stored per-device). Deep/quality
 * default: Opus 5 with adaptive thinking. Prices are first-party API $/1M.
 */
export const AI_MODELS: readonly AiModelInfo[] = [
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    hint: "A legképesebb modell, a legmélyebb elemzéshez. A legdrágább (az Opus 5 kétszerese).",
    inPrice: 10,
    outPrice: 50,
    cacheReadPrice: 0.25,
    thinking: true,
    fallback: true,
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    hint: "A legújabb Opus: erősebb és olcsóbb az Opus 5-nél, adaptív gondolkodással.",
    inPrice: 4,
    outPrice: 20,
    cacheReadPrice: 0.2,
    thinking: true,
    fallback: true,
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    hint: "Erős, árnyalt elemzés adaptív gondolkodással (~pár cent/hívás).",
    inPrice: 5,
    outPrice: 25,
    cacheReadPrice: 0.5,
    thinking: true,
    fallback: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    hint: "Kiegyensúlyozott minőség és ár, gondolkodással. Legtöbb kérdéshez elég.",
    inPrice: 2,
    outPrice: 10,
    cacheReadPrice: 0.2,
    thinking: true,
    fallback: false,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    hint: "Leggyorsabb és legolcsóbb, rövid összefoglalókhoz. Gondolkodás nélkül.",
    inPrice: 1,
    outPrice: 5,
    cacheReadPrice: 0.1,
    thinking: false,
    fallback: false,
  },
] as const;

/** Default model: Opus 5 (deep/quality). */
export const AI_MODEL = "claude-opus-5";

export function modelInfo(id: string): AiModelInfo {
  return AI_MODELS.find((m) => m.id === id) ?? AI_MODELS[0];
}

export function modelLabel(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id;
}

export function loadAiKey(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveAiKey(v: string) {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function loadAiModel(): string {
  try {
    const m = localStorage.getItem(MODEL_KEY);
    if (m && AI_MODELS.some((x) => x.id === m)) return m;
  } catch {
    /* ignore */
  }
  return AI_MODEL;
}

export function saveAiModel(id: string) {
  try {
    localStorage.setItem(MODEL_KEY, id);
  } catch {
    /* ignore */
  }
}

// ---- Estimated spend tracking (local, per calendar month) -----------------

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated USD cost of this single call. */
  costUsd: number;
}

export interface AiSpend {
  /** Current month key (YYYY-MM). */
  month: string;
  /** Estimated USD spent this month. */
  monthUsd: number;
  /** Estimated USD spent all-time. */
  allTimeUsd: number;
}

function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type SpendStore = { allTime: number; months: Record<string, number> };

function readSpendStore(): SpendStore {
  try {
    const raw = localStorage.getItem(SPEND_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SpendStore>;
      return { allTime: s.allTime ?? 0, months: s.months ?? {} };
    }
  } catch {
    /* ignore */
  }
  return { allTime: 0, months: {} };
}

/** Add one call's estimated cost to the running local totals. */
export function recordSpend(costUsd: number) {
  if (!(costUsd > 0)) return;
  try {
    const s = readSpendStore();
    const mk = monthKey();
    s.months[mk] = (s.months[mk] ?? 0) + costUsd;
    s.allTime += costUsd;
    localStorage.setItem(SPEND_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function loadSpend(): AiSpend {
  const s = readSpendStore();
  const mk = monthKey();
  return { month: mk, monthUsd: s.months[mk] ?? 0, allTimeUsd: s.allTime };
}

/** Clear the local estimated-spend counters (does not affect the real account). */
export function resetSpend() {
  try {
    localStorage.removeItem(SPEND_KEY);
  } catch {
    /* ignore */
  }
}

function costOf(model: string, usage: Omit<AiUsage, "costUsd">): number {
  const m = modelInfo(model);
  // Uncached input at full rate, cache reads at the model's read rate, and
  // 5-minute cache writes at 1.25× input.
  const inUsd =
    (usage.inputTokens * m.inPrice +
      usage.cacheReadTokens * m.cacheReadPrice +
      usage.cacheWriteTokens * m.inPrice * 1.25) /
    1_000_000;
  const outUsd = (usage.outputTokens * m.outPrice) / 1_000_000;
  return inUsd + outUsd;
}

// ---- Portfolio context ----------------------------------------------------

const huf = (n: number) => Math.round(n).toLocaleString("hu-HU");
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const signedHuf = (n: number) => `${n > 0 ? "+" : ""}${huf(n)}`;

/** Extra, optional context sections — richer signals beyond the snapshot. */
export interface AiContextExtras {
  dayChange?: DayChange | null;
  /** Full value series → used to derive a ~30-day trend. */
  series?: ValuePoint[];
  goals?: GoalProgress[];
  alerts?: Alert[];
  tbsz?: TbszStatus[];
  events?: UpcomingEvent[];
  /** Medium-term savings goals (target, deadline, expected fill). */
  savings?: SavingsProgress[];
  /** The Forecast page's projection (milestones + shortfall). */
  forecast?: {
    monthlySavingHuf: number;
    milestones: { years: number; real: number; pess: number; opt: number }[];
    shortfall: string | null;
  };
  /** Target allocation vs. actual. */
  drift?: DriftRow[];
  /** This month's net deposits against the monthly saving budget. */
  budget?: { monthlyHuf: number; thisMonthNetHuf: number };
  /** Passive income: last 12 months realised, next 12 months expected. */
  passive?: { last12Huf: number; next12CouponHuf: number; next12MaturityHuf: number };
}

/** ~30-day (or closest available) portfolio value change from the series. */
function trend30(series: ValuePoint[] | undefined): string | null {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  const cutoff = Date.parse(last.date) - 30 * 86_400_000;
  // Nearest sample on/before the cutoff, else the earliest we have.
  let base = series[0];
  for (const p of series) {
    if (Date.parse(p.date) <= cutoff) base = p;
    else break;
  }
  if (!base.value) return null;
  const days = Math.round(
    (Date.parse(last.date) - Date.parse(base.date)) / 86_400_000,
  );
  if (days <= 0) return null;
  // Net out deposits/withdrawals so fresh capital isn't read as performance.
  const flow = last.invested - base.invested;
  const move = last.value - base.value - flow;
  const flowTxt = flow
    ? `, a közben befizetett/kivett ${signedHuf(flow)} Ft nélkül`
    : "";
  return `Piaci érték-változás az elmúlt ~${days} napban: ${pct(move / base.value)} (${signedHuf(move)} Ft${flowTxt})`;
}

/**
 * A compact, human-readable Hungarian snapshot of the portfolio for the model.
 * Aggregated numbers only — no transaction history — to keep tokens minimal.
 * Optional `extras` fold in goals, alerts, trend, upcoming events and TBSZ.
 */
export function buildAiPortfolioContext(
  summary: PortfolioSummary,
  fx: Record<string, number>,
  returns: ReturnMetrics,
  extras?: AiContextExtras,
): string {
  const total = summary.totalValueHuf || 1;

  const byClass = allocationByClass(summary)
    .map(
      (s) =>
        `${assetClassLabel[s.key as keyof typeof assetClassLabel] ?? s.key}: ${pct(s.value / total)}`,
    )
    .join(", ");

  const byCcy = allocationByCurrency(summary, fx)
    .map((s) => `${s.key}: ${pct(s.value / total)}`)
    .join(", ");

  const holdings = summary.accounts
    .flatMap((a) => a.holdings)
    .filter((h) => (h.marketValueHuf ?? 0) > 0)
    .sort((a, b) => (b.marketValueHuf ?? 0) - (a.marketValueHuf ?? 0))
    .slice(0, 8)
    .map((h) => {
      const name = h.instrument?.name ?? h.instrumentKey;
      const cls = assetClassLabel[assetClassOf(h.instrument)] ?? "";
      const w = pct((h.marketValueHuf ?? 0) / total);
      const pl =
        h.costBasisHuf > 0 && h.unrealizedPlHuf != null
          ? `, hozam ${pct(h.unrealizedPlHuf / h.costBasisHuf)}`
          : "";
      return `- ${name} [${cls}]: ${huf(h.marketValueHuf ?? 0)} Ft (súly ${w}${pl})`;
    })
    .join("\n");

  // Which account holds what (TBSZ vintage included) — the model can't tell
  // otherwise which positions are tax-sheltered.
  const accountsTxt = summary.accounts
    .filter((a) => Math.abs(a.totalValueHuf) >= 1)
    .map((a) => {
      const kind =
        a.account.kind === "tbsz"
          ? `TBSZ ${a.account.tbszYear ?? ""}`.trim()
          : a.account.kind === "treasury"
            ? "Államkincstár"
            : a.account.kind === "cash"
              ? "pénzszámla"
              : "normál";
      const names = a.holdings
        .filter((h) => (h.marketValueHuf ?? 0) > 0)
        .map((h) => h.instrument?.name ?? h.instrumentKey)
        .join(", ");
      return `- ${a.account.name} [${kind}]: ${huf(a.totalValueHuf)} Ft${names ? ` — ${names}` : ""}`;
    })
    .join("\n");

  const lines: (string | null)[] = [
    `Összérték: ${huf(summary.totalValueHuf)} Ft`,
    `Befektetett tőke: ${huf(summary.netDepositedHuf)} Ft`,
    `Teljes hozam: ${huf(summary.totalPlHuf)} Ft (${pct(summary.totalReturnPct)})`,
    `Nem realizált: ${huf(summary.unrealizedPlHuf)} Ft · Realizált: ${huf(summary.realizedPlHuf)} Ft · Kapott kamat: ${huf(summary.interestHuf)} Ft`,
    `Készpénz: ${huf(summary.cashValueHuf)} Ft (${pct(summary.cashValueHuf / total)})`,
    returns.xirrPct != null
      ? `XIRR (pénzsúlyozott): évesítve ${pct(returns.xirrPct)}${
          returns.xirrCumulativePct != null
            ? `, a teljes időszakra ${pct(returns.xirrCumulativePct)}`
            : ""
        }`
      : null,
    returns.twrPct != null
      ? `TWR (idősúlyozott): évesítve ${pct(returns.twrPct)}${
          returns.twrCumulativePct != null
            ? `, a teljes időszakra ${pct(returns.twrCumulativePct)}`
            : ""
        }`
      : null,
    `Adatsor hossza: ${returns.days} nap${
      returns.days < 365
        ? " (egy évnél rövidebb: az évesített érték felnagyít, a teljes időszakra vetítettet érdemes hangsúlyozni)"
        : ""
    }`,
    extras?.dayChange
      ? `Utolsó napi változás: ${signedHuf(extras.dayChange.abs)} Ft${
          extras.dayChange.pct != null ? ` (${pct(extras.dayChange.pct)})` : ""
        } — ${extras.dayChange.note}`
      : null,
    trend30(extras?.series),
    "",
    `Allokáció eszköztípus szerint: ${byClass}`,
    `Allokáció deviza szerint: ${byCcy}`,
    "",
    "Legnagyobb pozíciók:",
    holdings || "- (nincs nyitott pozíció)",
    "",
    "Számlák (melyik eszköz hol van):",
    accountsTxt || "- (nincs számla)",
  ];

  // --- Target allocation drift ---
  if (extras?.drift?.length) {
    lines.push("", "Cél-allokáció vs. tény (a kezelt eszközosztályokon belül):");
    for (const r of extras.drift)
      lines.push(
        `- ${assetClassLabel[r.key] ?? r.key}: cél ${pct(r.targetPct)}, tény ${pct(r.actualPct)} (${signedHuf(r.driftHuf)} Ft)`,
      );
  }

  // --- Monthly saving budget ---
  if (extras?.budget && extras.budget.monthlyHuf > 0)
    lines.push(
      "",
      `Havi megtakarítási keret: ${huf(extras.budget.monthlyHuf)} Ft, ebben a hónapban eddig nettó befizetve ${huf(extras.budget.thisMonthNetHuf)} Ft`,
    );

  // --- Passive income ---
  if (extras?.passive)
    lines.push(
      "",
      `Passzív jövedelem: az elmúlt 12 hónapban ${huf(extras.passive.last12Huf)} Ft (kamat + osztalék); a következő 12 hónapban várható ${huf(extras.passive.next12CouponHuf)} Ft kamat és ${huf(extras.passive.next12MaturityHuf)} Ft lejáró tőke`,
    );

  // --- Forecast ---
  if (extras?.forecast) {
    const f = extras.forecast;
    lines.push(
      "",
      `Előrejelzés (az app Előrejelzés oldala, névleges Ft, havi ${huf(f.monthlySavingHuf)} Ft megtakarítással):`,
    );
    for (const m of f.milestones)
      lines.push(
        `- +${m.years} év: reális ${huf(m.real)} Ft (sáv ${huf(m.pess)}–${huf(m.opt)})`,
      );
    if (f.shortfall)
      lines.push(`- FIGYELEM: ${f.shortfall}-ban elfogy a likvid pénz (kötvényeken kívül)`);
  }

  // --- Medium-term savings goals ---
  if (extras?.savings?.length) {
    lines.push("", "Középtávú célok:");
    for (const s of extras.savings)
      lines.push(
        `- ${s.goal.name}: cél ${huf(s.targetHuf)} Ft ${s.goal.targetDate}-ig, most ${pct(s.progressPct)}, a határidőre várhatóan ${pct(s.projectedPct)}${s.reached ? " (teljesül)" : `, havi szükséges ${huf(s.monthlyNeededHuf)} Ft, ebben a hónapban befizetve ${huf(s.thisMonthNetHuf)} Ft`}`,
      );
  }

  // --- Savings goals (DCA) ---
  if (extras?.goals?.length) {
    lines.push("", "Rendszeres vásárlási célok (aktuális időszak):");
    for (const g of extras.goals) {
      const state = g.done
        ? "teljesítve"
        : `hátra ${huf(g.remainingHuf)} Ft`;
      lines.push(
        `- ${g.instrumentName} (${g.periodLabel}): ${huf(g.investedHuf)}/${huf(g.targetHuf)} Ft — ${pct(g.ratio)}, ${state}`,
      );
    }
  }

  // --- Active alerts ---
  if (extras?.alerts?.length) {
    lines.push("", "Aktív figyelmeztetések:");
    for (const a of extras.alerts.slice(0, 8)) {
      lines.push(`- [${a.severity}] ${a.title}${a.detail ? `: ${a.detail}` : ""}`);
    }
  }

  // --- Upcoming events (bond maturities, coupons, TBSZ dates) ---
  if (extras?.events?.length) {
    lines.push("", "Közelgő események:");
    for (const e of extras.events.slice(0, 8)) {
      const amt = e.amountHuf ? ` (~${huf(e.amountHuf)} Ft)` : "";
      lines.push(`- ${e.date} · ${e.daysUntil} nap múlva: ${e.title}${amt}`);
    }
  }

  // --- TBSZ tax status ---
  if (extras?.tbsz?.length) {
    lines.push("", "TBSZ számlák állapota:");
    for (const t of extras.tbsz) {
      const nextTxt =
        t.next && t.daysToNext != null
          ? `, következő mérföldkő: ${t.next.label} (${t.daysToNext} nap)`
          : "";
      lines.push(
        `- ${t.year}. évi gyűjtő: ${t.phaseLabel}, adóteher most töréskor ${t.taxLabel}${nextTxt}`,
      );
    }
  }

  return lines.filter((l): l is string => l != null).join("\n");
}

const SYSTEM = `Magyar pénzügyi asszisztens vagy egy személyes, lakossági portfólió-követő appban. Megkapod a felhasználó portfóliójának számszerű pillanatképét (forintban), és ahol van adat, a megtakarítási céljait, aktív figyelmeztetéseit, közelgő eseményeit (kötvény-lejáratok, kuponok) és a TBSZ-számlái adózási állapotát is. Tömören, magyarul, közérthetően válaszolj. Kizárólag a megadott adatokra támaszkodj — soha ne találj ki számokat, és ha valami nem derül ki az adatokból, mondd ki őszintén. Használd ki a gazdagabb adatokat: ha van cél, értékeld hogy jó úton van-e; ha van figyelmeztetés vagy közelgő lejárat, térj ki rá; a trend és a TBSZ-adómentességi mérföldkövek relevánsak lehetnek. Ne adj konkrét vételi/eladási utasítást; inkább összefüggéseket, kockázatokat, koncentrációt és megfontolandó szempontokat emelj ki. Egyszerű szöveget használj: rövid bekezdések vagy "- " kezdetű felsorolás, NE használj markdown fejlécet vagy csillagos kiemelést. A forint/euró összegek a felhasználó valós egyenlegei — kezeld diszkréten.`;

/** Prompt for the forecast page's narrative — reasons over projected numbers. */
export const FORECAST_PROMPT =
  "A fenti számok egy előrejelzésből származnak (nem te számoltad). Írj rövid, személyes hangvételű értékelést 4–6 felsorolási pontban: mit mutat a reális pálya, mennyit tesz hozzá a havi megtakarítás vs. a meglévő tőke hozama, mekkora a bizonytalanság a sáv alapján, hogyan hatnak a betervezett kiadások és a rendszeres kivét (ha van), elérhető-e a célösszeg (ha van), és 1–2 gyakorlati megfontolás (pl. érdemes-e emelni a havi félretett összeget). Ha a likvid rész elfogy, ezt emeld ki elsőként. Csak a megadott számokra támaszkodj, ne találj ki újakat. Ne adj konkrét vételi/eladási utasítást.";

// ---- Limits & opt-in switches ---------------------------------------------

const LIMITS_KEY = "pf-ai-limits";
const TOGGLES_KEY = "pf-ai-toggles";

/** Guard rails so a chat (especially with tools) can't run away with tokens. */
export interface AiLimits {
  /** Estimated USD per calendar month; calls are refused above it. */
  monthlyUsd: number;
  /** Estimated USD per single question/analysis, tool rounds included. */
  perQuestionUsd: number;
  /** Max tool-use rounds per question. */
  maxToolRounds: number;
  /** Max web searches per question (server-side limit). */
  webSearchMaxUses: number;
  /** Max questions in one conversation (history grows the input each turn). */
  maxChatTurns: number;
}

export const DEFAULT_LIMITS: AiLimits = {
  monthlyUsd: 5,
  perQuestionUsd: 0.5,
  maxToolRounds: 5,
  webSearchMaxUses: 3,
  maxChatTurns: 20,
};

export function loadAiLimits(): AiLimits {
  try {
    const raw = localStorage.getItem(LIMITS_KEY);
    if (raw)
      return { ...DEFAULT_LIMITS, ...(JSON.parse(raw) as Partial<AiLimits>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_LIMITS };
}

export function saveAiLimits(l: AiLimits) {
  try {
    localStorage.setItem(LIMITS_KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

/** Opt-in capabilities — both OFF by default. */
export interface AiToggles {
  /** Let the model call the app's tools (sends the specific data it asks for). */
  tools: boolean;
  /** Let the model search the web (≈1 cent per search). */
  web: boolean;
}

export function loadAiToggles(): AiToggles {
  try {
    const raw = localStorage.getItem(TOGGLES_KEY);
    if (raw)
      return {
        tools: false,
        web: false,
        ...(JSON.parse(raw) as Partial<AiToggles>),
      };
  } catch {
    /* ignore */
  }
  return { tools: false, web: false };
}

export function saveAiToggles(t: AiToggles) {
  try {
    localStorage.setItem(TOGGLES_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

/** Refused because a spend limit is reached (shown as-is in the UI). */
export class AiLimitError extends Error {}

/** USD per web search (first-party rate: $10 / 1000 searches). */
const WEB_SEARCH_USD = 0.01;

// ---- Claude API (official SDK, streaming) -----------------------------------

/** A web source the model looked at (from web search results). */
export interface AiSource {
  title: string;
  url: string;
}

export interface RunResult {
  /** Assistant (and tool-result) turns to append to the history, in order. */
  appended: BetaMessageParam[];
  /** The final visible answer. */
  text: string;
  costUsd: number;
  sources: AiSource[];
  /** Why the run stopped early, if it did (limit reached, length cut). */
  note?: string;
}

/** Tool-use instructions, a second (stable) system block when tools are on. */
function toolsSystem(web: boolean): string {
  return `Eszközöket is használhatsz: az app saját függvényeit (előrejelzés futtatása módosított feltételekkel, pozíciók számlánként, tranzakciók, árfolyam- és vagyon-előzmény, várható pénzáramlás)${
    web
      ? ", valamint webes keresést friss piaci információhoz (árfolyamok, kamatok, hírek) — ilyenkor nevezd meg a forrást"
      : ""
  }. Csak akkor hívd őket, ha a kérdés megválaszolásához ténylegesen kell a pillanatképen túli adat vagy számítás — egy jól megválasztott hívás többet ér, mint sok. Az eszközök eredményét ugyanúgy kezeld, mint a pillanatképet: ne találj ki számokat.`;
}

function systemBlocks(
  context: string,
  tools: boolean,
  web: boolean,
): BetaTextBlockParam[] {
  const blocks: BetaTextBlockParam[] = [{ type: "text", text: SYSTEM }];
  if (tools || web) blocks.push({ type: "text", text: toolsSystem(web) });
  // The snapshot goes last and carries the cache breakpoint: every later
  // turn of the conversation re-reads system + snapshot from cache.
  blocks.push({
    type: "text",
    text: `--- Portfólió pillanatkép ---\n${context}`,
    cache_control: { type: "ephemeral" },
  });
  return blocks;
}

function usageCost(model: string, u: BetaUsage | undefined): number {
  if (!u) return 0;
  return (
    costOf(model, {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    }) +
    (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
  );
}

/**
 * One question (or analysis) through the official SDK, streaming. Runs the
 * tool loop when tools are enabled: client tools execute in the browser via
 * `onToolCall`, web search runs server-side. Enforces the spend limits: it
 * refuses above the monthly budget, and once a question's cost or tool rounds
 * hit their limit, pending calls get an error result and the model has to
 * answer from what it has (tool_choice none). Every call's estimated cost is
 * recorded.
 */
export async function runClaude(opts: {
  key: string;
  model: string;
  context: string;
  /** Full history, ending with the new user message. */
  messages: BetaMessageParam[];
  tools?: BetaTool[];
  /** Executes a client tool call → tool_result content. */
  onToolCall?: (
    name: string,
    input: unknown,
  ) => { content: string; isError: boolean };
  web?: boolean;
  /** JSON schema for a structured answer (analysis cards). */
  format?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /** A tool call or web search started (for the UI chips). */
  onActivity?: (a: {
    kind: "tool" | "search";
    name: string;
    input: unknown;
  }) => void;
}): Promise<RunResult> {
  const limits = loadAiLimits();
  if (loadSpend().monthUsd >= limits.monthlyUsd)
    throw new AiLimitError(
      `Elérted a havi AI-keretet (${limits.monthlyUsd} $). A Beállításokban emelheted, vagy várj a következő hónapig.`,
    );

  const info = modelInfo(opts.model);
  const Anthropic = await loadSdk();
  const client = new Anthropic({
    apiKey: opts.key,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
  const clientTools = opts.tools ?? [];
  const webTool: BetaToolUnion = info.thinking
    ? {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: limits.webSearchMaxUses,
      }
    : {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: limits.webSearchMaxUses,
      };
  const tools: BetaToolUnion[] = [
    ...clientTools.map((t) => ({ ...t, eager_input_streaming: true })),
    ...(opts.web ? [webTool] : []),
  ];
  const system = systemBlocks(
    opts.context,
    clientTools.length > 0,
    !!opts.web,
  );
  // Thinking tokens count toward max_tokens: give thinking models room.
  const maxTokens = info.thinking
    ? Math.max(opts.maxTokens ?? 0, 16000)
    : (opts.maxTokens ?? 1500);
  const format = opts.format
    ? { format: { type: "json_schema" as const, schema: opts.format } }
    : {};

  const history = [...opts.messages];
  const appended: BetaMessageParam[] = [];
  const sources: AiSource[] = [];
  let cost = 0;
  let rounds = 0;
  let finalText = "";
  let note: string | undefined;
  let useFallback = info.fallback;
  let noMoreTools = false;

  for (let guard = 0; guard < limits.maxToolRounds + 6; guard++) {
    let message: BetaMessage;
    let turnText = "";
    try {
      const stream = client.beta.messages.stream(
        {
          model: opts.model,
          max_tokens: maxTokens,
          system,
          messages: history,
          ...(tools.length ? { tools } : {}),
          // Out of budget: keep the (append-only) tool set, forbid calls.
          ...(tools.length && noMoreTools
            ? { tool_choice: { type: "none" as const } }
            : {}),
          ...(info.thinking
            ? {
                thinking: {
                  type: "adaptive" as const,
                  display: "summarized" as const,
                },
                output_config: { effort: "high" as const, ...format },
              }
            : opts.format
              ? { output_config: format }
              : {}),
          ...(useFallback
            ? {
                betas: ["server-side-fallback-2026-07-01"],
                fallbacks: "default" as const,
              }
            : {}),
        },
        { signal: opts.signal },
      );
      stream.on("text", (d) => {
        turnText += d;
        opts.onText?.(d);
      });
      stream.on("thinking", (d) => opts.onThinking?.(d));
      stream.on("contentBlock", (b) => {
        if (b.type === "server_tool_use")
          opts.onActivity?.({ kind: "search", name: b.name, input: b.input });
      });
      message = await stream.finalMessage();
    } catch (e) {
      // The fallback opt-in is a beta: if it's rejected, go without it.
      if (
        useFallback &&
        e instanceof Anthropic.BadRequestError &&
        /fallback/i.test(e.message)
      ) {
        useFallback = false;
        continue;
      }
      throw friendlyError(Anthropic, e);
    }

    const c = usageCost(opts.model, message.usage);
    cost += c;
    recordSpend(c);

    if (message.stop_reason === "refusal")
      throw new Error(
        "A modell elutasította a kérést. Fogalmazd át, vagy próbáld másik modellel.",
      );

    history.push({ role: "assistant", content: message.content });
    appended.push({ role: "assistant", content: message.content });
    for (const b of message.content)
      if (b.type === "web_search_tool_result" && Array.isArray(b.content))
        for (const r of b.content)
          if (!sources.some((s) => s.url === r.url))
            sources.push({ title: r.title, url: r.url });
    if (turnText.trim()) finalText = turnText;

    // A long server-side search turn paused: resend to let it continue.
    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason === "max_tokens") {
      note = "A válasz a hosszkorlát miatt megszakadt.";
      break;
    }
    const toolUses = message.content.filter(
      (b): b is BetaToolUseBlock => b.type === "tool_use",
    );
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

    rounds++;
    const overBudget = cost >= limits.perQuestionUsd;
    const overRounds = rounds >= limits.maxToolRounds;
    const results: BetaToolResultBlockParam[] = toolUses.map((tu) => {
      if (overBudget || overRounds || !opts.onToolCall)
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          is_error: true,
          content:
            "Elérted a kérdésenkénti keretet, további eszközhívás nem lehetséges. Válaszolj a már meglévő adatokból.",
        };
      opts.onActivity?.({ kind: "tool", name: tu.name, input: tu.input });
      const r = opts.onToolCall(tu.name, tu.input);
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError,
      };
    });
    if (overBudget || overRounds) {
      noMoreTools = true;
      note = overBudget
        ? `Elérted a kérdésenkénti keretet (${limits.perQuestionUsd} $), a válasz a már lekért adatokból készült.`
        : `Elérted az eszközhívások számának korlátját (${limits.maxToolRounds}), a válasz a már lekért adatokból készült.`;
    }
    const msg: BetaMessageParam = { role: "user", content: results };
    history.push(msg);
    appended.push(msg);
  }

  return {
    appended,
    text: finalText.trim() || "(üres válasz)",
    costUsd: cost,
    sources,
    note,
  };
}

/** Map SDK errors to short Hungarian messages (typed, not string matching). */
function friendlyError(Anthropic: AnthropicSdk, e: unknown): Error {
  if (e instanceof Anthropic.APIUserAbortError) return new Error("Leállítva.");
  if (e instanceof Anthropic.AuthenticationError)
    return new Error("Érvénytelen API-kulcs.");
  if (e instanceof Anthropic.RateLimitError)
    return new Error(
      "Túl sok kérés vagy elfogyott az egyenleg. Próbáld újra később.",
    );
  if (e instanceof Anthropic.InternalServerError)
    return new Error("Az API most túlterhelt, próbáld újra pár perc múlva.");
  if (e instanceof Anthropic.APIConnectionError)
    return new Error("Nem sikerült kapcsolódni az API-hoz (hálózati hiba).");
  if (e instanceof Anthropic.APIError)
    return new Error(e.message || `API hiba (${e.status})`);
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Single prompt in, full text out (streaming under the hood, no tools). Used
 * by the Forecast page's narrative.
 */
export async function callClaude(opts: {
  key: string;
  context: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const r = await runClaude({
    key: opts.key,
    model: opts.model ?? AI_MODEL,
    context: opts.context,
    messages: [{ role: "user", content: opts.prompt }],
    maxTokens: opts.maxTokens,
    signal: opts.signal,
  });
  return r.note ? `${r.text}\n\n(${r.note})` : r.text;
}
