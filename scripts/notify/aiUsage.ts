import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AiModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  costUsd: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  turns?: number;
  durationMs?: number;
  costUsd?: number;
  models?: Record<string, AiModelUsage>;
}

export interface AiUsageRecord extends AiUsage {
  at: string;
  job: string;
  model: string;
  ok: boolean;
  error?: string;
}

export const AI_USAGE_KEEP_DAYS = 180;
export const AI_USAGE_MAX_LINES = 5000;

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const optNum = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const obj = (x: unknown): Record<string, unknown> =>
  x != null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

export function usageFromClaudeResult(raw: unknown): AiUsage {
  const r = obj(raw);
  const u = obj(r.usage);
  const tools = obj(u.server_tool_use);
  const models: Record<string, AiModelUsage> = {};
  for (const [name, v] of Object.entries(obj(r.modelUsage))) {
    const m = obj(v);
    models[name] = {
      inputTokens: num(m.inputTokens),
      outputTokens: num(m.outputTokens),
      cacheCreationTokens: num(m.cacheCreationInputTokens),
      cacheReadTokens: num(m.cacheReadInputTokens),
      webSearches: num(m.webSearchRequests),
      costUsd: num(m.costUSD),
    };
  }
  const out: AiUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    webSearches: num(tools.web_search_requests),
  };
  const turns = optNum(r.num_turns);
  const durationMs = optNum(r.duration_ms);
  const costUsd = optNum(r.total_cost_usd);
  if (turns != null) out.turns = turns;
  if (durationMs != null) out.durationMs = durationMs;
  if (costUsd != null) out.costUsd = costUsd;
  if (Object.keys(models).length) out.models = models;
  return out;
}

export function usageFromClaudeOutput(stdout: string): AiUsage | undefined {
  try {
    return usageFromClaudeResult(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}

function isRecord(x: unknown): x is AiUsageRecord {
  const r = obj(x);
  return typeof r.at === "string" && typeof r.job === "string" && typeof r.ok === "boolean";
}

export function readAiUsage(file: string): AiUsageRecord[] {
  try {
    if (!existsSync(file)) return [];
    const out: AiUsageRecord[] = [];
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r: unknown = JSON.parse(line);
        if (isRecord(r)) out.push(r);
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function trimAiUsage(records: AiUsageRecord[], now: Date): AiUsageRecord[] {
  const cutoff = now.getTime() - AI_USAGE_KEEP_DAYS * 86_400_000;
  return records.filter((r) => Date.parse(r.at) >= cutoff).slice(-AI_USAGE_MAX_LINES);
}

export function appendAiUsage(file: string, record: AiUsageRecord, now = new Date()): void {
  try {
    const kept = trimAiUsage([...readAiUsage(file), record], now);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    renameSync(tmp, file);
  } catch (e) {
    console.error("ai-usage: write failed:", (e as Error).message);
  }
}

export interface AiUsageTotals {
  runs: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  costUsd: number;
}

const emptyTotals = (): AiUsageTotals => ({
  runs: 0,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  webSearches: 0,
  costUsd: 0,
});

function add(t: AiUsageTotals, r: AiUsageRecord): void {
  t.runs++;
  if (!r.ok) t.failed++;
  t.inputTokens += num(r.inputTokens);
  t.outputTokens += num(r.outputTokens);
  t.cacheCreationTokens += num(r.cacheCreationTokens);
  t.cacheReadTokens += num(r.cacheReadTokens);
  t.webSearches += num(r.webSearches);
  t.costUsd += num(r.costUsd);
}

export interface AiUsageSummary {
  total: AiUsageTotals;
  byJob: Record<string, AiUsageTotals>;
  byModel: Record<string, AiUsageTotals>;
}

export function inWindow(records: AiUsageRecord[], now: Date, fromDaysAgo: number, toDaysAgo = 0): AiUsageRecord[] {
  const from = now.getTime() - fromDaysAgo * 86_400_000;
  const to = now.getTime() - toDaysAgo * 86_400_000;
  return records.filter((r) => {
    const t = Date.parse(r.at);
    return t > from && t <= to;
  });
}

export function summarizeAiUsage(records: AiUsageRecord[]): AiUsageSummary {
  const s: AiUsageSummary = { total: emptyTotals(), byJob: {}, byModel: {} };
  for (const r of records) {
    add(s.total, r);
    add((s.byJob[r.job] ??= emptyTotals()), r);
    add((s.byModel[r.model] ??= emptyTotals()), r);
  }
  return s;
}

const JOB_LABEL: Record<string, string> = {
  "news-morning": "Reggeli hírek",
  "news-evening": "Esti hírek",
  hirkereses: "/hirkereses",
  "news-why": "Miért mozdult?",
};

const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} M` : n >= 1e3 ? `${Math.round(n / 1e3)} e` : `${Math.round(n)}`;
export const usd = (n: number) => `$${n.toFixed(2).replace(".", ",")}`;

function totalsLines(t: AiUsageTotals): string[] {
  const io = t.inputTokens + t.outputTokens;
  const cache = t.cacheCreationTokens + t.cacheReadTokens;
  return [
    `${t.runs} futás${t.failed ? ` (${t.failed} sikertelen)` : ""}, ~${usd(t.costUsd)} (átl. ${usd(t.costUsd / t.runs)})`,
    `token: ${tokens(io)} be+ki (átl. ${tokens(io / t.runs)}), cache ${tokens(cache)}${t.webSearches ? `, ${t.webSearches} webes keresés` : ""}`,
  ];
}

function periodBlock(title: string, records: AiUsageRecord[]): string[] {
  const s = summarizeAiUsage(records);
  if (!s.total.runs) return [`<b>${title}</b>`, "Nem volt AI-futás."];
  const out = [`<b>${title}</b>`, ...totalsLines(s.total)];
  for (const [job, t] of Object.entries(s.byJob).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
    const [first, second] = totalsLines(t);
    out.push(`• ${JOB_LABEL[job] ?? job}: ${first}`, `  ${second}`);
  }
  const models = Object.entries(s.byModel);
  out.push(
      "Modellenként: " +
        models
          .sort((a, b) => b[1].costUsd - a[1].costUsd)
          .map(([m, t]) => `${m || "?"} ${t.runs}× ~${usd(t.costUsd)}`)
          .join(", "),
    );
  return out;
}

export function aiCostText(records: AiUsageRecord[], now: Date): string {
  return [
    "🤖 <b>AI-felhasználás</b>",
    "",
    ...periodBlock("Elmúlt 7 nap", inWindow(records, now, 7)),
    "",
    ...periodBlock("Elmúlt 30 nap", inWindow(records, now, 30)),
    "",
    "<i>A $ csak tájékoztató („API-áron ennyi lett volna”): a futások az előfizetés keretéből mennek.</i>",
  ].join("\n");
}

export function weeklyAiLine(records: AiUsageRecord[] | undefined, now: Date): string | null {
  if (!records?.length) return null;
  const week = summarizeAiUsage(inWindow(records, now, 7)).total;
  if (!week.runs) return null;
  const prev = summarizeAiUsage(inWindow(records, now, 14, 7)).total;
  return `🤖 AI: ${week.runs} futás, ~${usd(week.costUsd)} API-áron${prev.runs ? ` (előző hét: ${usd(prev.costUsd)})` : ""}`;
}
