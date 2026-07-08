'use client'

/**
 * Run Overview — the single answer to "did this board pass, recover, fail
 * honestly, or need review?" Consolidates every artifact's status into one
 * verdict + a status grid. Never hides a failure; reads real artifacts only.
 */

import { useEffect, useState } from 'react'
import {
  CheckCircle2, XCircle, Wrench, AlertTriangle, HelpCircle, MinusCircle,
} from 'lucide-react'
import type { Run } from '@/lib/firstlight'
import { describeBoard } from '@/lib/describe-board'

type S =
  | 'passed' | 'failed' | 'recovered' | 'needs_review'
  | 'partial' | 'unsupported' | 'warning' | 'not_generated'

const STYLE: Record<S, string> = {
  passed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  recovered: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  unsupported: 'border-destructive/40 bg-destructive/10 text-destructive',
  needs_review: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  partial: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  not_generated: 'border-border bg-muted/30 text-muted-foreground',
}
function Icon({ s }: { s: S }) {
  if (s === 'passed' || s === 'recovered') return <CheckCircle2 className="size-3.5" />
  if (s === 'failed' || s === 'unsupported') return <XCircle className="size-3.5" />
  if (s === 'recovered') return <Wrench className="size-3.5" />
  if (s === 'not_generated') return <MinusCircle className="size-3.5" />
  if (s === 'needs_review') return <HelpCircle className="size-3.5" />
  return <AlertTriangle className="size-3.5" />
}

