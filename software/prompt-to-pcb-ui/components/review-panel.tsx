'use client'

/**
 * Automated design review tab: category-scored principal-EE review grounded
 * in measured board facts. Cached per run; "Re-review" regenerates.
 */

import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, RefreshCw, Loader2 } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'

interface Category {
  score?: number
  findings?: string[]
}
interface Review {
  overall?: number
  summary?: string
  categories?: Record<string, Category>
  provider?: string
  generatedAt?: string
  cached?: boolean
  error?: string
}

const LABELS: Record<string, string> = {
  power: 'Power',
  signal_integrity: 'Signal integrity',
  emi: 'EMI',
  rf: 'RF',
  thermal: 'Thermal',
  manufacturability: 'Manufacturability',
  reliability: 'Reliability',
  testability: 'Testability',
}

function scoreColor(s: number) {
  if (s >= 8) return 'var(--success)'
  if (s >= 5) return 'var(--primary)'
  return 'var(--destructive)'
}

export function ReviewPanel({ runId }: { runId: string | null }) {
  const [review, setReview] = useState<Review | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchReview = useCallback(
    async (force: boolean) => {
      if (!runId) return
      setLoading(true)
      try {
        const r = await fetch('/api/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...llmHeaders() },
          body: JSON.stringify({ runId, force }),
        })
        setReview(await r.json())
      } catch (e) {
        setReview({ error: String(e) })
      } finally {
        setLoading(false)
      }
    },
    [runId],
  )

  // auto-load cached review on mount / run change (no force → cheap)
  useEffect(() => {
    setReview(null)
    if (runId) fetchReview(false)
  }, [runId, fetchReview])

  if (!runId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select a pipeline run with an editable board to review it.
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">
            Principal-EE design review
          </span>
          {review?.provider && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {review.provider}
              {review.cached ? ' · cached' : ''}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => fetchReview(true)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {loading ? 'Reviewing…' : review?.categories ? 'Re-review' : 'Run review'}
        </button>
      </div>

      {review?.error && (
        <p className="rounded-sm border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {review.error}
        </p>
      )}

      {loading && !review?.categories && (
        <p className="text-xs text-muted-foreground">
          Extracting board facts (decoupling distances, RF impedance, TP coverage, copper
          stats) and running the review…
        </p>
      )}

      {review?.categories && (
        <>
          <div className="mb-4 flex items-center gap-4 rounded-md border border-border bg-card p-4">
            <div
              className="flex size-16 shrink-0 items-center justify-center rounded-full border-4 text-xl font-bold"
              style={{ borderColor: scoreColor(review.overall ?? 0), color: scoreColor(review.overall ?? 0) }}
            >
              {review.overall ?? ', '}
            </div>
            <p className="text-sm text-muted-foreground">{review.summary}</p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(LABELS).map(([key, label]) => {
              const cat = review.categories?.[key]
              const hasScore = typeof cat?.score === 'number'
              const s = hasScore ? (cat!.score as number) : 0
              return (
                <div key={key} className="rounded-md border border-border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground">{label}</span>
                    <span className="font-mono text-xs" style={{ color: hasScore ? scoreColor(s) : 'var(--muted-foreground)' }}>
                      {hasScore ? `${s}/10` : 'n/a'}
                    </span>
                  </div>
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-border">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${s * 10}%`, background: scoreColor(s) }}
                    />
                  </div>
                  <ul className="space-y-1">
                    {(cat?.findings ?? []).map((f, i) => (
                      <li key={i} className="text-[11px] leading-snug text-muted-foreground">
                        • {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
