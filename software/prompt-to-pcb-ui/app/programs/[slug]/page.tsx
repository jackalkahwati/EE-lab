/**
 * One product program: its run history, newest first, with honest per-run
 * status (real DRC verdict, disciplines on disk, board dims, pipeline time)
 * and direct artifact links. Server component, filesystem-backed.
 */
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { loadProgram } from '@/lib/programs'
import { RunRow } from '@/components/programs/run-row'

export const dynamic = 'force-dynamic'

export default async function ProgramPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const program = loadProgram(slug)
  if (!program) notFound()

  const { latest } = program

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <Link
        href="/programs"
        className="mb-3 inline-block font-mono text-[11px] text-muted-foreground hover:text-foreground"
      >
        ← All programs
      </Link>

      <div className="mb-4 flex items-start gap-4">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-card/40">
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
          <h1 className="text-base font-semibold leading-tight">{program.name}</h1>
          {latest.description && (
            <p className="mt-1 max-w-2xl text-[11px] leading-snug text-muted-foreground">
              {latest.description}
            </p>
          )}
          <div className="mt-2 font-mono text-[10px] text-muted-foreground">
            {program.runs.length} run{program.runs.length === 1 ? '' : 's'} · latest{' '}
            {latest.dateLabel}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        {program.runs.map((r) => (
          <RunRow key={r.dir} run={r} />
        ))}
      </div>
    </div>
  )
}
