'use client'

/**
 * Mechanical stage — product-engine-directed CAD. Runs /api/mechanical (spec +
 * real board -> build plan -> Onshape -> STEP + preview) and shows the shaded
 * render, a STEP download, the Onshape link, and — honestly — which plan ops
 * rendered vs failed. Advisory CAD, not a tolerance-validated part. Generic:
 * nothing here is earbud-specific.
 */
import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, Box, Download, ExternalLink } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'
import { MechanicalAssembly } from '@/components/mechanical-assembly'
import { CadViewer } from '@/components/cad-viewer'
import type { ProductSpec } from '@/lib/product-spec'

type Result = {
  ok: boolean
  part?: string
  previewUrl?: string | null
  stepUrl?: string | null
  gltfUrl?: string | null
  onshapeUrl?: string
  opsRendered?: string[]
  opsFailed?: { op: string; error: string }[]
  fitCheck?: { fits: boolean; enclosureMm: { w: number; h: number }; pcbMm: { w: number; h: number } } | null
  error?: string
}

export function MechanicalStage({ spec, runId, onBuilt }: { spec: ProductSpec | null; runId?: string; onBuilt?: () => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [res, setRes] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Load a persisted enclosure result on mount (written by /api/mechanical) so the
  // orchestrator's run shows without re-generating the CAD.
  useEffect(() => {
    if (!runId) return
    let off = false
    fetch(`/runs/${runId}/mechanical/mechanical.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off && d && d.part) { setRes({ ok: true, ...d }); setState('done') } })
      .catch(() => {})
    return () => { off = true }
  }, [runId])

  async function run() {
    if (!spec || !runId) return
    setState('loading'); setErr(null)
    try {
      const r = await fetch('/api/mechanical', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ spec, runId }),
      })
      const d = await r.json()
      if (d.ok) { setRes(d); setState('done'); onBuilt?.() }
      else { setErr(d.error || 'enclosure build failed'); setRes(d); setState('error') }
    } catch (e) { setErr(String(e)); setState('error') }
  }

  const canRun = !!spec && !!runId

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">mechanical · CAD</span>
        <button type="button" onClick={run} disabled={!canRun || state === 'loading'}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <Box className="size-3" />}
          {res?.ok ? 'Regenerate' : 'Generate enclosure'}
        </button>
      </div>

      {!canRun && <p className="text-sm text-muted-foreground">Build a board first — the enclosure wraps the real board.</p>}
      {state === 'idle' && canRun && (
        <p className="text-sm text-muted-foreground">
          The product engine emits a mechanical build plan sized to the real board; the Onshape executor renders it and exports STEP. Advisory CAD — a first-pass parametric part, not a tolerance-validated design.
        </p>
      )}
      {state === 'loading' && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> generating CAD in Onshape (30–90s)…</p>}
      {state === 'error' && <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">Enclosure build failed: {err}</div>}

      {res?.ok && state === 'done' && (
        <div className="space-y-4">
          <div className="text-[13px] font-semibold text-foreground">{res.part}</div>
          {runId && (
            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">final assembly — populated board + Li-ion cell in the enclosure (drag to rotate)</div>
              <div className="mx-auto h-[32vh] max-w-2xl overflow-hidden rounded-md border border-border bg-[#0a0a0a]">
                <MechanicalAssembly basePath={`/runs/${runId}/board`} />
              </div>
            </div>
          )}
          {res.gltfUrl ? (
            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">enclosure CAD — real Onshape geometry (drag to rotate)</div>
              <div className="mx-auto h-[32vh] max-w-2xl overflow-hidden rounded-md border border-border bg-[#0f0f0f]">
                <CadViewer url={res.gltfUrl} />
              </div>
            </div>
          ) : res.previewUrl ? (
            // legacy runs without a glTF export: the flat shaded preview
            // eslint-disable-next-line @next/next/no-img-element
            <img src={res.previewUrl} alt={`${res.part} CAD preview`} className="mx-auto max-h-[32vh] w-auto rounded-md border border-border bg-white" />
          ) : null}
          {res.fitCheck && (
            <div className={cn('rounded-md border px-3 py-2 text-[12px]',
              res.fitCheck.fits ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : 'border-destructive/50 bg-destructive/10 text-destructive')}>
              {res.fitCheck.fits ? '✓ PCB fits the cavity' : '✗ PCB does NOT fit the enclosure'} — board {res.fitCheck.pcbMm.w}×{res.fitCheck.pcbMm.h} mm vs enclosure {res.fitCheck.enclosureMm.w}×{res.fitCheck.enclosureMm.h} mm.
              {!res.fitCheck.fits && ' The board is placed at true size (not shrunk) — this is the electronics gap, surfaced honestly for the redesign loop.'}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {res.stepUrl && (
              <a href={res.stepUrl} download className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground hover:bg-secondary/50">
                <Download className="size-3.5" /> STEP
              </a>
            )}
            {res.onshapeUrl && (
              <a href={res.onshapeUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground">
                <ExternalLink className="size-3.5" /> Open in Onshape
              </a>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            rendered: <span className="font-mono text-foreground">{res.opsRendered?.join(', ') || '—'}</span>
            {res.opsFailed?.length ? (
              <span className="mt-1 block text-amber-600 dark:text-amber-400">
                skipped (reported, not hidden): {res.opsFailed.map((f) => f.op).join(', ')}
              </span>
            ) : null}
          </div>
          <div className="rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground">
            Advisory CAD: a generated parametric part sized to the real board — not fit/tolerance-validated for production.
          </div>
        </div>
      )}
    </div>
  )
}
