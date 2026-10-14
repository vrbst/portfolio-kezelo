// Turns the pending issuer-consensus texts (issuerDocs.ts) into numbers with
// Claude Code on the subscription — no tools, only the text it is given — and
// merges them into market/outlook.json. Nothing here knows an issuer: the
// document says what it says, the checks below decide whether to believe it.

import { toLocalDay } from "../../../src/lib/day";
import {
  OUTLOOK_PATH,
  daysBetween,
  validateConsensus,
  type Consensus,
  type OutlookFile,
} from "../../../src/lib/outlook";
import type { NewsEngine } from "../news/engine";
import { extractJson, type NewsStore } from "../news/job";
import { listPending, removePending, type PendingDoc } from "./issuerDocs";
import { readOutlookFile } from "./storeFile";

const range = {
  type: "object",
  required: ["min", "avg", "max"],
  properties: {
    min: { type: "number" },
    avg: { type: "number" },
    max: { type: "number" },
    count: { type: "number" },
  },
} as const;

export const CONSENSUS_SCHEMA = {
  type: "object",
  required: ["price", "currency", "asOf", "target"],
  properties: {
    price: { type: "number" },
    currency: { type: "string" },
    asOf: { type: "string" },
    target: range,
    recent: range,
    ratings: {
      type: "object",
      required: ["buy", "hold", "sell"],
      properties: { buy: { type: "number" }, hold: { type: "number" }, sell: { type: "number" } },
    },
    estimates: {
      type: "array",
      items: {
        type: "object",
        required: ["year"],
        properties: { year: { type: "number" }, eps: { type: "number" }, dps: { type: "number" } },
      },
    },
  },
} as const;

/** Longest document text handed to the model. */
export const MAX_DOC_CHARS = 40_000;
/** The target's average may be this far from the document's own share price. */
const PRICE_RATIO: [number, number] = [0.2, 5];
const MAX_AGE_DAYS = 365;

export function buildDocPrompt(doc: PendingDoc): string {
  return [
    "Az alábbi szöveg egy kibocsátó elemzői konszenzus-dokumentumából származik (PDF-ből kinyerve, a táblázatsorok egy-egy sorban vannak). Add vissza a benne szereplő adatokat a megadott JSON-séma szerint. Semmit ne találj ki: amit a szöveg nem tartalmaz, hagyd ki.",
    "Mezők:",
    "- price: a dokumentumban szereplő aktuális részvényárfolyam (ellenőrzéshez).",
    "- currency: a célár pénzneme (pl. HUF).",
    "- asOf: a dokumentum dátuma, ÉÉÉÉ-HH-NN.",
    "- target: a TELJES konszenzus célára (min, avg, max) és a becslések száma (count).",
    "- recent: a „legfrissebb” (újabb becslésekből számolt) célár, ha külön szerepel.",
    "- ratings: a vétel/tartás/eladás ajánlások darabszáma, CSAK ha számokkal szerepel (grafikonból ne találgass).",
    "- estimates: évenként (year) az átlagos EPS és DPS a TELJES konszenzusból, a dokumentum pénznemében.",
    "FONTOS: a magyar nyelvű dokumentumban a pont ezres tagoló, nem tizedesjel: a „45.888” negyvenötezer-nyolcszáznyolcvannyolc (45888), a „4.577” négyezer-ötszázhetvenhét (4577). A tizedesvessző tizedesjel.",
    `--- Dokumentum (${doc.url}) ---`,
    doc.text.slice(0, MAX_DOC_CHARS),
  ].join("\n\n");
}

/**
 * The model's answer as a validated consensus, or an error saying why not.
 * The document's own share price is the cross-check: a target average that is
 * not near it (a thousands separator read as a decimal point) is rejected.
 */
export function consensusFromAnswer(answer: unknown, doc: PendingDoc, now: Date): Consensus {
  const a = answer as Record<string, unknown> | null;
  const price = typeof a?.price === "number" ? a.price : NaN;
  const c = validateConsensus({
    source: "issuer",
    url: doc.url,
    asOf: a?.asOf,
    currency: a?.currency,
    target: a?.target,
    recent: a?.recent,
    ratings: a?.ratings,
    estimates: a?.estimates,
  });
  if (!c) throw new Error("hiányzó vagy ellentmondó célár-adatok");
  if (!(price > 0)) throw new Error("hiányzik a dokumentum árfolyama az ellenőrzéshez");
  const near = (v: number) => v / price >= PRICE_RATIO[0] && v / price <= PRICE_RATIO[1];
  if (!near(c.target.avg)) throw new Error(`a célár (${c.target.avg}) nem fér össze a dokumentum árfolyamával (${price})`);
  if (c.recent && !near(c.recent.avg)) delete c.recent;
  const age = daysBetween(c.asOf, toLocalDay(now));
  if (age > MAX_AGE_DAYS || age < -2) throw new Error(`a dokumentum dátuma (${c.asOf}) nem hihető`);
  return c;
}

export interface DocsDeps {
  engine: NewsEngine;
  store: NewsStore;
  /** .notify/outlook: where the pending texts are. */
  dir: string;
}

export interface DocsResult {
  done: string[];
  failed: Record<string, string>;
}

async function ask(engine: NewsEngine, doc: PendingDoc, now: Date): Promise<Consensus> {
  const prompt = buildDocPrompt(doc);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await engine.run(
      attempt ? `${prompt}\n\nAz előző válaszod nem volt érvényes (${lastError}). Add vissza javítva, a séma szerint.` : prompt,
    );
    try {
      return consensusFromAnswer(extractJson(r.output), doc, now);
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`outlook-docs: ${doc.key}: invalid answer (${attempt + 1}/2): ${lastError}`);
    }
  }
  throw new Error(lastError);
}

/**
 * Every pending document → its consensus in market/outlook.json (replacing the
 * issuer's earlier one). A document that fails stays pending for the next run;
 * one of an asset that is no longer held is dropped.
 */
export async function extractPendingDocs(deps: DocsDeps, now: Date): Promise<DocsResult> {
  const result: DocsResult = { done: [], failed: {} };
  const pending = listPending(deps.dir);
  if (!pending.length) return result;
  const file = await readOutlookFile(deps.store, now);
  if (!file) return result; // nothing to merge into yet: the documents wait
  const next: OutlookFile = { ...file, updatedAt: now.toISOString(), items: { ...file.items } };
  const finished: string[] = [];
  for (const doc of pending) {
    if (!next.profiles[doc.key]) {
      removePending(deps.dir, doc.key);
      continue;
    }
    try {
      const c = await ask(deps.engine, doc, now);
      const item = next.items[doc.key] ?? {};
      next.items[doc.key] = { ...item, consensus: [c, ...(item.consensus ?? []).filter((x) => x.source !== "issuer")] };
      finished.push(doc.key);
      result.done.push(doc.key);
    } catch (e) {
      result.failed[doc.key] = (e as Error).message.slice(0, 200);
    }
  }
  if (finished.length) {
    // Outside the loop's try: a failed upload keeps the documents pending, it
    // does not drop them.
    await deps.store.write(OUTLOOK_PATH, JSON.stringify(next), `outlook konszenzus ${toLocalDay(now)}`);
    for (const k of finished) removePending(deps.dir, k);
  }
  return result;
}
