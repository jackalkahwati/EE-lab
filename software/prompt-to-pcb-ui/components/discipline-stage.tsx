'use client'

/**
 * Discipline stage — the reusable view for the separate Firmware / Manufacturing
 * / Supply chain / Validation modules. One component, four modules: it's
 * parameterized by `discipline` and renders that module's generated artifact
 * (structured sections) with an honest fidelity label. Generic — nothing here is
 * domain-specific.
 */
import { useState, useEffect, useRef } from 'react'
import { Loader2, FileText } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'
import { DISCIPLINE_MODULES } from '@/lib/discipline-artifact'

type Artifact = {
  discipline: string; title: string; summary: string; fidelity: string
  sections: { title: string; items: string[] }[]
}

function validArtifact(d: any, discipline: string): d is Artifact {
  return d && d.discipline === discipline && typeof d.title === 'string'
    && typeof d.fidelity === 'string' && Array.isArray(d.sections)
    && d.sections.every((s: any) => s && typeof s.title === 'string'
      && Array.isArray(s.items) && s.items.every((item: unknown) => typeof item === 'string'))
}

type Props = { discipline: string; spec: any; runId?: string; onBuilt?: () => void; generationDisabled?: boolean; onBuildStart?: () => boolean | void | Promise<boolean | void>; onBuildSettled?: (result: { status: 'passed' | 'failed' | 'unknown'; detail?: string; artifactAvailable?: boolean }) => void | Promise<void> }

export function DisciplineStage(props: Props) {
  return <DisciplineArtifactView key={JSON.stringify([props.runId, props.discipline])} {...props} />
}

function DisciplineArtifactView({ discipline, spec, runId, onBuilt, onBuildStart, onBuildSettled, generationDisabled }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'generating' | 'missing' | 'done' | 'error'>(runId ? 'loading' : 'idle')
  const [art, setArt] = useState<Artifact | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const mod = DISCIPLINE_MODULES[discipline]
  const [retry, setRetry] = useState(0)
  const [operation, setOperation] = useState<'read' | 'generate'>('read')
  const request = useRef({ version: 0, generating: false })
  const readController = useRef<AbortController | null>(null)

  // Reads are cancelable. An explicit generation keeps running on the server if
  // this view closes, but its obsolete response must never update another view.
  useEffect(() => {
    const scope = request.current
    const token = ++scope.version
    const controller = new AbortController()
    readController.current = controller
    setArt(null); setErr(null); setOperation('read')
    setState(runId ? 'loading' : 'idle')
    if (runId) {
      fetch(`/runs/${runId}/disciplines/${discipline}.json`, { cache: 'no-store', signal: controller.signal })
        .then(async (r) => {
          if (r.status === 404) return null
          if (!r.ok) throw new Error(`Could not load artifact (${r.status}).`)
          const d = await r.json()
          if (!validArtifact(d, discipline)) throw new Error('The saved artifact is invalid.')
          return d
        })
        .then((d) => {
          if (scope.version !== token || controller.signal.aborted) return
          setArt(d); setState(d ? 'done' : 'missing')
        })
        .catch((e) => {
          if (scope.version !== token || controller.signal.aborted) return
          setErr(String(e)); setState('error')
        })
    }
    return () => { ++scope.version; controller.abort() }
  }, [runId, discipline, retry])

  async function run() {
    if (!spec || !runId || generationDisabled || request.current.generating) return
    const scope = request.current
    const token = ++scope.version
    scope.generating = true
    const start = onBuildStart
    const settled = onBuildSettled
    let submitted = false
    let outcome: Parameters<NonNullable<Props['onBuildSettled']>>[0] = { status: 'unknown', detail: 'Document request outcome unknown. Server work may continue.' }
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
      const r = await fetch('/api/discipline', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ spec, runId, discipline }),
      })
      const d = await r.json()
      if (d?.error) outcome = { status: 'failed', detail: String(d.error) }
      if (!r.ok || d.error) throw new Error(d.error || `Generation failed (${r.status}).`)
      if (!validArtifact(d.artifact, discipline)) throw new Error('The generated artifact is invalid.')
      outcome = { status: d.ok === true ? 'passed' : 'unknown', detail: 'Document artifact returned; not physical or manufacturing approval.', artifactAvailable: true }
      if (scope.version !== token) return
      setArt(d.artifact); setState('done'); onBuilt?.()
    } catch (e) {
      if (scope.version !== token) return
      setErr(String(e)); setState('error')
    } finally {
      if (!submitted) outcome = { status: 'unknown', detail: 'Generation was not submitted.' }
      try { await settled?.(outcome) } catch (e) {
        if (scope.version === token) { setErr(`Could not record generation outcome: ${String(e)}`); setState('error') }
      } finally { scope.generating = false }
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{mod?.label ?? discipline}</span>
        <button type="button" onClick={run} disabled={!spec || !runId || generationDisabled || state === 'generating'} title={generationDisabled ? 'Generation is managed by the active pipeline.' : undefined}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'generating' ? <Loader2 className="size-3 animate-spin" /> : <FileText className="size-3" />}
          {state === 'generating' ? 'Generating…' : state === 'error' && operation === 'generate' ? 'Retry generation' : art ? 'Regenerate' : `Generate ${mod?.label?.toLowerCase() ?? discipline}`}
        </button>
      </div>

      {!spec && <p className="text-sm text-muted-foreground">Describe a product first.</p>}
      {state === 'idle' && spec && (
        <p className="text-sm text-muted-foreground">
          Generate the {mod?.label?.toLowerCase()} artifact from the product spec + the real board. Fidelity: <span className="text-foreground">{mod?.fidelity}</span> — generated/advisory, not validated.
        </p>
      )}
      {state === 'loading' && <p role="status" className="text-sm text-muted-foreground">Loading saved artifact…</p>}
      {state === 'generating' && <p role="status" className="text-sm text-muted-foreground">Generating artifact…</p>}
      {state === 'missing' && <p role="status" className="text-sm text-muted-foreground">No saved {mod?.label?.toLowerCase() ?? discipline} artifact for this run.</p>}
      {state === 'error' && <div role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}
      {(state === 'missing' || (state === 'error' && operation === 'read')) && (
        <button type="button" onClick={() => setRetry((n) => n + 1)} className="mt-2 self-start rounded-md border border-border px-3 py-1 text-xs">Retry loading artifact</button>
      )}

      {art && state === 'done' && (
        <div className="space-y-3">
          <div>
            <div className="text-[15px] font-semibold text-foreground">{art.title}</div>
            {art.summary && <p className="mt-0.5 text-[13px] text-muted-foreground">{art.summary}</p>}
            <span className="mt-1 inline-block rounded-sm bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] uppercase text-amber-600 dark:text-amber-400">{art.fidelity}</span>
          </div>
          {art.sections.map((s, i) => (
            <div key={i} className="rounded-md border border-border p-3">
              <div className="text-[12px] font-semibold text-foreground">{s.title}</div>
              <ul className="mt-1 space-y-1">
                {s.items.map((it, j) => (
                  <li key={j} className="flex gap-1.5 text-[12px] text-muted-foreground">
                    <span className="text-muted-foreground/50">·</span>{it}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
