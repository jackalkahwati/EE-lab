'use client'

/**
 * Mechanical stage — product-engine-directed CAD. Runs /api/mechanical (spec +
 * real board -> build plan -> Onshape -> STEP + preview) and shows the shaded
 * render, a STEP download, the Onshape link, and — honestly — which plan ops
 * rendered vs failed. Advisory CAD, not a tolerance-validated part. Generic:
 * nothing here is earbud-specific.
 */
import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, Box, Download, ExternalLink } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'
import { MechanicalAssembly } from '@/components/mechanical-assembly'
import { CadViewer } from '@/components/cad-viewer'
import type { ProductSpec } from '@/lib/product-spec'

type Result = {
  ok: boolean
  imported?: boolean
  part?: string
  previewUrl?: string | null
  stepUrl?: string | null
  gltfUrl?: string | null
  onshapeUrl?: string
  opsRendered?: string[]
  opsFailed?: { op: string; error: string }[]
  fitCheck?: {
    fits: boolean
    verdict?: 'fits' | 'does_not_fit' | 'unknown'
    enclosureMm: { w: number; h: number }
    cavityMm?: { w: number; h: number; d?: number } | null
    pcbMm: { w: number; h: number }
    problems?: string[]
  } | null
  error?: string
}

function validResult(value: unknown): value is Result {
  if (!value || typeof value !== 'object') return false
  const d = value as Record<string, unknown>
  if (typeof d.part !== 'string' || !d.part.trim() || (d.ok !== undefined && d.ok !== true)) return false
  for (const key of ['previewUrl', 'stepUrl', 'gltfUrl', 'onshapeUrl']) {
    if (d[key] != null && typeof d[key] !== 'string') return false
  }
  if (d.opsRendered !== undefined && (!Array.isArray(d.opsRendered) || !d.opsRendered.every((op) => typeof op === 'string'))) return false
  if (d.opsFailed !== undefined && (!Array.isArray(d.opsFailed) || !d.opsFailed.every((op: unknown) => {
    if (!op || typeof op !== 'object') return false
    const failed = op as Record<string, unknown>
    return typeof failed.op === 'string' && typeof failed.error === 'string'
  }))) return false
  if (d.fitCheck != null) {
    if (typeof d.fitCheck !== 'object') return false
    const fc = d.fitCheck as Record<string, unknown>
    const dimensions = (v: unknown) => {
      if (!v || typeof v !== 'object') return false
      const mm = v as Record<string, unknown>
      return typeof mm.w === 'number' && Number.isFinite(mm.w) && typeof mm.h === 'number' && Number.isFinite(mm.h)
    }
    if (typeof fc.fits !== 'boolean' || !dimensions(fc.enclosureMm) || !dimensions(fc.pcbMm)) return false
    if (fc.cavityMm != null && !dimensions(fc.cavityMm)) return false
    if (fc.verdict !== undefined && !['fits', 'does_not_fit', 'unknown'].includes(String(fc.verdict))) return false
    if (fc.problems !== undefined && (!Array.isArray(fc.problems) || !fc.problems.every((p) => typeof p === 'string'))) return false
  }
  return true
}

type Props = {
  spec: ProductSpec | null; runId?: string; onBuilt?: () => void
  onBuildStart?: () => boolean | void | Promise<boolean | void>; generationDisabled?: boolean
  onBuildSettled?: (result: { status: 'passed' | 'failed' | 'unknown'; detail?: string; artifactAvailable?: boolean }) => void | Promise<void>
}

export function MechanicalStage(props: Props) {
  return <MechanicalArtifactView key={props.runId ?? 'draft'} {...props} />
}

