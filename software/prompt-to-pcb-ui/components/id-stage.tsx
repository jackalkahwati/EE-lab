'use client'

/**
 * Industrial Design stage — one-click. Unlike the auto-fired ID interview in the
 * chat (which asks form/ergonomics/CMF/envelope questions and is easy to orphan),
 * this tab finalizes a brief in a single click via /api/industrial-design with
 * force:true — the same one-click behaviour every other discipline tab has. The
 * brief is grounded on the real chip-scale board (the route resolves it from the
 * runId). Once a brief exists it renders the full IdStageView.
 */
import { useState } from 'react'
import { Loader2, Palette } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'
import { IdStageView } from '@/components/id-stage-view'
import { boardIntentOf, type ProductSpec } from '@/lib/product-spec'
import type { IdBrief } from '@/lib/id-brief'

export function IdStage({
  spec, runId, brief, onBrief, boardMm,
}: {
  spec: ProductSpec | null
  runId?: string
  brief: IdBrief | null
  onBrief?: (brief: IdBrief) => void
  boardMm?: { wMm: number; hMm: number }
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [err, setErr] = useState<string | null>(null)

  async function run() {
    if (!spec) return
    setState('loading'); setErr(null)
    try {
      const intent = boardIntentOf(spec) || spec.product || 'product'
      const r = await fetch('/api/industrial-design', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ request: intent, answers: [], force: true, runId }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      if (d.type !== 'brief' || !d.brief) throw new Error('industrial design did not finalize a brief')
      onBrief?.(d.brief as IdBrief)
      setState('idle')
    } catch (e) { setErr(String(e)); setState('error') }
  }

  // With a brief, show the full view (its own layout); offer a re-generate control.
  if (brief) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 px-5 pt-4">
          <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">industrial design</span>
          <button type="button" onClick={run} disabled={state === 'loading'}
            className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">
            {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <Palette className="size-3" />}
            Regenerate brief
          </button>
        </div>
        {state === 'error' && <div className="mx-5 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}
        <div className="min-h-0 flex-1"><IdStageView brief={brief} boardMm={boardMm} runId={runId} /></div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">industrial design</span>
        <button type="button" onClick={run} disabled={!spec || state === 'loading'}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <Palette className="size-3" />}
          Generate design brief
        </button>
      </div>
      {!spec && <p className="text-sm text-muted-foreground">Describe a product first.</p>}
      {spec && state === 'idle' && (
        <p className="text-sm text-muted-foreground">
          A one-click form / ergonomics / CMF / envelope brief, grounded on the real
          chip-scale board — no interview needed. Wraps the achievable geometry.
        </p>
      )}
      {state === 'loading' && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> finalizing the industrial design brief…</p>}
      {state === 'error' && <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}
    </div>
  )
}
