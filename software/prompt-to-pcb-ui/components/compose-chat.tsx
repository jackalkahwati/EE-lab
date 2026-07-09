'use client'

/**
 * Compose chat — Flux-style conversational panel over the REAL Compose flow:
 *   interview (/api/interview clarifying Q&A)  →  Start  →  live pipeline
 *   (/api/pipeline/run EventSource: design → placement → routing → validation →
 *   ERC → firmware) narrated as a live agent step feed.
 * Threads = runs; "New" starts a fresh interview. Everything shown reflects a
 * real endpoint — the step feed narrates the actual stages/logs, nothing faked.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { llmHeaders } from '@/components/llm-settings'
import { STAGE_DEFS, STAGE_PREFIX, type StageId, type StageState } from '@/lib/firstlight'
import { Plus, Menu, Loader2, Check, X, Circle, Square, Pencil } from 'lucide-react'

type Answer = { question: string; answer: string }
type Question = { type: 'question'; question: string; boardClass?: string; hints?: string[] }
type Spec = { type: 'spec'; boardClass: string; blocks: string[]; summary: string; request: string; layers?: number }
type Ev = { type: string; id?: StageId; state?: StageState; stage?: StageId; text?: string
  level?: string; spec?: any; runDir?: string; status?: string }
type Phase = 'idle' | 'interview' | 'ready' | 'revReady' | 'building' | 'done' | 'error'

// UTF-8-safe base64 (spec can contain µ, ×, em-dash…) — matches the compose page
function b64(json: string) {
  return btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))))
}

export function ComposeChat({ threads, activeId, activeRunId, activeName, newDesign, revisePrefill, onSelectThread, onNew, onRunComplete, onRename, onPrefillConsumed }: {
  threads: { id: string; label: string }[]
  activeId: string
  activeRunId?: string   // the real run currently on screen (revisable)
  activeName?: string    // its display name, for the revision context line
  newDesign?: boolean
  revisePrefill?: string // text to drop into the input (e.g. an FL-1 ECO) as a revision
  onSelectThread: (id: string) => void
  onNew: () => void
  onRunComplete: (runDir: string, id: string) => void
  onRename?: (id: string, name: string) => void
  onPrefillConsumed?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [request, setRequest] = useState('')
  const [answers, setAnswers] = useState<Answer[]>([])
  const [current, setCurrent] = useState<Question | null>(null)
  const [spec, setSpec] = useState<Spec | null>(null)
  const [revSpec, setRevSpec] = useState<{ blocks: string[]; boardClass: string; note: string; request: string } | null>(null)
  const [typed, setTyped] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [stages, setStages] = useState<Record<string, StageState>>({})
  const [logs, setLogs] = useState<{ stage: string; text: string; level?: string }[]>([])
  const [threadsOpen, setThreadsOpen] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [answers, current, spec, logs, phase])
  useEffect(() => () => { esRef.current?.close() }, [])

  // An FL-1 ECO (or any external revision text) drops straight into the input,
  // pre-filled for review; the user edits if needed and presses Send to revise.
  useEffect(() => {
    if (!revisePrefill) return
    setTyped(revisePrefill)
    taRef.current?.focus()
    onPrefillConsumed?.()
  }, [revisePrefill, onPrefillConsumed])

  const ask = useCallback(async (req: string, acc: Answer[]) => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch('/api/interview', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ request: req, answers: acc }),
      })
      const data = await r.json()
      if (data.error) throw new Error(data.error)
      if (data.type === 'spec') { setSpec(data as Spec); setPhase('ready') }
      else { setCurrent(data as Question); setPhase('interview') }
    } catch (e) { setErr(String(e)); setPhase('error') } finally { setLoading(false) }
  }, [])

  function reset() {
    esRef.current?.close(); esRef.current = null
    setPhase('idle'); setRequest(''); setAnswers([]); setCurrent(null); setSpec(null)
    setRevSpec(null); setTyped(''); setErr(null); setStages({}); setLogs([]); onNew()
  }

  // With a built board on screen (not a fresh +New), a chat message REVISES it.
  const reviseMode = !newDesign && !!activeRunId && (phase === 'idle' || phase === 'done')

  const revise = useCallback(async (req: string, runId: string) => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch('/api/revise', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ runId, request: req }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      if (d.changed === false) { setErr(d.note || 'No block-level change needed for this request.'); setPhase('idle') }
      else {
        // /api/revise returns the descriptive name as `boardClass` (camelCase);
        // reading `board_class` here silently dropped it, so the run stored an
        // empty boardClass and fell back to the raw request text as its name.
        setRevSpec({ blocks: d.blocks ?? [], boardClass: d.boardClass ?? '', note: d.note ?? '', request: req })
        setPhase('revReady')
      }
    } catch (e) { setErr(String(e)); setPhase('idle') } finally { setLoading(false) }
  }, [])

  function submit() {
    const v = typed.trim(); if (!v) return
    setTyped('')
    if (reviseMode && activeRunId) { setRequest(v); revise(v, activeRunId) }
    else if (phase === 'idle') { setRequest(v); ask(v, []) }
    else if (phase === 'interview' && current) {
      const next = [...answers, { question: current.question, answer: v }]
      setAnswers(next); setCurrent(null); ask(request, next)
    }
  }

  function startRev() {
    if (!revSpec || !activeRunId) return
    setPhase('building'); setStages({}); setLogs([])
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const payload = b64(JSON.stringify({ blocks: revSpec.blocks, boardClass: revSpec.boardClass }))
    const url = `/api/pipeline/run?prompt=${encodeURIComponent(revSpec.request)}`
      + `&runId=${encodeURIComponent(id)}&compose=1&spec=${encodeURIComponent(payload)}`
      + `&parent=${encodeURIComponent(activeRunId)}&revNote=${encodeURIComponent(revSpec.note || revSpec.request)}`
    const es = new EventSource(url); esRef.current = es
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as Ev
      if (ev.type === 'stage' && ev.id) setStages((s) => ({ ...s, [ev.id!]: ev.state as StageState }))
      else if (ev.type === 'log' && ev.stage && ev.text)
        setLogs((l) => [...l.slice(-60), { stage: ev.stage!, text: ev.text!, level: ev.level }])
      else if (ev.type === 'done') { es.close(); esRef.current = null; setPhase('done'); if (ev.runDir) onRunComplete(ev.runDir, id) }
      else if (ev.type === 'error') { es.close(); esRef.current = null; setErr(ev.text ?? 'pipeline error'); setPhase('error') }
    }
    es.onerror = () => { es.close(); esRef.current = null; setErr('connection lost'); setPhase('error') }
  }

  function start() {
    if (!spec) return
    setPhase('building'); setStages({}); setLogs([])
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const payload = b64(JSON.stringify({ blocks: spec.blocks, boardClass: spec.boardClass, ...(spec.layers ? { layers: spec.layers } : {}) }))
    const url = `/api/pipeline/run?prompt=${encodeURIComponent(request)}`
      + `&runId=${encodeURIComponent(id)}&compose=1&spec=${encodeURIComponent(payload)}`
    const es = new EventSource(url); esRef.current = es
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as Ev
      if (ev.type === 'stage' && ev.id) setStages((s) => ({ ...s, [ev.id!]: ev.state as StageState }))
      else if (ev.type === 'log' && ev.stage && ev.text)
        setLogs((l) => [...l.slice(-60), { stage: ev.stage!, text: ev.text!, level: ev.level }])
      else if (ev.type === 'done') {
        es.close(); esRef.current = null; setPhase('done')
        if (ev.runDir) onRunComplete(ev.runDir, id)
      } else if (ev.type === 'error') { es.close(); esRef.current = null; setErr(ev.text ?? 'pipeline error'); setPhase('error') }
    }
    es.onerror = () => { es.close(); esRef.current = null; setErr('connection lost'); setPhase('error') }
  }

  function stop() { esRef.current?.close(); esRef.current = null; setPhase('done') }

  // A brand-new design has no board yet, so show no run name until it builds.
  const activeLabel = newDesign
    ? 'New design'
    : threads.find((t) => t.id === activeId)?.label ?? 'thread'

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const canRename = !newDesign && !!activeId && !!onRename
  function saveName() {
    const v = editValue.trim()
    if (v && v !== activeLabel && onRename && activeId) onRename(activeId, v)
    setEditing(false)
  }
  const building = phase === 'building'

  const StageIcon = ({ st }: { st: StageState | undefined }) =>
    st === 'passed' ? <Check className="size-3.5 text-emerald-500" />
      : st === 'failed' || st === 'blocked' ? <X className="size-3.5 text-destructive" />
        : st === 'running' ? <Loader2 className="size-3.5 animate-spin text-primary" />
          : <Circle className="size-3 text-muted-foreground/40" />

  return (
    <div className="flex h-full flex-col">
      {/* threads header */}
      <div className="relative flex items-center gap-2 border-b border-border px-3 py-2">
        {editing ? (
          <input autoFocus value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); else if (e.key === 'Escape') setEditing(false) }}
            onBlur={saveName}
            className="min-w-0 flex-1 rounded-sm border border-primary/50 bg-background px-1.5 py-0.5 text-[11px] outline-none" />
        ) : (
          <button type="button" onClick={() => setThreadsOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-secondary/50">
            <Menu className="size-4 shrink-0 text-muted-foreground" />
            <span className={cn('min-w-0 flex-1 truncate text-[11px]',
              newDesign ? 'italic text-muted-foreground' : 'font-medium')}>{activeLabel}</span>
            <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{threads.length}</span>
          </button>
        )}
        {!editing && canRename && (
          <button type="button" title="rename board"
            onClick={() => { setEditValue(activeLabel); setEditing(true) }}
            className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground">
            <Pencil className="size-3" />
          </button>
        )}
        <button type="button" onClick={reset}
          className="flex shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20">
          <Plus className="size-3" /> New
        </button>

        {threadsOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setThreadsOpen(false)} />
            <div className="absolute left-2 top-full z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-xl">
              <div className="px-2 py-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Threads</div>
              {threads.length === 0 && <p className="px-2 py-2 text-[11px] text-muted-foreground">No threads yet — start one with New.</p>}
              {threads.map((t) => (
                <button key={t.id} type="button"
                  onClick={() => { onSelectThread(t.id); setThreadsOpen(false) }}
                  className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11px]',
                    t.id === activeId ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground')}>
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  {t.id === activeId && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* thread body */}
      <div ref={bodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {phase === 'idle' && !reviseMode && (
          <p className="text-muted-foreground">
            Describe the board you want and I&apos;ll ask a few questions, then build it.
            <span className="mt-1 block text-[11px]">e.g. &ldquo;8-probe relay test matrix, RP2040, 24V&rdquo;</span>
          </p>
        )}
        {phase === 'idle' && reviseMode && (
          <p className="text-muted-foreground">
            Describe a change to revise <span className="font-medium text-foreground">{activeName || 'this board'}</span> into a new revision, or click <span className="font-medium">New</span> for a fresh board.
            <span className="mt-1 block text-[11px]">e.g. &ldquo;swap the RP2040 for an STM32&rdquo; · &ldquo;add a pressure sensor&rdquo; · &ldquo;drop the CAN transceiver&rdquo;</span>
          </p>
        )}

        {/* interview turns */}
        {answers.map((a, i) => (
          <div key={i} className="space-y-1.5">
            <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">{a.question}</div>
            <div className="ml-8 rounded-lg rounded-tr-sm bg-primary/15 px-3 py-2 text-[13px] text-foreground">{a.answer}</div>
          </div>
        ))}
        {current && (
          <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">
            {current.boardClass && (
              <span className="mb-1 mr-2 inline-block rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary">{current.boardClass}</span>
            )}
            {current.question}
          </div>
        )}
        {loading && <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> thinking…</div>}
        {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}

        {/* plan ready */}
        {phase === 'ready' && spec && (
          <div className="space-y-2">
            <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">
              I&apos;ve got a plan ready{spec.boardClass ? ` for a ${spec.boardClass}` : ''}. {spec.summary}
              {spec.blocks?.length ? <span className="mt-1 block font-mono text-[10px] text-muted-foreground">blocks: {spec.blocks.join(' · ')}</span> : null}
            </div>
            <button type="button" onClick={start}
              className="ml-8 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
              Yes, build it →
            </button>
          </div>
        )}

        {/* revision plan ready */}
        {phase === 'revReady' && revSpec && (
          <div className="space-y-2">
            <div className="ml-8 rounded-lg rounded-tr-sm bg-primary/15 px-3 py-2 text-[13px] text-foreground">{revSpec.request}</div>
            <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">
              Revision of <span className="font-medium">{activeName || 'the board'}</span>: {revSpec.note}
              {revSpec.blocks?.length ? <span className="mt-1 block font-mono text-[10px] text-muted-foreground">new blocks: {revSpec.blocks.join(' · ')}</span> : null}
            </div>
            <div className="ml-8 flex gap-2">
              <button type="button" onClick={startRev}
                className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
                Build revision →
              </button>
              <button type="button" onClick={() => { setRevSpec(null); setPhase('done') }}
                className="rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* live agent step feed */}
        {(building || phase === 'done') && (
          <div className="space-y-1.5 rounded-md border border-border p-2.5">
            {STAGE_DEFS.map((d) => {
              const st = stages[d.id]
              const stageLogs = logs.filter((l) => l.stage === d.id).slice(-4)
              return (
                <div key={d.id}>
                  <div className="flex items-center gap-2">
                    <StageIcon st={st} />
                    <span className={cn('text-[13px]', st === 'running' ? 'font-medium text-foreground' : st ? 'text-foreground' : 'text-muted-foreground/60')}>{d.label}</span>
                  </div>
                  {stageLogs.length > 0 && (
                    <div className="ml-5 mt-0.5 space-y-0.5">
                      {stageLogs.map((l, i) => (
                        <div key={i} className={cn('font-mono text-[10px]', l.level === 'err' ? 'text-destructive' : 'text-muted-foreground')}>
                          {STAGE_PREFIX[l.stage as StageId] ?? l.stage}: {l.text}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* working bar */}
      {building && (
        <div className="flex items-center gap-2 border-t border-border bg-primary/[0.06] px-3 py-2">
          <Loader2 className="size-3.5 animate-spin text-primary" />
          <span className="text-[12px] font-medium text-primary">Compose is working…</span>
          <button type="button" onClick={stop}
            className="ml-auto flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
            <Square className="size-2.5" /> Stop
          </button>
        </div>
      )}

      {/* input */}
      <div className="border-t border-border p-2">
        <div className="flex items-end gap-2 rounded-md border border-border bg-background p-1.5 focus-within:border-primary/50">
          <textarea
            ref={taRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            disabled={building || loading || phase === 'ready' || phase === 'revReady'}
            rows={1}
            placeholder={phase === 'ready' ? 'press “Yes, build it” above'
              : phase === 'revReady' ? 'press “Build revision” above'
                : phase === 'interview' ? 'type your answer…'
                  : reviseMode ? 'Describe a change to revise this board…'
                    : phase === 'idle' ? 'Describe the board…' : 'start a new thread with + New'}
            className="max-h-24 min-h-[1.5rem] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          <button type="button" onClick={submit} disabled={!typed.trim() || building || loading || phase === 'ready' || phase === 'revReady'}
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
            Send ↵
          </button>
        </div>
      </div>
    </div>
  )
}
