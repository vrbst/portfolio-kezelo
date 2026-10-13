// The weekly AI run of the outlook feature: Claude Code on the owner's
// subscription (not the API) looks up, for every held asset, what kind of asset
// it is and which named houses forecast what — each item with the URL and date
// of its source. The answer is validated (a view without a checkable source or
// date is dropped) and merged into market/outlook.json next to what the daily,
// AI-free job writes.

import { toLocalDay } from "../../../src/lib/day";
import {
  ASSET_CLASSES,
  OUTLOOK_PATH,
  validateOutlookFile,
  validateProfile,
  validateView,
  type AnalystView,
  type OutlookFile,
} from "../../../src/lib/outlook";
import type { NewsEngine } from "../news/engine";
import { extractJson, type NewsStore } from "../news/job";
import type { OutlookTarget } from "./refresh";

export const MAX_VIEWS_PER_ASSET = 8;

export const OUTLOOK_AI_SCHEMA = {
  type: "object",
  required: ["assets"],
  properties: {
    assets: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "assetClass", "views"],
        properties: {
          key: { type: "string" },
          assetClass: { type: "string", enum: [...ASSET_CLASSES] },
          underlying: { type: "string" },
          consensusUrl: { type: "string" },
          views: {
            type: "array",
            items: {
              type: "object",
              required: ["house", "kind", "value", "unit", "publishedAt", "url"],
              properties: {
                house: { type: "string" },
                kind: { type: "string", enum: ["target", "annualReturn"] },
                value: { type: "number" },
                unit: { type: "string" },
                horizon: { type: "string" },
                publishedAt: { type: "string" },
                url: { type: "string" },
                note: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function buildOutlookPrompt(targets: OutlookTarget[], prev: OutlookFile | null, now: Date): string {
  const assets = targets.map((t) => {
    const views = prev?.items[t.key]?.views ?? [];
    return [
      `- kulcs: ${t.key} | név: ${t.name} | ISIN: ${t.isin} | típus: ${t.type} | pénznem: ${t.currency}`,
      prev?.profiles[t.key] ? `  jelenlegi besorolás: ${prev.profiles[t.key].assetClass}` : "",
      views.length
        ? `  eddig ismert nézetek: ${views.map((v) => `${v.house} (${v.publishedAt})`).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    `Ma ${toLocalDay(now)} van. Egy magyar magánbefektető portfóliójának eszközeihez gyűjtesz árfolyam-előrejelzéseket. Webes kereséssel dolgozz.`,
    "Az eszközök:",
    assets.join("\n"),
    [
      "Minden eszközre:",
      "1. Határozd meg, mi az (assetClass): equity (egyedi részvény), equity_fund (részvény-ETF/alap), bond_fund, crypto (kriptó-ETP; az underlying a mögöttes érme, pl. BTC), commodity (pl. arany, underlying XAU), other. Ha a kibocsátó (részvénynél) állandó URL-en közli az elemzői konszenzust, add meg a consensusUrl-ben; különben hagyd ki.",
      "2. Gyűjts névvel jelölt, a MÚLT 12 HÓNAPBÓL származó előrejelzéseket (views):",
      "   - egyedi részvény: neves bankok/brókerek célárai (kind=target, unit = a részvény jegyzési pénzneme, pl. HUF) és a hiteles konszenzus-hírek (house = a konszenzus forrása, pl. LSEG);",
      "   - kriptó-ETP: neves bankok/kutatóházak célárai a MÖGÖTTES érmére (kind=target, unit=USD; a note-ba írd, hogy az érme árfolyamára vonatkozik);",
      "   - ETF/alap: a megfelelő eszközosztály várható éves hozama a hosszú távú tőkepiaci előrejelzésekből (Vanguard, J.P. Morgan, BlackRock stb.), kind=annualReturn, value tört alakban (0.065 = 6,5%), horizon pl. „10–15 év”.",
      "Szabályok: csak elsődleges vagy hiteles forrás (bank/kutatóház kiadványa, a kibocsátó honlapja, Reuters, Bloomberg, Portfolio.hu, VG). Minden tételhez add meg a forrás URL-jét, amit tényleg megnyitottál, és a megjelenés dátumát (publishedAt, ÉÉÉÉ-HH-NN). Ne találj ki semmit: ha nem találsz hiteles forrást, a views lehet üres. Eszközönként legfeljebb " +
        `${MAX_VIEWS_PER_ASSET} tétel, házanként a legfrissebb. Nem befektetési tanács, csak adatgyűjtés.`,
    ].join("\n"),
    "A válasz kizárólag a megadott JSON-séma szerinti objektum legyen; az assets elemeinek key mezője pontosan a fenti kulcs.",
  ].join("\n\n");
}

/** Newest view per house and kind and horizon, newest first, capped. */
function tidyViews(views: AnalystView[]): AnalystView[] {
  const best = new Map<string, AnalystView>();
  for (const v of views) {
    const id = `${v.house.toLowerCase()}|${v.kind}|${v.horizon ?? ""}`;
    const cur = best.get(id);
    if (!cur || v.publishedAt > cur.publishedAt) best.set(id, v);
  }
  return [...best.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, MAX_VIEWS_PER_ASSET);
}

/**
 * Merge the AI's answer into the stored file: its profile (unless the user
 * set one by hand) and its views — but an asset it found nothing valid for
 * keeps the views it had.
 */
export function mergeAiAnswer(
  prev: OutlookFile,
  answer: unknown,
  targets: OutlookTarget[],
  now: Date,
): { file: OutlookFile; assets: number; views: number } {
  const known = new Set(targets.map((t) => t.key));
  const list = (answer as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(list)) throw new Error("a válaszban nincs assets lista");
  const file: OutlookFile = {
    ...prev,
    updatedAt: now.toISOString(),
    profiles: { ...prev.profiles },
    items: { ...prev.items },
  };
  let assets = 0;
  let total = 0;
  for (const raw of list) {
    const a = raw as Record<string, unknown> | null;
    const key = typeof a?.key === "string" ? a.key : "";
    if (!a || !known.has(key)) continue;
    const profile = validateProfile({
      assetClass: a.assetClass,
      underlying: a.underlying,
      consensusUrl: a.consensusUrl,
      source: "ai",
      checkedAt: now.toISOString(),
    });
    if (profile && prev.profiles[key]?.source !== "manual") file.profiles[key] = profile;
    const views = tidyViews(
      (Array.isArray(a.views) ? a.views : []).flatMap((v) => {
        const ok = validateView(v, now);
        return ok ? [ok] : [];
      }),
    );
    if (views.length) {
      file.items[key] = { ...file.items[key], views };
      assets++;
      total += views.length;
    }
  }
  return { file, assets, views: total };
}

export interface OutlookAiResult {
  assets: number;
  views: number;
  costUsd?: number;
}

/** One AI run; throws when the AI fails or answers nonsense twice. */
export async function runOutlookAi(
  targets: OutlookTarget[],
  deps: { engine: NewsEngine; store: NewsStore },
  now: Date,
): Promise<OutlookAiResult> {
  const text = await deps.store.read(OUTLOOK_PATH).catch(() => null);
  const prev = (() => {
    try {
      return text ? validateOutlookFile(JSON.parse(text), now) : null;
    } catch {
      return null;
    }
  })();
  const base: OutlookFile = prev ?? { v: 1, updatedAt: now.toISOString(), profiles: {}, items: {}, errors: {} };
  const prompt = buildOutlookPrompt(targets, base, now);
  let cost = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = attempt
      ? `${prompt}\n\nAz előző válaszod nem volt érvényes (${lastError}). Add vissza javítva, a séma szerint.`
      : prompt;
    const r = await deps.engine.run(p);
    cost += r.costUsd ?? 0;
    let merged: ReturnType<typeof mergeAiAnswer>;
    try {
      merged = mergeAiAnswer(base, extractJson(r.output), targets, now);
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`outlook-ai: invalid answer (${attempt + 1}/2): ${lastError}`);
      continue;
    }
    // Outside the try: a failed upload must not cost another AI run.
    await deps.store.write(OUTLOOK_PATH, JSON.stringify(merged.file), `outlook AI ${toLocalDay(now)}`);
    return { assets: merged.assets, views: merged.views, costUsd: cost || undefined };
  }
  throw new Error(`Az AI kétszer is hibás választ adott: ${lastError}`);
}