export function RunOverview({ runId, run }: { runId: string | null; run?: Run | null }) {
  const [a, setA] = useState<Record<string, any> | null | undefined>(undefined)
  const [promptOpen, setPromptOpen] = useState(false)

  useEffect(() => {
    if (!runId) {
      setA(null)
      return
    }
    let off = false
    const base = `/runs/${runId}/data`
    const files = [
      'last-run.json', 'drc.json', 'recovery-loop.json', 'recovery.json',
      'advanced-routing-report.json', 'sourcing-report.json',
      'assembly-readiness.json', 'fl1-validation.json', 'constraints.json',
      'mcu-selection.json',
    ]
    Promise.all(
      files.map((f) =>
        fetch(`${base}/${f}`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => [f.replace('.json', ''), d] as const)
          .catch(() => [f.replace('.json', ''), null] as const),
      ),
    ).then((pairs) => {
      if (!off) setA(Object.fromEntries(pairs))
    })
    return () => {
      off = true
    }
  }, [runId])

  if (!runId || a === null)
    return <div className="p-4 text-xs text-muted-foreground">Select a run to see its overview.</div>
  if (a === undefined) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>

  const drc = a['drc']
  const hardViol = drc
    ? (drc.violations ?? []).filter((v: any) => v.type !== 'solder_mask_bridge').length
    : null
  const unconn = drc ? (drc.unconnected_items ?? []).length : null
  const status = a['last-run']?.status
  const rec = a['recovery-loop']
  const adv = a['advanced-routing-report']

  // consolidated verdict
  let verdict: S = 'not_generated'
  if (rec?.final_status === 'recovered_and_passed') verdict = 'recovered'
  else if (status === 'PASSED') verdict = 'passed'
  else if (status === 'GATE FAILED') verdict = 'failed'
  else if (status) verdict = 'needs_review'

  const rows: [string, S, string][] = [
    ['Final verdict', verdict, status ?? '—'],
    [
      'Routing',
      unconn === null ? 'not_generated' : unconn === 0 ? 'passed' : 'failed',
      unconn === null ? 'not generated' : `${unconn} unconnected`,
    ],
    [
      'DRC',
      hardViol === null ? 'not_generated' : hardViol === 0 ? 'passed' : 'failed',
      hardViol === null ? 'not generated' : `${hardViol} violation(s)`,
    ],
    [
      'Recovery',
      rec ? (rec.final_status?.includes('passed') ? 'recovered' : 'failed') : 'not_generated',
      rec ? rec.final_status : 'no recovery needed',
    ],
    [
      'Advanced routing',
      adv ? (adv.summary?.advanced_routable ? 'passed' : 'unsupported') : 'not_generated',
      adv
        ? adv.summary?.advanced_routable
          ? `${adv.summary.diff_pairs} pair(s), routable`
          : `unsupported: ${(adv.summary?.blockers ?? []).join(', ')}`
        : 'not generated',
    ],
    [
      'Sourcing',
      a['sourcing-report']
        ? a['sourcing-report'].live_sourcing?.available
          ? 'passed'
          : 'warning'
        : 'not_generated',
      a['sourcing-report'] ? 'fallback mode (no live supplier data)' : 'not generated',
    ],
    [
      'Assembly readiness',
      a['assembly-readiness']
        ? a['assembly-readiness'].ready_for_assembly
          ? 'passed'
          : 'partial'
        : 'not_generated',
      a['assembly-readiness']
        ? a['assembly-readiness'].ready_for_assembly
          ? 'ready'
          : 'not ready'
        : 'not generated',
    ],
    [
      'FL-1 validation package',
      a['fl1-validation'] ? 'passed' : 'not_generated',
      a['fl1-validation'] ? 'generated' : 'not generated',
    ],
  ]

  // ---- board description (title + what this board is), from last-run.json ----
  const lr = a['last-run']
  const spec = lr?.composeSpec
  const board = lr?.board
  const title: string =
    run?.name ?? spec?.boardClass ?? lr?.prompt ?? runId
  const prompt: string | null = lr?.prompt ?? run?.prompt ?? null
  const blocks: string[] = spec?.blocks ?? []
  const purpose = describeBoard(lr)
  const summaryBits: string[] = []
  if (board?.layers) summaryBits.push(`${board.layers}-layer`)
  if (board?.boardSize)
    summaryBits.push(
      `${Math.round(board.boardSize.wMm)} × ${Math.round(board.boardSize.hMm)} mm`,
    )
  if (board?.components) summaryBits.push(`${board.components} components`)
  if (board?.netsTotal) summaryBits.push(`${board.netsTotal} nets`)
  if (blocks.length) summaryBits.push(`${blocks.length} blocks`)
  const summary = summaryBits.length > 0 ? summaryBits.join(' · ') : null

  const warnings: string[] = []
  if (adv?.unsupported_constraints?.length)
    warnings.push(
      `advanced routing: ${adv.unsupported_constraints.map((u: any) => u.pair).join(', ')} unsupported by v1 router`,
    )
  if (a['constraints']?.unsupported?.length)
    warnings.push(
      `constraints: ${a['constraints'].unsupported.map((u: any) => u.feature).join(', ')} unsupported`,
    )

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4 text-xs">
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {purpose && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/90">{purpose}</p>
        )}
        {summary && (
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{summary}</p>
        )}
        {prompt && prompt !== title && (
          <button
            type="button"
            onClick={() => setPromptOpen((v) => !v)}
            title={promptOpen ? 'Collapse prompt' : 'Show full prompt'}
            className="mt-1.5 block w-full cursor-pointer text-left text-[11px] italic text-muted-foreground"
          >
            <span className={promptOpen ? '' : 'line-clamp-2'}>“{prompt}”</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">Run Overview</span>
        <span
          className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] font-semibold ${STYLE[verdict]}`}
        >
          <Icon s={verdict} /> {verdict.replace(/_/g, ' ')}
        </span>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {rows.map(([label, s, detail]) => (
          <div
            key={label}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2"
          >
            <span className="text-muted-foreground">{label}</span>
            <span
              className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] ${STYLE[s]}`}
              title={detail}
            >
              <Icon s={s} /> {s.replace(/_/g, ' ')}
            </span>
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-500">
            <AlertTriangle className="size-3.5" /> Honest warnings / unsupported
          </p>
          {warnings.map((w, i) => (
            <div key={i} className="text-muted-foreground">
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
