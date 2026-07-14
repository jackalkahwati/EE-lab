/**
 * One product program in the portfolio grid: latest-run thumbnail, honest
 * status chips (real DRC verdict, disciplines actually on disk, pipeline
 * time), run count and latest date. Links into the program's run history.
 */
import Link from 'next/link'
import type { Program } from '@/lib/programs'
import { Chip, DisciplinesChip, DrcChip, TimingChip } from '@/components/programs/chips'

export function ProgramCard({ program }: { program: Program }) {
  const { latest } = program
  return (
    <Link
      href={`/programs/${program.slug}`}
      className="flex flex-col rounded-md border border-border bg-card/40 p-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-background">
          {latest.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={latest.thumbnail}
              alt={`${program.name} board`}
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="font-mono text-[9px] text-muted-foreground">no render</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight">{program.name}</div>
          {latest.description && (
            <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {latest.description}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <DrcChip drc={latest.drc} />
        <DisciplinesChip disciplines={latest.disciplines} />
        <TimingChip totalMs={latest.totalMs} />
        {latest.boardDims && <Chip>{latest.boardDims}</Chip>}
      </div>

      <div className="mt-2 flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
        <span>
          {program.runs.length} run{program.runs.length === 1 ? '' : 's'}
        </span>
        <span>latest {latest.dateLabel}</span>
      </div>
    </Link>
  )
}
