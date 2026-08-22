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
import type { ValuePoint } from "./series";
import type { DayChange } from "./store";

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
  /** USD per 1M input / output tokens (first-party API rates). */
  inPrice: number;
  outPrice: number;
  /** Model supports adaptive thinking + effort (Haiku 4.5 does not). */
  thinking: boolean;
}

/**
 * Models the user can pick from in Settings (stored per-device). Deep/quality
 * default: Opus 5 with adaptive thinking. Prices are first-party API $/1M.
 */
export const AI_MODELS: readonly AiModelInfo[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    hint: "Legerősebb, legárnyaltabb — adaptív gondolkodással. Drágább (~pár cent/hívás).",
    inPrice: 5,
    outPrice: 25,
    thinking: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    hint: "Kiegyensúlyozott minőség és ár, gondolkodással. Legtöbb kérdéshez elég.",
    inPrice: 3,
    outPrice: 15,
    thinking: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    hint: "Leggyorsabb és legolcsóbb, rövid összefoglalókhoz. Gondolkodás nélkül.",
    inPrice: 1,
    outPrice: 5,
    thinking: false,
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
  // Cache reads (if any) bill at ~0.1× input; uncached input at full rate.
  const inUsd =
    (usage.inputTokens * m.inPrice + usage.cacheReadTokens * m.inPrice * 0.1) /
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
  const change = (last.value - base.value) / base.value;
  return `Érték-változás az elmúlt ~${days} napban: ${pct(change)} (${signedHuf(last.value - base.value)} Ft)`;
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

  const lines: (string | null)[] = [
    `Összérték: ${huf(summary.totalValueHuf)} Ft`,
    `Befektetett tőke: ${huf(summary.netDepositedHuf)} Ft`,
    `Teljes hozam: ${huf(summary.totalPlHuf)} Ft (${pct(summary.totalReturnPct)})`,
    `Nem realizált: ${huf(summary.unrealizedPlHuf)} Ft · Realizált: ${huf(summary.realizedPlHuf)} Ft · Kapott kamat: ${huf(summary.interestHuf)} Ft`,
    `Készpénz: ${huf(summary.cashValueHuf)} Ft (${pct(summary.cashValueHuf / total)})`,
    returns.xirrPct != null
      ? `XIRR (évesített, pénzsúlyozott): ${pct(returns.xirrPct)}`
      : null,
    returns.twrPct != null
      ? `TWR (évesített, idősúlyozott): ${pct(returns.twrPct)}`
      : null,
    `Adatsor hossza: ${returns.days} nap`,
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
  ];

  // --- Savings goals (DCA) ---
  if (extras?.goals?.length) {
    lines.push("", "Megtakarítási célok (aktuális időszak):");
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

/** Free-form analysis prompt for the one-click button. */
export const ANALYSIS_PROMPT =
  "Adj rövid, lényegre törő értékelést a portfólióról 4–6 felsorolási pontban: diverzifikáció és koncentráció (van-e túlsúlyos pozíció), deviza-kitettség, a hozam és a közelmúlt-trend értékelése, a megtakarítási célok állása (ha van), és 1–2 megfontolandó szempont (pl. közelgő lejárat, aktív figyelmeztetés). Legyen tömör, kerüld az általános közhelyeket.";

/** Prompt for the forecast page's narrative — reasons over projected numbers. */
export const FORECAST_PROMPT =
  "A fenti számok egy determinisztikus előrejelzésből származnak (nem te számoltad). Írj rövid, személyes hangvételű értékelést 4–6 felsorolási pontban: mit mutat a reális pálya, mennyit tesz hozzá a havi megtakarítás vs. a meglévő tőke hozama, mekkora a bizonytalanság a pesszimista/optimista sáv alapján, hogyan hatnak a betervezett kiadások, és 1–2 gyakorlati megfontolás (pl. érdemes-e emelni a havi félretett összeget). Csak a megadott számokra támaszkodj, ne találj ki újakat. Ne adj konkrét vételi/eladási utasítást.";

// ---- Claude API (streaming) ----------------------------------------------

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

function apiErrorMessage(status: number, body: string): string {
  let msg = `API hiba (${status})`;
  try {
    const e = JSON.parse(body);
    if (e?.error?.message) msg = e.error.message;
  } catch {
    /* ignore parse error */
  }
  if (status === 401) msg = "Érvénytelen API-kulcs.";
  else if (status === 429) msg = "Túl sok kérés vagy elfogyott az egyenleg.";
  return msg;
}

/**
 * Stream a Claude response over SSE. Calls `onText` with each text delta as it
 * arrives; resolves with the full text plus token usage. Records estimated
 * spend automatically. Supports multi-turn conversations via `messages`.
 */
export async function streamClaude(opts: {
  key: string;
  context: string;
  messages: ChatTurn[];
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}): Promise<{ text: string; usage: AiUsage }> {
  const model = opts.model ?? AI_MODEL;
  const info = modelInfo(model);
  // Thinking tokens count toward max_tokens, so give thinking models headroom
  // even if the caller asked for a small budget.
  const maxTokens = info.thinking
    ? Math.max(opts.maxTokens ?? 0, 3500)
    : (opts.maxTokens ?? 900);

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: `${SYSTEM}\n\n--- Portfólió pillanatkép ---\n${opts.context}`,
    messages: opts.messages,
  };
  if (info.thinking) {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: "high" };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": opts.key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const txt = res.body ? await res.text() : "";
    throw new Error(apiErrorMessage(res.status, txt));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  const usage: Omit<AiUsage, "costUsd"> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  };

  const handle = (evt: {
    type?: string;
    delta?: { type?: string; text?: string; stop_reason?: string };
    message?: { usage?: Record<string, number> };
    usage?: Record<string, number>;
    error?: { message?: string };
  }) => {
    switch (evt.type) {
      case "message_start": {
        const u = evt.message?.usage;
        if (u) {
          usage.inputTokens = u.input_tokens ?? 0;
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
        }
        break;
      }
      case "content_block_delta":
        if (evt.delta?.type === "text_delta" && evt.delta.text) {
          text += evt.delta.text;
          opts.onText?.(evt.delta.text);
        }
        break;
      case "message_delta":
        if (evt.usage?.output_tokens != null)
          usage.outputTokens = evt.usage.output_tokens;
        break;
      case "error":
        throw new Error(evt.error?.message || "Streaming hiba.");
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const payload = l.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      handle(evt);
    }
  }

  const costUsd = costOf(model, usage);
  recordSpend(costUsd);
  return { text: text.trim() || "(üres válasz)", usage: { ...usage, costUsd } };
}

/**
 * Non-streaming convenience wrapper (single prompt in, full text out). Built on
 * `streamClaude`, so it still uses thinking/streaming under the hood and records
 * spend — the caller just awaits the final string. Used by the Forecast page.
 */
export async function callClaude(opts: {
  key: string;
  context: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { text } = await streamClaude({
    key: opts.key,
    context: opts.context,
    messages: [{ role: "user", content: opts.prompt }],
    model: opts.model,
    maxTokens: opts.maxTokens,
    signal: opts.signal,
  });
  return text;
}
