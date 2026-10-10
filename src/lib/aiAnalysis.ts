// Structured one-click analysis: the model answers in a fixed JSON shape
// (headline + topic cards + "what changed since last time"), which the panel
// renders as cards. The last few analyses are kept on this device so the next
// one can say what changed.

export type Status = "rendben" | "figyelj" | "teendo";
export const TOPICS = [
  "koncentracio",
  "deviza",
  "hozam",
  "celok",
  "penzaramlas",
  "allokacio",
  "tbsz",
  "egyeb",
] as const;
export type Topic = (typeof TOPICS)[number];

export interface AnalysisSection {
  topic: Topic;
  title: string;
  status: Status;
  text: string;
}

export interface Analysis {
  headline: string;
  overall: Status;
  sections: AnalysisSection[];
  /** What changed since the previous analysis ("" when there was none). */
  changes: string;
}

export interface StoredAnalysis {
  at: string;
  model: string;
  costUsd: number;
  data: Analysis;
}

const STATUS_ENUM = ["rendben", "figyelj", "teendo"];

/** JSON schema for `output_config.format` (all objects closed, all required). */
export const ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    headline: { type: "string" },
    overall: { type: "string", enum: STATUS_ENUM },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string", enum: [...TOPICS] },
          title: { type: "string" },
          status: { type: "string", enum: STATUS_ENUM },
          text: { type: "string" },
        },
        required: ["topic", "title", "status", "text"],
        additionalProperties: false,
      },
    },
    changes: { type: "string" },
  },
  required: ["headline", "overall", "sections", "changes"],
  additionalProperties: false,
};

export const STRUCTURED_ANALYSIS_PROMPT = `Értékeld a portfóliót a pillanatkép alapján, a megadott JSON-szerkezetben.
- headline: egyetlen mondat, a legfontosabb összkép (konkrét számmal, ha lehet).
- overall: az összkép állapota (rendben / figyelj / teendo).
- sections: 4–7 kártya ezekből a témákból, csak ami releváns: koncentracio (túlsúlyos pozíció), deviza (kitettség), hozam (XIRR/TWR, trend), celok (rendszeres és középtávú célok), penzaramlas (közelgő kamatok, lejáratok, kiadások), allokacio (cél-allokációtól eltérés), tbsz (adózási mérföldkövek), egyeb. Mindegyiknek rövid cím, állapot és 1–3 mondatos szöveg konkrét számokkal.
- A tbsz kártya forintösszegekkel dolgozzon, a pillanatkép TBSZ-soraiból: mennyi lenne az adó, a nettó kézhez kapott összeg és az adózott haszon, ha most bontaná fel, és mennyi a következő mérföldkő (3 éves lekötés / 5 éves lejárat) után — dátummal és azzal, mennyivel több marad a várakozással. Ha több TBSZ van, mindegyikről külön sor (a számla nevével, új sorban), végül egy összesítő; ilyenkor a tbsz kártya hosszabb lehet 3 mondatnál. A "teendo" állapotot csak valódi, időszerű teendőre használd.
- changes: ha kaptál előző elemzést, 1–3 mondatban mi változott azóta (számokkal); ha nem, üres string.
Legyél tömör, kerüld az általános közhelyeket, ne adj konkrét vételi/eladási utasítást.`;

/** Validate the model's JSON (structured outputs guarantee the shape, but be safe). */
export function parseAnalysis(text: string): Analysis | null {
  try {
    const d = JSON.parse(text) as Partial<Analysis>;
    if (typeof d.headline !== "string" || !Array.isArray(d.sections))
      return null;
    const isStatus = (s: unknown): s is Status =>
      s === "rendben" || s === "figyelj" || s === "teendo";
    return {
      headline: d.headline,
      overall: isStatus(d.overall) ? d.overall : "figyelj",
      changes: typeof d.changes === "string" ? d.changes : "",
      sections: d.sections
        .filter((s) => s && typeof s.text === "string")
        .map((s) => ({
          topic: (TOPICS as readonly string[]).includes(s.topic)
            ? s.topic
            : "egyeb",
          title: typeof s.title === "string" ? s.title : "",
          status: isStatus(s.status) ? s.status : "figyelj",
          text: s.text,
        })),
    };
  } catch {
    return null;
  }
}

/** The previous analysis, compact, for the "what changed" comparison. */
export function previousForPrompt(prev: StoredAnalysis | undefined): string {
  if (!prev) return "";
  const d = prev.data;
  return [
    `Előző elemzés (${prev.at.slice(0, 10)}):`,
    `Összkép: ${d.headline}`,
    ...d.sections.map((s) => `- [${s.topic}, ${s.status}] ${s.title}: ${s.text}`),
  ].join("\n");
}

const STORE = "pf-ai-analyses";
const LEGACY = "pf-ai-analysis";
const KEEP = 6;

export function loadAnalyses(): StoredAnalysis[] {
  try {
    const raw = localStorage.getItem(STORE);
    const list = raw ? (JSON.parse(raw) as StoredAnalysis[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveAnalysis(a: StoredAnalysis): StoredAnalysis[] {
  const list = [...loadAnalyses(), a].slice(-KEEP);
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
    localStorage.removeItem(LEGACY);
  } catch {
    /* ignore */
  }
  return list;
}

/** A plain-text analysis saved by the previous app version, if any. */
export function loadLegacyAnalysis(): { text: string; at: string } | null {
  try {
    const raw = localStorage.getItem(LEGACY);
    return raw ? (JSON.parse(raw) as { text: string; at: string }) : null;
  } catch {
    return null;
  }
}

// ---- the nightly analysis (made on the owner's machine) -----------------------
// The local notifier (scripts/notify/analysis/) runs the same analysis with
// Claude Code on the owner's subscription and writes it to the private sync
// repo, where every device's AI page reads it back.

export const ANALYSIS_DIR = "analysis";
export const ANALYSIS_LATEST_PATH = `${ANALYSIS_DIR}/latest.json`;
export const analysisDayPath = (day: string) => `${ANALYSIS_DIR}/${day}.json`;

/** The stored file: a StoredAnalysis plus where and for which day it was made. */
export interface NightlyAnalysis extends StoredAnalysis {
  version: 1;
  /** Local day (YYYY-MM-DD) it was made. */
  day: string;
  engine: string;
}

export function validateNightly(x: unknown): NightlyAnalysis {
  if (!x || typeof x !== "object") throw new Error("Sérült elemzésfájl: nem objektum.");
  const o = x as Record<string, unknown>;
  if (typeof o.version === "number" && o.version > 1)
    throw new Error("Az elemzésfájl újabb verzióval készült — frissítsd az appot.");
  if (typeof o.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.day))
    throw new Error("Sérült elemzésfájl: hiányzó nap.");
  const data = parseAnalysis(JSON.stringify(o.data));
  if (!data) throw new Error("Sérült elemzésfájl: az elemzés nem értelmezhető.");
  return {
    version: 1,
    day: o.day,
    at: String(o.at ?? ""),
    model: String(o.model ?? ""),
    engine: String(o.engine ?? ""),
    costUsd: typeof o.costUsd === "number" ? o.costUsd : 0,
    data,
  };
}

/** The newer of two analyses (by time); either may be missing. */
export function newestAnalysis<T extends StoredAnalysis>(
  a: T | undefined,
  b: T | undefined,
): T | undefined {
  if (!a || !b) return a ?? b;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}
