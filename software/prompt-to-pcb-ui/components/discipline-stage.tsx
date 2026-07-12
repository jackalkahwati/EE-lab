'use client'

/**
 * Discipline stage — the reusable view for the separate Firmware / Manufacturing
 * / Supply chain / Validation modules. One component, four modules: it's
 * parameterized by `discipline` and renders that module's generated artifact
 * (structured sections) with an honest fidelity label. Generic — nothing here is
 * domain-specific.
 */
import { useState } from 'react'
import { Loader2, FileText } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'
import { DISCIPLINE_MODULES } from '@/lib/discipline-artifact'

type Artifact = {
  discipline: string; title: string; summary: string; fidelity: string
  sections: { title: string; items: string[] }[]
}

export function DisciplineStage({ discipline, spec, runId }: { discipline: string; spec: any; runId?: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [art, setArt] = useState<Artifact | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const mod = DISCIPLINE_MODULES[discipline]

  async function run() {
    if (!spec) return
    setState('loading'); setErr(null)
    try {
      const r = await fetch('/api/discipline', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ spec, runId, discipline }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setArt(d.artifact); setState('done')
    } catch (e) { setErr(String(e)); setState('error') }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{mod?.label ?? discipline}</span>
        <button type="button" onClick={run} disabled={!spec || state === 'loading'}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <FileText className="size-3" />}
          {art ? 'Regenerate' : `Generate ${mod?.label?.toLowerCase() ?? discipline}`}
        </button>
      </div>

      {!spec && <p className="text-sm text-muted-foreground">Describe a product first.</p>}
      {state === 'idle' && spec && (
        <p className="text-sm text-muted-foreground">
          Generate the {mod?.label?.toLowerCase()} artifact from the product spec + the real board. Fidelity: <span className="text-foreground">{mod?.fidelity}</span> — generated/advisory, not validated.
        </p>
      )}
      {state === 'error' && <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}

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
