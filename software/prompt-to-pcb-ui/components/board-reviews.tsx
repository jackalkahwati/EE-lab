'use client'

/**
 * Reviews pill (the Flux ✗/⚠/ⓘ analog), from REAL board data only:
 *   ✗ errors   = open (unrouted) nets + unconnected pads
 *   ⚠ warnings = zone-served nets + generic-sourced BOM lines (need a real MPN)
 *   ⓘ checks   = gate reports run
 * Nothing invented; a green pill means the real artifacts say so.
 */
import { cn } from '@/lib/utils'
import type { RealBoard } from '@/lib/real-board'
import { CircleAlert, Info, XCircle } from 'lucide-react'

export function ReviewsPill({ real }: { real: RealBoard | null }) {
  if (!real) return null
  const b: any = real.board ?? {}
  const errors = (b.unroutedNets?.length ?? 0) + (b.drc?.unconnectedItems ?? 0)
  const warnings = (b.zoneServedNets?.length ?? 0)
    + (real.bom ?? []).filter((l: any) => l.sourcingStatus === 'generic').length
  const checks = (real.reports ?? []).length
  const tone = errors > 0 ? 'border-destructive/40 bg-destructive/10'
    : warnings > 0 ? 'border-amber-500/40 bg-amber-500/10'
      : 'border-emerald-500/40 bg-emerald-500/10'

  return (
    <span className={cn('flex items-center gap-2 rounded-full border px-2 py-0.5 font-mono text-[10px]', tone)}
      title="open nets + unconnected pads · zone-served nets + generic-sourced parts · checks run">
      <span className="flex items-center gap-0.5 text-destructive"><XCircle className="size-3" />{errors}</span>
      <span className="flex items-center gap-0.5 text-amber-500"><CircleAlert className="size-3" />{warnings}</span>
      <span className="flex items-center gap-0.5 text-muted-foreground"><Info className="size-3" />{checks}</span>
      <span className="text-muted-foreground">Reviews</span>
    </span>
  )
}
