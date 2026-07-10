'use client'

import { cn } from '@/lib/utils'
import type { Run } from '@/lib/firstlight'
import { Cpu, Layers, Ruler, Activity } from 'lucide-react'

function RoutingRadial({ run }: { run: Run }) {
  const pct =
    run.metrics.netsTotal > 0
      ? run.metrics.netsRouted / run.metrics.netsTotal
      : 0
  const r = 42
  const circ = 2 * Math.PI * r

  return (
    <div className="flex items-center gap-4">
      <svg
        viewBox="0 0 100 100"
        className="size-24 shrink-0"
        role="img"
        aria-label={`Routing completion ${Math.round(pct * 100)} percent`}
      >
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth="6"
        />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="6"
          strokeLinecap="butt"
          strokeDasharray={`${circ * pct} ${circ}`}
          transform="rotate(-90 50 50)"
          className="transition-all duration-300"
        />
        <text
          x="50"
          y="47"
          textAnchor="middle"
          fontSize="17"
          fill="var(--foreground)"
          fontFamily="var(--font-jetbrains-mono)"
          fontWeight="600"
        >
          {Math.round(pct * 100)}%
        </text>
        <text
          x="50"
          y="62"
          textAnchor="middle"
          fontSize="8"
          fill="var(--muted-foreground)"
          fontFamily="var(--font-jetbrains-mono)"
        >
          routed
        </text>
      </svg>
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
          {run.metrics.netsRouted}/{run.metrics.netsTotal}
        </span>
        <span className="text-xs text-muted-foreground">nets routed</span>
        <span className="mt-1 font-mono text-[10px] text-muted-foreground">
          emission gate: DRC-clean only
        </span>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-border px-4 py-3">
      <h3 className="mb-2.5 font-mono text-[10px] tracking-widest text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

export function MetricsRail({ run }: { run: Run }) {
  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-foreground">
          <Activity className="size-3.5 text-primary" />
          METRICS
        </h2>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={run.id}>
          {run.name}
        </p>
      </div>

      <Section title="ROUTING COMPLETION">
        <RoutingRadial run={run} />
      </Section>

      <Section title="COPPER DRC">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'font-mono text-2xl font-semibold tabular-nums',
              run.metrics.copperDefects === 0
                ? 'text-success'
                : 'text-destructive',
            )}
          >
            {run.metrics.copperDefects}
          </span>
          <span className="text-xs text-muted-foreground">
            copper DRC defects
          </span>
        </div>
      </Section>

      <Section title="BOARD">
        <dl className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1 rounded-sm border border-border bg-secondary p-2">
            <dt className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Cpu className="size-3" /> parts
            </dt>
            <dd className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {run.metrics.components}
            </dd>
          </div>
          <div className="flex flex-col gap-1 rounded-sm border border-border bg-secondary p-2">
            <dt className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Ruler className="size-3" /> size
            </dt>
            <dd className="font-mono text-[11px] font-semibold tabular-nums text-foreground">
              {run.metrics.boardSize}
            </dd>
          </div>
          <div className="flex flex-col gap-1 rounded-sm border border-border bg-secondary p-2">
            <dt className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Layers className="size-3" /> layers
            </dt>
            <dd className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {run.metrics.layers}
            </dd>
          </div>
        </dl>
      </Section>

    </aside>
  )
}
