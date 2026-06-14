import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, Send, RefreshCw } from 'lucide-react'
import { usePortfolio, usePortfolioSummary } from '../lib/store'
import { computeReturns } from '../lib/portfolio'
import { Card } from './ui'
import {
  loadAiKey,
  loadAiModel,
  modelLabel,
  buildAiPortfolioContext,
  callClaude,
  ANALYSIS_PROMPT,
} from '../lib/ai'

const CACHE = 'pf-ai-analysis'

type Cached = { text: string; at: string }

function loadCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE)
    return raw ? (JSON.parse(raw) as Cached) : null
  } catch {
    return null
  }
}

function saveCache(c: Cached) {
  try {
    localStorage.setItem(CACHE, JSON.stringify(c))
  } catch {
    /* ignore */
  }
}

/**
 * AI insights card: one-click portfolio analysis + free-form Q&A, both built on
 * the same compact context so calls stay cheap. The Claude API key is read from
 * localStorage; without it we just point the user to Settings.
 */
export default function AiPanel() {
  const summary = usePortfolioSummary()
  const accounts = usePortfolio((s) => s.accounts)
  const transactions = usePortfolio((s) => s.transactions)
  const instruments = usePortfolio((s) => s.instruments)
  const prices = usePortfolio((s) => s.prices)
  const fx = usePortfolio((s) => s.fx)
  const historyFile = usePortfolio((s) => s.historyFile)
  const privacy = usePortfolio((s) => s.privacy)

  const apiKey = loadAiKey()
  const model = loadAiModel()

  const context = useMemo(() => {
    const returns = computeReturns(
      accounts,
      transactions,
      new Map(instruments.map((i) => [i.key, i])),
      prices,
      fx,
      historyFile,
    )
    return buildAiPortfolioContext(summary, fx, returns)
  }, [summary, accounts, transactions, instruments, prices, fx, historyFile])

  const [analysis, setAnalysis] = useState<Cached | null>(loadCache)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [qLoading, setQLoading] = useState(false)
  const [qError, setQError] = useState<string | null>(null)

  async function runAnalysis() {
    setLoading(true)
    setError(null)
    try {
      const text = await callClaude({
        key: apiKey,
        context,
        prompt: ANALYSIS_PROMPT,
        model,
        maxTokens: 700,
      })
      const c = { text, at: new Date().toISOString() }
      setAnalysis(c)
      saveCache(c)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function ask() {
    const q = question.trim()
    if (!q) return
    setQLoading(true)
    setQError(null)
    setAnswer(null)
    try {
      const text = await callClaude({
        key: apiKey,
        context,
        prompt: q,
        model,
        maxTokens: 600,
      })
      setAnswer(text)
    } catch (e) {
      setQError((e as Error).message)
    } finally {
      setQLoading(false)
    }
  }

  return (
    <Card className="mt-6 p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--color-brand)]" />
          <h2 className="text-lg font-semibold">AI elemzés</h2>
        </div>
        {apiKey && (
          <span className="text-xs text-[var(--color-muted)]">
            {modelLabel(model)}
          </span>
        )}
      </div>

      {!apiKey ? (
        <p className="text-sm text-[var(--color-muted)]">
          Az AI funkciókhoz add meg a saját Claude API-kulcsodat a{' '}
          <Link
            to="/settings"
            className="text-[var(--color-brand)] hover:underline"
          >
            Beállításokban
          </Link>
          . A kulcs csak ezen az eszközön tárolódik.
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-[var(--color-muted)]">
            Tömör értékelés a portfóliódról — diverzifikáció, deviza-kitettség,
            hozam és megfontolandó szempontok. Csak aggregált adatok kerülnek
            elküldésre, tranzakciók soha.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <button
              className="btn-primary"
              onClick={runAnalysis}
              disabled={loading}
            >
              {loading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {analysis ? 'Új elemzés' : 'Elemzés indítása'}
            </button>
            {analysis && (
              <span className="text-xs text-[var(--color-muted)]">
                Frissítve: {formatWhen(analysis.at)}
              </span>
            )}
          </div>

          {error && (
            <p className="mt-3 text-sm text-[var(--color-negative)]">{error}</p>
          )}

          {analysis && (
            <div
              className={`amt mt-4 whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4 text-sm leading-relaxed ${
                privacy ? 'select-none' : ''
              }`}
            >
              {analysis.text}
            </div>
          )}

          <div className="mt-6 border-t border-[var(--color-border)] pt-5">
            <label className="mb-2 block text-sm font-medium">
              Kérdezz a portfóliódról
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                placeholder="pl. Mekkora a dollárkitettségem? Melyik a leggyengébb pozícióm?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !qLoading) ask()
                }}
              />
              <button
                className="btn-ghost"
                onClick={ask}
                disabled={qLoading || !question.trim()}
              >
                {qLoading ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Kérdez
              </button>
            </div>

            {qError && (
              <p className="mt-3 text-sm text-[var(--color-negative)]">
                {qError}
              </p>
            )}

            {answer && (
              <div
                className={`amt mt-3 whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-4 text-sm leading-relaxed ${
                  privacy ? 'select-none' : ''
                }`}
              >
                {answer}
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('hu-HU', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}
