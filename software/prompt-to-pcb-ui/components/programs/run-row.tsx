/**
 * One run inside a program's history: short id, date, board dims, honest DRC
 * chip, disciplines on disk, direct artifact links, and an "Open in Compose"
 * jump (Compose restores runs from its own ☰ history menu).
 */
import Link from 'next/link'
import type { RunSummary } from '@/lib/programs'
import { Chip, DisciplinesChip, DrcChip, TimingChip } from '@/components/programs/chips'

export function RunRow({ run }: { run: RunSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-card/40 px-3 py-2">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-background">
        {run.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={run.thumbnail} alt="" className="h-full w-full object-contain" />
        ) : (
          <span className="font-mono text-[8px] text-muted-foreground">—</span>
        )}
      </div>

      <div className="min-w-[130px]">
        <div className="font-mono text-[11px] text-foreground" title={run.dir}>
          {run.shortId}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground">{run.dateLabel}</div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {run.boardDims && <Chip>{run.boardDims}</Chip>}
        <DrcChip drc={run.drc} />
        <DisciplinesChip disciplines={run.disciplines} />
        <TimingChip totalMs={run.totalMs} />
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2 font-mono text-[10px]">
        {run.links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {l.label}
          </a>
        ))}
        <Link
          href="/compose"
          className="rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-primary hover:bg-primary/20"
        >
          Open in Compose
        </Link>
      </div>

      {run.disciplines.length > 0 && (
        <div className="w-full font-mono text-[10px] text-muted-foreground">
          disciplines: {run.disciplines.join(' · ')}
        </div>
      )}
    </div>
  )
}
