'use client'

import { cn } from '@/lib/utils'
import { Check, X, Loader2, Circle, MinusCircle, Lock, type LucideIcon } from 'lucide-react'
import { workspaceStageLabel, type WorkspaceStageStatus, type WorkspaceHistoryState } from '@/lib/workspace-state'

export type TimelineState = WorkspaceStageStatus
export interface TimelineStage {
  key: string
  label: string
  Icon: LucideIcon
  state?: TimelineState
  detail?: string
  badged?: 'passed' | 'failed'
  locked?: boolean
  advisory?: boolean
}
function Dot({ state, locked }: { state?: TimelineState; locked?: boolean }) {
  if (locked) return <Lock className="size-3" />
  if (state === 'running') return <Loader2 className="size-3 animate-spin text-primary" />
  if (state === 'passed') return <Check className="size-3 text-success" />
  if (state === 'failed') return <X className="size-3 text-destructive" />
  if (state === 'blocked' || state === 'skipped') return <MinusCircle className="size-3" />
  return <Circle className="size-2.5" />
}

/** Compact navigation, not a sequential schedule: several stages can be running. */
export function RunTimeline({ stages, active, onSelect, className, historyState = 'none' }: {
  stages: TimelineStage[]; active: string; onSelect: (key: string) => void; className?: string; historyState?: WorkspaceHistoryState
}) {
  const current = stages.find((stage) => stage.key === active)
  return <nav aria-label="Pipeline stages" className={cn('workspace-timeline', className)}>
    <label className="workspace-stage-picker">
      <span>Stage</span>
      <select aria-label="Preview stage" value={active} onChange={(event) => onSelect(event.target.value)}>
        {!current && <option value="">Choose stage</option>}
        {stages.map((stage) => <option key={stage.key} value={stage.key} disabled={stage.locked}>
          {stage.label} · {stage.locked ? 'needs product' : workspaceStageLabel(stage.state, historyState)}{stage.advisory ? ' · advisory' : ''}
        </option>)}
      </select>
      {current?.detail && <span className="workspace-stage-detail" title={current.detail}>{current.detail}</span>}
    </label>
    <div className="workspace-stage-grid">
      {stages.map((stage) => <button key={stage.key} type="button" disabled={stage.locked}
        aria-current={stage.key === active ? 'step' : undefined}
        title={stage.locked ? `${stage.label}: describe a product first` : stage.detail || `${stage.label}: ${workspaceStageLabel(stage.state, historyState)}${stage.advisory ? ', advisory' : ''}`}
        onClick={() => onSelect(stage.key)}>
        <span aria-hidden><Dot state={stage.state} locked={stage.locked} /></span>
        <span>{stage.label}</span>
        <span className="workspace-stage-state">{stage.locked ? 'locked' : workspaceStageLabel(stage.state, historyState)}</span>
        {stage.badged && <span className="sr-only">New {stage.badged} result</span>}
      </button>)}
    </div>
  </nav>
}
