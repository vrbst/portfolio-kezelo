import type { NewsEngine } from "./engine";
import { extractJson } from "./job";
import { esc, pct } from "../reports";

export interface WhyFactor {
  key: string;
  label: string;
  pct: number;
  name?: string;
  ticker?: string;
  isin?: string;
  currency?: string;
  type?: string;
  subject?: string;
}

export interface WhySource {
  title: string;
  url: string;
}

export interface WhyItem {
  factor: string;
  explanation: string;
  sources: WhySource[];
}

export interface WhyAnswer {
  items: WhyItem[];
}

export const WHY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["factor", "explanation", "sources"],
        properties: {
          factor: { type: "string" },
          explanation: { type: "string" },
          sources: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "url"],
              properties: { title: { type: "string" }, url: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

export function validateWhyAnswer(x: unknown, factors: WhyFactor[]): WhyAnswer {
  if (!isObj(x) || !Array.isArray(x.items)) throw new Error("items: lista kell");
  const known = new Set(factors.map((f) => f.key));
  const items = x.items.flatMap((it, i) => {
    const at = `items[${i}]`;
    if (!isObj(it) || !text(it.factor) || !text(it.explanation))
      throw new Error(`${at}: tényező és magyarázat kell`);
    if (!known.has(it.factor.trim())) return [];
    const sources = (Array.isArray(it.sources) ? it.sources : []).map((s, j) => {
      if (!isObj(s) || !text(s.title) || !text(s.url) || !/^https?:\/\//.test(s.url))
        throw new Error(`${at}.sources[${j}]: cím és http(s) URL kell`);
      return { title: s.title.trim(), url: s.url.trim() };
    });
    return [{ factor: it.factor.trim(), explanation: it.explanation.trim(), sources }];
  });
  if (!items.length) throw new Error("items: egyik tényezőhöz sincs magyarázat (a factor mező a megadott azonosító legyen)");
  return { items };
}

const WEEKDAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];

export function buildWhyPrompt(p: {
  day: string;
  weekday: number;
  factors: WhyFactor[];
  exposure?: string[];
}): string {
  const lines = p.factors.map((f) => {
    const head = `- factor: "${f.key}" — `;
    const move = `${pct(f.pct, 2)} ma`;
    if (f.key === "portfolio") return `${head}a teljes portfólió forintértéke: ${move}`;
    if (f.key === "EUR/HUF") return `${head}az EUR/HUF árfolyam (pozitív = gyengülő forint): ${move}`;
    const id = [f.ticker, f.isin ? `ISIN: ${f.isin}` : ""].filter(Boolean).join(", ");
    const what = `${f.name ?? f.key}${id ? ` (${id})` : ""}`;
    const quoted = f.currency && f.currency !== "HUF" ? `, ${f.currency}-ban jegyzett` : "";
    if (f.subject) {
      const fx =
        f.currency && f.currency !== "USD" && f.currency !== "HUF"
          ? `; mivel ${f.currency}-ban jegyzett, ${article(f.currency)} ${f.currency}/USD mozgása is számíthat`
          : "";
      return `${head}${what}${quoted}: ${move} — keresd: ${f.subject} árfolyammozgásának oka${fx}`;
    }
    const fund =
      f.type === "etf" || f.type === "fund"
        ? " — alap: a követett index vagy piac mai mozgását magyarázd (a név alapján, pl. világindex → globális részvénypiac), ne a tickerre keress"
        : "";
    return `${head}${what}${quoted}: ${move}${fund}`;
  });
  const exposure = p.exposure?.length
    ? `\n\nA portfólió összetétele (súlyok a teljes vagyonból):\n${p.exposure.join("\n")}`
    : "";
  return `Te egy magyar magánbefektető piaci hírszerkesztője vagy. Ma ${p.day}, ${WEEKDAYS[p.weekday]}.

Az alábbi tételek ma szokatlanul nagyot mozdultak. Keress a weben, és tényezőnként 2–3 mondatban magyarázd el, mi mozgatta őket ma:
${lines.join("\n")}${exposure}

Szabályok:
- Minden fenti tényezőhöz pontosan egy elem, a "factor" mezőben a fenti azonosítóval.
- Csak megbízható forrás (pl. Reuters, Bloomberg, FT, CNBC, MNB, Portfolio.hu, telex.hu, hvg.hu). Legfeljebb 3 forrás tényezőnként; a forrás "title" mezője a kiadó rövid neve (pl. "Reuters"), az "url" egy valódi cikk, amit ténylegesen megnyitottál vagy a keresés visszaadott.
- Ha nem találsz egyértelmű okot, írd meg röviden, és ne találj ki semmit: számot, árfolyamot, idézetet csak forrásból.
- Röviden, magyarul.

A válasz kizárólag a megadott JSON-séma szerinti objektum legyen.`;
}

export async function askWhy(
  engine: NewsEngine,
  prompt: string,
  factors: WhyFactor[],
): Promise<{ answer: WhyAnswer; costUsd?: number }> {
  let cost = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = attempt
      ? `${prompt}\n\nAz előző válaszod nem volt érvényes (${lastError}). Add vissza javítva, a séma szerint.`
      : prompt;
    const r = await engine.run(p);
    cost += r.costUsd ?? 0;
    try {
      return { answer: validateWhyAnswer(extractJson(r.output), factors), costUsd: cost || undefined };
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`why: invalid answer (${attempt + 1}/2): ${lastError}`);
    }
  }
  throw new Error(`Az AI kétszer is hibás „Miért mozdult?” választ adott: ${lastError}`);
}

const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

export const article = (word: string) => (/^[aáeéiíoóöőuúüű]/i.test(word) ? "az" : "a");

export function whyText(factors: WhyFactor[], answer: WhyAnswer): string {
  const blocks = factors.flatMap((f) => {
    const it = answer.items.find((i) => i.factor === f.key);
    if (!it) return [];
    const sources = it.sources.length
      ? ` (${it.sources.map((s) => `<a href="${attr(s.url)}">${esc(s.title)}</a>`).join(", ")})`
      : "";
    return [`🔎 <b>Miért mozdult ${article(f.label)} ${f.label}?</b> ${esc(it.explanation)}${sources}`];
  });
  return blocks.join("\n\n");
}
