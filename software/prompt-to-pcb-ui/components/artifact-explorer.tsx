'use client'

/**
 * Artifact Explorer — every file a run generated, in one place: name, type,
 * phase, generated/not_generated status, JSON/Markdown preview, and download.
 * Honest: an artifact that was not generated is shown as not_generated, never
 * implied to exist.
 */

import { useEffect, useState } from 'react'
import { FileJson, FileText, FileSpreadsheet, Image, Download, ChevronRight } from 'lucide-react'

type Kind = 'json' | 'md' | 'csv' | 'png'
interface Art {
  name: string
  file: string
  kind: Kind
  phase: string
}

const CATALOG: Art[] = [
  { name: 'Board (JSON)', file: 'board.json', kind: 'json', phase: 'Design' },
  { name: 'Constraints', file: 'constraints.json', kind: 'json', phase: 'Design' },
  { name: 'Advanced routing report', file: 'advanced-routing-report.json', kind: 'json', phase: 'Design' },
  { name: 'Advanced routing (MD)', file: 'advanced-routing-report.md', kind: 'md', phase: 'Design' },
  { name: 'Stackup plan', file: 'stackup-plan.json', kind: 'json', phase: 'Design' },
  { name: 'Impedance plan', file: 'impedance-plan.json', kind: 'json', phase: 'Design' },
  { name: 'MCU selection', file: 'mcu-selection.json', kind: 'json', phase: 'Design' },
  { name: 'Pin assignment', file: 'pin-assignment.json', kind: 'json', phase: 'Design' },
  { name: 'Pin assignment (MD)', file: 'pin-assignment.md', kind: 'md', phase: 'Design' },
  { name: 'BOM', file: 'bom.json', kind: 'json', phase: 'Build' },
  { name: 'Assembly BOM (CSV)', file: 'bom.csv', kind: 'csv', phase: 'Build' },
  { name: 'Pick-and-place', file: 'pick_and_place.csv', kind: 'csv', phase: 'Build' },
  { name: 'Assembly readiness', file: 'assembly-readiness.json', kind: 'json', phase: 'Build' },
  { name: 'Assembly readiness (MD)', file: 'assembly-readiness.md', kind: 'md', phase: 'Build' },
  { name: 'Sourcing report', file: 'sourcing-report.json', kind: 'json', phase: 'Build' },
  { name: 'Substitutions', file: 'substitutions.json', kind: 'json', phase: 'Build' },
  { name: 'DRC report', file: 'drc.json', kind: 'json', phase: 'Validate' },
  { name: 'FL-1 validation package', file: 'fl1-validation.json', kind: 'json', phase: 'Validate' },
  { name: 'FL-1 test plan', file: 'fl1-testplan.json', kind: 'json', phase: 'Validate' },
  { name: 'Recovery loop report', file: 'recovery-loop.json', kind: 'json', phase: 'Validate' },
  { name: 'Recovery / substitutions', file: 'recovery.json', kind: 'json', phase: 'Validate' },
  { name: 'Power budget', file: 'power-budget.json', kind: 'json', phase: 'Validate' },
  { name: 'Run log (MD)', file: 'last-run.md', kind: 'md', phase: 'Validate' },
  { name: 'Top render', file: '../board/render-top.png', kind: 'png', phase: 'Design' },
]

const ICON: Record<Kind, any> = { json: FileJson, md: FileText, csv: FileSpreadsheet, png: Image }

export function ArtifactExplorer({ runId }: { runId: string | null }) {
  const [present, setPresent] = useState<Record<string, boolean> | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [preview, setPreview] = useState<string>('')

  useEffect(() => {
    if (!runId) {
      setPresent(null)
      return
    }
    let off = false
    Promise.all(
      CATALOG.map((a) =>
        fetch(`/runs/${runId}/data/${a.file}`, { method: 'HEAD', cache: 'no-store' })
          .then((r) => [a.file, r.ok] as const)
          .catch(() => [a.file, false] as const),
      ),
    ).then((pairs) => !off && setPresent(Object.fromEntries(pairs)))
    return () => {
      off = true
    }
  }, [runId])

  if (!runId) return <div className="p-4 text-xs text-muted-foreground">Select a run to explore its artifacts.</div>
  if (present === null) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>

  const showPreview = (a: Art) => {
    if (open === a.file) {
      setOpen(null)
      return
    }
    setOpen(a.file)
    setPreview('')
    if (a.kind === 'json' || a.kind === 'md' || a.kind === 'csv') {
      fetch(`/runs/${runId}/data/${a.file}`, { cache: 'no-store' })
        .then((r) => r.text())
        .then((t) => setPreview(a.kind === 'json' ? JSON.stringify(JSON.parse(t), null, 1) : t))
        .catch(() => setPreview('(could not load)'))
    }
  }

  const phases = ['Design', 'Build', 'Validate']
  const genCount = Object.values(present).filter(Boolean).length

  return (
    <div className="space-y-3 overflow-y-auto p-4 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">Artifacts</span>
        <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {genCount} generated · {CATALOG.length - genCount} not generated
        </span>
      </div>

      {phases.map((ph) => (
        <div key={ph}>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">{ph}</p>
          <div className="space-y-1">
            {CATALOG.filter((a) => a.phase === ph).map((a) => {
              const ok = present[a.file]
              const IconC = ICON[a.kind]
              return (
                <div key={a.file} className="rounded-md border border-border">
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <IconC className={`size-3.5 ${ok ? 'text-primary' : 'text-muted-foreground/40'}`} />
                    <span className={ok ? 'text-foreground' : 'text-muted-foreground/50'}>{a.name}</span>
                    <span className="font-mono text-[9px] text-muted-foreground">{a.kind}</span>
                    {ok ? (
                      <span className="ml-auto flex items-center gap-2">
                        {a.kind !== 'png' && (
                          <button
                            type="button"
                            onClick={() => showPreview(a)}
                            className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            <ChevronRight className={`size-3 transition-transform ${open === a.file ? 'rotate-90' : ''}`} />
                            preview
                          </button>
                        )}
                        <a
                          href={`/runs/${runId}/data/${a.file}`}
                          download
                          className="inline-flex items-center gap-0.5 text-[10px] text-primary hover:underline"
                        >
                          <Download className="size-3" /> download
                        </a>
                      </span>
                    ) : (
                      <span className="ml-auto rounded-sm border border-border bg-muted/30 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                        not_generated
                      </span>
                    )}
                  </div>
                  {open === a.file && (
                    <pre className="max-h-64 overflow-auto border-t border-border bg-muted/20 p-2 font-mono text-[9px] text-muted-foreground">
                      {preview || 'loading…'}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
