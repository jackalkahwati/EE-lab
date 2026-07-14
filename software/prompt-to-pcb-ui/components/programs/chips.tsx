/**
 * Honest status chips for the Programs portfolio. Server components — every
 * chip renders a value read verbatim from a run artifact; absence renders as
 * "not built" / "not run", never as a guess.
 */
import { cn } from '@/lib/utils'
import { fmtDuration, type RunDrc } from '@/lib/programs'

export function Chip({
  tone = 'muted',
  children,
}: {
  tone?: 'green' | 'red' | 'amber' | 'muted'
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
        tone === 'green' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
        tone === 'red' && 'border-destructive/40 bg-destructive/10 text-destructive',
        tone === 'amber' && 'border-amber-500/40 bg-amber-500/10 text-amber-500',
        tone === 'muted' && 'border-border bg-muted/30 text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

export function DrcChip({ drc }: { drc: RunDrc }) {
  if (drc.state === 'clean') return <Chip tone="green">DRC clean</Chip>
  if (drc.state === 'errors')
    return <Chip tone="red">DRC: {drc.errors} error{drc.errors === 1 ? '' : 's'}</Chip>
  if (drc.state === 'not_run') return <Chip tone="amber">DRC not run</Chip>
  return <Chip>board not built</Chip>
}

export function DisciplinesChip({ disciplines }: { disciplines: string[] }) {
  if (disciplines.length === 0) return <Chip>disciplines not built</Chip>
  return <Chip tone="muted">{disciplines.length} discipline{disciplines.length === 1 ? '' : 's'}</Chip>
}

export function TimingChip({ totalMs }: { totalMs: number | null }) {
  if (totalMs == null) return null
  return <Chip tone="muted">{fmtDuration(totalMs)}</Chip>
}
