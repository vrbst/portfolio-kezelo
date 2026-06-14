import type { PortfolioSummary, ReturnMetrics } from './portfolio'
import {
  allocationByClass,
  allocationByCurrency,
  assetClassOf,
} from './portfolio'
import { assetClassLabel } from './labels'

/**
 * Browser-direct Claude API client + compact portfolio context builder.
 *
 * The app is static (GitHub Pages, no backend), so we call the Anthropic API
 * straight from the browser with the user's own key. The key lives only in this
 * device's localStorage (like the sync token) and is NEVER synced to the cloud.
 * The `anthropic-dangerous-direct-browser-access` header opts into browser CORS.
 *
 * Token budget: we only ever send a tiny pre-aggregated snapshot (totals,
 * allocation %, top holdings, returns) — never raw transactions — so a call is
 * ~1–1.5k input tokens.
 */

const KEY = 'pf-ai-key'
const MODEL_KEY = 'pf-ai-model'

/** Default model: Sonnet 4.6 (good Hungarian + nuanced commentary, cheap here). */
export const AI_MODEL = 'claude-sonnet-4-6'

/** Models the user can pick from in Settings (stored per-device). */
export const AI_MODELS = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    hint: 'Ajánlott — jó egyensúly minőség és ár között (~1,5 cent/hívás).',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    hint: 'Leggyorsabb és legolcsóbb (~0,5 cent/hívás), rövid összefoglalókhoz.',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    hint: 'Legerősebb, legárnyaltabb elemzés — de drágább (~7 cent/hívás).',
  },
] as const

export function modelLabel(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id
}

export function loadAiKey(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveAiKey(v: string) {
  try {
    if (v) localStorage.setItem(KEY, v)
    else localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function loadAiModel(): string {
  try {
    const m = localStorage.getItem(MODEL_KEY)
    if (m && AI_MODELS.some((x) => x.id === m)) return m
  } catch {
    /* ignore */
  }
  return AI_MODEL
}

export function saveAiModel(id: string) {
  try {
    localStorage.setItem(MODEL_KEY, id)
  } catch {
    /* ignore */
  }
}

const huf = (n: number) => Math.round(n).toLocaleString('hu-HU')
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

/**
 * A compact, human-readable Hungarian snapshot of the portfolio for the model.
 * Aggregated numbers only — no transaction history — to keep tokens minimal.
 */
export function buildAiPortfolioContext(
  summary: PortfolioSummary,
  fx: Record<string, number>,
  returns: ReturnMetrics,
): string {
  const total = summary.totalValueHuf || 1

  const byClass = allocationByClass(summary)
    .map(
      (s) =>
        `${assetClassLabel[s.key as keyof typeof assetClassLabel] ?? s.key}: ${pct(s.value / total)}`,
    )
    .join(', ')

  const byCcy = allocationByCurrency(summary, fx)
    .map((s) => `${s.key}: ${pct(s.value / total)}`)
    .join(', ')

  const holdings = summary.accounts
    .flatMap((a) => a.holdings)
    .filter((h) => (h.marketValueHuf ?? 0) > 0)
    .sort((a, b) => (b.marketValueHuf ?? 0) - (a.marketValueHuf ?? 0))
    .slice(0, 8)
    .map((h) => {
      const name = h.instrument?.name ?? h.instrumentKey
      const cls = assetClassLabel[assetClassOf(h.instrument)] ?? ''
      const w = pct((h.marketValueHuf ?? 0) / total)
      const pl =
        h.costBasisHuf > 0 && h.unrealizedPlHuf != null
          ? `, hozam ${pct(h.unrealizedPlHuf / h.costBasisHuf)}`
          : ''
      return `- ${name} [${cls}]: ${huf(h.marketValueHuf ?? 0)} Ft (súly ${w}${pl})`
    })
    .join('\n')

  const lines = [
    `Összérték: ${huf(summary.totalValueHuf)} Ft`,
    `Befektetett tőke: ${huf(summary.netDepositedHuf)} Ft`,
    `Teljes hozam: ${huf(summary.totalPlHuf)} Ft (${pct(summary.totalReturnPct)})`,
    `Nem realizált: ${huf(summary.unrealizedPlHuf)} Ft · Realizált: ${huf(summary.realizedPlHuf)} Ft · Kapott kamat: ${huf(summary.interestHuf)} Ft`,
    `Készpénz: ${huf(summary.cashValueHuf)} Ft (${pct(summary.cashValueHuf / total)})`,
    returns.xirrPct != null ? `XIRR (évesített, pénzsúlyozott): ${pct(returns.xirrPct)}` : null,
    returns.twrPct != null ? `TWR (évesített, idősúlyozott): ${pct(returns.twrPct)}` : null,
    `Adatsor hossza: ${returns.days} nap`,
    '',
    `Allokáció eszköztípus szerint: ${byClass}`,
    `Allokáció deviza szerint: ${byCcy}`,
    '',
    'Legnagyobb pozíciók:',
    holdings || '- (nincs nyitott pozíció)',
  ].filter((l): l is string => l != null)

  return lines.join('\n')
}

const SYSTEM = `Magyar pénzügyi asszisztens vagy egy személyes, lakossági portfólió-követő appban. Megkapod a felhasználó portfóliójának számszerű pillanatképét (forintban). Tömören, magyarul, közérthetően válaszolj. Kizárólag a megadott adatokra támaszkodj — soha ne találj ki számokat, és ha valami nem derül ki az adatokból, mondd ki őszintén. Ne adj konkrét vételi/eladási utasítást; inkább összefüggéseket, kockázatokat, koncentrációt és megfontolandó szempontokat emelj ki. Magyar lakossági kontextus (TBSZ, állampapír adómentessége a lekötés alatt) releváns lehet. Egyszerű szöveget használj: rövid bekezdések vagy "- " kezdetű felsorolás, NE használj markdown fejlécet vagy csillagos kiemelést. A forint/euró összegek a felhasználó valós egyenlegei — kezeld diszkréten.`

/** Free-form analysis prompt for the one-click button. */
export const ANALYSIS_PROMPT =
  'Adj rövid, lényegre törő értékelést a portfólióról 4–6 felsorolási pontban: diverzifikáció és koncentráció (van-e túlsúlyos pozíció), deviza-kitettség, a hozam értékelése, és 1–2 megfontolandó szempont. Legyen tömör, kerüld az általános közhelyeket.'

export async function callClaude(opts: {
  key: string
  context: string
  prompt: string
  model?: string
  maxTokens?: number
  signal?: AbortSignal
}): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model ?? AI_MODEL,
      max_tokens: opts.maxTokens ?? 700,
      system: `${SYSTEM}\n\n--- Portfólió pillanatkép ---\n${opts.context}`,
      messages: [{ role: 'user', content: opts.prompt }],
    }),
    signal: opts.signal,
  })

  if (!res.ok) {
    let msg = `API hiba (${res.status})`
    try {
      const e = await res.json()
      if (e?.error?.message) msg = e.error.message
    } catch {
      /* ignore parse error */
    }
    if (res.status === 401) msg = 'Érvénytelen API-kulcs.'
    else if (res.status === 429) msg = 'Túl sok kérés vagy elfogyott az egyenleg.'
    throw new Error(msg)
  }

  const data = await res.json()
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((b: { type?: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('')
    : ''
  return text.trim() || '(üres válasz)'
}
