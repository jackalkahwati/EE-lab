'use client'

/**
 * Industrial Design stage — one-click. Unlike the auto-fired ID interview in the
 * chat (which asks form/ergonomics/CMF/envelope questions and is easy to orphan),
 * this tab finalizes a brief in a single click via /api/industrial-design with
 * force:true — the same one-click behaviour every other discipline tab has. The
 * brief is grounded on the real chip-scale board (the route resolves it from the
 * runId). Once a brief exists it renders the full IdStageView.
 */
import { useState, useEffect, useRef } from 'react'
import { Loader2, Palette } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'
import { IdStageView } from '@/components/id-stage-view'
import { boardIntentOf, type ProductSpec } from '@/lib/product-spec'
import type { IdBrief } from '@/lib/id-brief'

export function IdStage({
  spec, runId, brief, onBrief, boardMm, generationDisabled = false, onBuildStart, onBuildSettled,
}: {
  generationDisabled?: boolean
  onBuildStart?: () => boolean | void | Promise<boolean | void>
  onBuildSettled?: (result: { status: 'passed' | 'failed' | 'unknown'; detail?: string; artifactAvailable?: boolean }) => void | Promise<void>
  spec: ProductSpec | null
  runId?: string
  brief: IdBrief | null
  onBrief?: (brief: IdBrief) => void
  boardMm?: { wMm: number; hMm: number }
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const requestEpoch = useRef(0)
  const busyRef = useRef(false)
  const readController = useRef<AbortController | null>(null)

  // Browsing only loads saved data. Generation is always an explicit button action.
  useEffect(() => {
    requestEpoch.current += 1
    setState('idle'); setErr(null)
    if (brief || !runId) return () => { requestEpoch.current += 1 }
    let off = false
    const epoch = requestEpoch.current
    const controller = new AbortController()
    readController.current = controller
    fetch(`/runs/${runId}/disciplines/id-brief.json`, { cache: 'no-store', signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (off || controller.signal.aborted || epoch !== requestEpoch.current) return
        if (d && d.product) { onBrief?.(d as IdBrief); return }
      })
      .catch(() => {})
    return () => { off = true; controller.abort(); requestEpoch.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, brief])

  async function run() {
    if (!spec || !runId || generationDisabled || busyRef.current) return
    busyRef.current = true
    const epoch = ++requestEpoch.current
    const start = onBuildStart
    const settled = onBuildSettled
    let submitted = false
    let outcome: Parameters<NonNullable<typeof onBuildSettled>>[0] = { status: 'unknown', detail: 'Design brief request outcome unknown. Server work may continue.' }
    readController.current?.abort()
    setState('loading'); setErr(null)
    try {
      const permission = start?.()
      const allowed = permission && typeof (permission as Promise<unknown>).then === 'function' ? await permission : permission
      if (allowed === false || !(epoch === requestEpoch.current)) {
        outcome = { status: 'unknown', detail: 'Generation was not submitted.' }
        if (epoch === requestEpoch.current) { setErr('Generation was not started. Another action or history persistence prevented it.'); setState('error') }
        return
      }
      const intent = boardIntentOf(spec) || spec.product || 'product'
      submitted = true
      const r = await fetch('/api/industrial-design', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ request: intent, answers: [], force: true, runId }),
      })
      // Parse via text so a non-JSON body (proxy/CDN error page) surfaces as a
      // readable HTTP error instead of Safari's cryptic JSON SyntaxError.
      const raw = await r.text()
      let d: { error?: string; type?: string; brief?: unknown }
      try { d = JSON.parse(raw) } catch {
        throw new Error(`industrial design service returned HTTP ${r.status} (non-JSON response)`)
      }
      if (d.error) outcome = { status: 'failed', detail: d.error }
      if (!r.ok || d.error) throw new Error(d.error || `Design brief failed (${r.status}).`)
      if (d.type !== 'brief' || !d.brief || typeof d.brief !== 'object' || !('product' in d.brief) || typeof d.brief.product !== 'string') throw new Error('industrial design did not finalize a brief')
      outcome = { status: 'passed', detail: 'Design brief returned; advisory concept only.', artifactAvailable: true }
      if (epoch !== requestEpoch.current) return
      onBrief?.(d.brief as IdBrief)
      setState('idle')
    } catch (e) { if (epoch === requestEpoch.current) { setErr(String(e)); setState('error') } }
    finally {
      if (!submitted) outcome = { status: 'unknown', detail: 'Generation was not submitted.' }
      try { await settled?.(outcome) } catch (e) {
        if (epoch === requestEpoch.current) { setErr(`Could not record generation outcome: ${String(e)}`); setState('error') }
      } finally { busyRef.current = false }
    }
  }

  // With a brief, show the full view (its own layout); offer a re-generate control.
  if (brief) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 px-5 pt-4">
          <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">industrial design</span>
          <button type="button" onClick={run} disabled={!runId || generationDisabled || state === 'loading'}
            className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">
            {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <Palette className="size-3" />}
            Regenerate brief
          </button>
        </div>
        {state === 'error' && <div className="mx-5 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}
        <div className="min-h-0 flex-1"><IdStageView generationDisabled={generationDisabled || state === 'loading'} onBuildStart={onBuildStart} onBuildSettled={onBuildSettled} brief={brief} boardMm={boardMm} runId={runId} /></div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">industrial design</span>
        <button type="button" onClick={run} disabled={!runId || generationDisabled || !spec || state === 'loading'}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <Palette className="size-3" />}
          Generate design brief
        </button>
      </div>
      {generationDisabled && <p className="mb-3 text-sm text-muted-foreground">Build in progress. Existing design artifacts remain available; generation controls unlock when it finishes.</p>}
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