function MechanicalArtifactView({ spec, runId, onBuilt, onBuildStart, onBuildSettled, generationDisabled }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'generating' | 'missing' | 'done' | 'error'>(runId ? 'loading' : 'idle')
  const [res, setRes] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [operation, setOperation] = useState<'read' | 'generate'>('read')
  const request = useRef({ version: 0, generating: false })
  const readController = useRef<AbortController | null>(null)

  // Saved artifacts are reads, not permission to regenerate CAD.
  useEffect(() => {
    const scope = request.current
    const token = ++scope.version
    const controller = new AbortController()
    readController.current = controller
    setRes(null); setErr(null); setOperation('read')
    setState(runId ? 'loading' : 'idle')
    if (runId) {
      fetch(`/runs/${runId}/mechanical/mechanical.json`, { cache: 'no-store', signal: controller.signal })
        .then(async (r) => {
          if (r.status === 404) return null
          if (!r.ok) throw new Error(`Could not load enclosure (${r.status}).`)
          const d: unknown = await r.json()
          if (d && typeof d === 'object' && 'imported' in d && d.imported === true && 'source' in d && d.source === 'manual-import'
            && 'manualImport' in d && d.manualImport && typeof d.manualImport === 'object' && 'kind' in d.manualImport && d.manualImport.kind === 'step') {
            return { ok: true, imported: true, part: 'Imported CAD assembly', stepUrl: `/runs/${runId}/mechanical/enclosure.step` }
          }
          if (!validResult(d)) throw new Error('The saved enclosure artifact is invalid.')
          return { ...d, ok: true }
        })
        .then((d) => {
          if (scope.version !== token || controller.signal.aborted) return
          setRes(d); setState(d ? 'done' : 'missing')
        })
        .catch((e: unknown) => {
          if (scope.version !== token || controller.signal.aborted) return
          setErr(String(e)); setState('error')
        })
    }
    // Closing a panel stops observation, not paid server work.
    return () => { ++scope.version; controller.abort() }
  }, [runId, retry])

  async function run() {
    if (!spec || !runId || generationDisabled || request.current.generating) return
    const scope = request.current
    const token = ++scope.version
    scope.generating = true
    const start = onBuildStart
    const settled = onBuildSettled
    let submitted = false
    let outcome: Parameters<NonNullable<Props['onBuildSettled']>>[0] = { status: 'unknown', detail: 'CAD request outcome unknown. Server work may continue.' }
    readController.current?.abort()
    setState('generating'); setErr(null); setOperation('generate')
    try {
      const permission = start?.()
      const allowed = permission && typeof (permission as Promise<unknown>).then === 'function' ? await permission : permission
      if (allowed === false || !(scope.version === token)) {
        outcome = { status: 'unknown', detail: 'Generation was not submitted.' }
        if (scope.version === token) { setErr('Generation was not started. Another action or history persistence prevented it.'); setState('error') }
        return
      }
      submitted = true
      const r = await fetch('/api/mechanical', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ spec, runId }),
      })
      const d: unknown = await r.json()
      if (d && typeof d === 'object' && 'error' in d && typeof d.error === 'string') outcome = { status: 'failed', detail: d.error }
      if (!r.ok || !validResult(d)) {
        const message = d && typeof d === 'object' && 'error' in d && typeof d.error === 'string' ? d.error : `Enclosure build failed (${r.status}).`
        throw new Error(message)
      }
      outcome = { status: d.fitCheck?.fits === false && d.fitCheck.verdict !== 'unknown' || d.opsFailed?.length ? 'failed' : d.ok === true ? 'passed' : 'unknown', detail: 'CAD generation returned an artifact; inspect fit and failed operations. This is not manufacturing approval.', artifactAvailable: true }
      if (scope.version !== token) return
      setRes({ ...d, ok: true }); setState('done')
    } catch (e: unknown) {
      if (scope.version !== token) return
      setErr(String(e)); setState('error')
    } finally {
      if (!submitted) outcome = { status: 'unknown', detail: 'Generation was not submitted.' }
      try { await settled?.(outcome) } catch (e) {
        if (scope.version === token) { setErr(`Could not record generation outcome: ${String(e)}`); setState('error') }
      } finally { scope.generating = false }
      if (submitted && scope.version === token) onBuilt?.()
    }
  }

  const canRun = !!spec && !!runId

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">mechanical · CAD</span>
        <button type="button" onClick={run} disabled={!canRun || generationDisabled || state === 'generating'} title={generationDisabled ? 'Generation is managed by the active pipeline.' : undefined}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'generating' ? <Loader2 className="size-3 animate-spin" /> : <Box className="size-3" />}
          {state === 'generating' ? 'Generating…' : state === 'error' && operation === 'generate' ? 'Retry generation' : res?.ok ? 'Regenerate' : 'Generate enclosure'}
        </button>
      </div>

      {!canRun && <p className="text-sm text-muted-foreground">Build a board first — the enclosure wraps the real board.</p>}
      {state === 'idle' && canRun && (
        <p className="text-sm text-muted-foreground">
          The product engine emits a mechanical build plan sized to the real board; the Onshape executor renders it and exports STEP. Advisory CAD — a first-pass parametric part, not a tolerance-validated design.
        </p>
      )}
      {state === 'loading' && <p role="status" className="text-sm text-muted-foreground">Loading saved enclosure…</p>}
      {state === 'generating' && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> generating CAD in Onshape (30–90s)…</p>}
      {state === 'missing' && <p role="status" className="text-sm text-muted-foreground">No saved enclosure for this run.</p>}
      {state === 'error' && <div role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}
      {(state === 'missing' || (state === 'error' && operation === 'read')) && (
        <button type="button" onClick={() => setRetry((n) => n + 1)} className="mt-2 self-start rounded-md border border-border px-3 py-1 text-xs">Retry loading enclosure</button>
      )}

      {res?.ok && state === 'done' && (
        <div className="space-y-4">
          <div className="text-[13px] font-semibold text-foreground">{res.part}</div>
          {runId && !res.imported && (
            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                {res.gltfUrl
                  ? 'assembly preview — approximate placement; fit not verified by this view'
                  : 'assembly preview — approximate shell; fit not verified by this view'}
              </div>
              <div className="mx-auto h-[32vh] max-w-2xl overflow-hidden rounded-md border border-border bg-[#0a0a0a]">
                <MechanicalAssembly basePath={`/runs/${runId}/board`} enclosureUrl={res.gltfUrl}
                  hasBattery={(spec?.budgets?.power?.batteryMah ?? 0) > 0} />
              </div>
            </div>
          )}
          {res.gltfUrl ? (
            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">enclosure model preview (drag to rotate)</div>
              <div className="mx-auto h-[32vh] max-w-2xl overflow-hidden rounded-md border border-border bg-[#0f0f0f]">
                <CadViewer url={res.gltfUrl} />
              </div>
            </div>
          ) : res.previewUrl ? (
            // legacy runs without a glTF export: the flat shaded preview
            // eslint-disable-next-line @next/next/no-img-element
            <img src={res.previewUrl} alt={`${res.part} CAD preview`} className="mx-auto max-h-[32vh] w-auto rounded-md border border-border bg-white" />
          ) : null}
          {res.fitCheck && (() => {
            const fc = res.fitCheck
            const unknown = fc.verdict === 'unknown'
            const cav = fc.cavityMm ?? fc.enclosureMm
            const tone = unknown
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
              : fc.fits ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : 'border-destructive/50 bg-destructive/10 text-destructive'
            const headline = unknown ? '? PCB fit not verified' : fc.fits ? '✓ PCB fits the cavity' : '✗ PCB does NOT fit the cavity'
            return (
              <div className={cn('rounded-md border px-3 py-2 text-[12px]', tone)}>
                {headline} — board {fc.pcbMm.w}×{fc.pcbMm.h} mm{!unknown && ` vs cavity ${cav.w}×${cav.h} mm`}.
                {fc.problems?.[0] && ` ${fc.problems[0]}`}
                {!unknown && !fc.fits && ' The board is placed at true size (not shrunk) — this is the electronics gap, surfaced honestly for the redesign loop.'}
              </div>
            )
          })()}
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
            {res.imported ? 'Imported STEP geometry retained. A rendered preview and fit analysis are not available for this import; no CAD generation is started by opening this view.' : 'Advisory CAD: a generated parametric part sized to the real board — not fit/tolerance-validated for production.'}
          </div>
        </div>
      )}
    </div>
  )
}
