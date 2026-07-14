/**
 * Programs — the product-program portfolio, derived from the REAL runs
 * persisted under public/runs/. Server component: reads artifacts off disk
 * per request (no API hop), tolerant of malformed runs, capped at the newest
 * 100 run directories. Every status chip is read verbatim from an artifact.
 */
import { loadPrograms } from '@/lib/programs'
import { ProgramCard } from '@/components/programs/program-card'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Programs · Firstlight' }

export default function ProgramsPage() {
  const programs = loadPrograms()
  const runCount = programs.reduce((n, p) => n + p.runs.length, 0)

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-4 flex items-baseline gap-3">
        <h1 className="text-base font-semibold">Programs</h1>
        <span className="font-mono text-[11px] text-muted-foreground">
          {programs.length} program{programs.length === 1 ? '' : 's'} · {runCount} run
          {runCount === 1 ? '' : 's'} on disk
        </span>
      </div>

      {programs.length === 0 ? (
        <div className="rounded-md border border-border p-6 text-muted-foreground">
          No runs found under <code className="rounded bg-muted px-1">public/runs/</code>. Start a
          design in Compose to create the first program.
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {programs.map((p) => (
            <ProgramCard key={p.slug} program={p} />
          ))}
        </div>
      )}
    </div>
  )
}
