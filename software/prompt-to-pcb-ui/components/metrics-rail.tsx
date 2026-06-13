'use client'

import { cn } from '@/lib/utils'
import { ARTIFACTS, type Run } from '@/lib/firstlight'
import { REAL_ARTIFACTS } from '@/lib/real-board'
import { Download, Cpu, Layers, Ruler, Activity } from 'lucide-react'

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

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const w = 96
  const h = 24
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`,
    )
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-6 w-24"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="1.5"
      />
      <circle
        cx={w}
        cy={
          h -
          ((values[values.length - 1] - min) / range) * h
        }
        r="2"
        fill="var(--primary)"
      />
    </svg>
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
  const routingDone = run.stages[2].state === 'passed'

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-foreground">
          <Activity className="size-3.5 text-primary" />
          LIVE METRICS
        </h2>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
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
        <div className="mt-2 flex flex-col gap-1 font-mono text-[11px]">
          <div className="flex justify-between text-foreground">
            <span>flroute</span>
            <span className="tabular-nums">
              {routingDone ? `${run.metrics.routeTimeSec}s · 0 defects` : '—'}
            </span>
          </div>
          <div className="flex justify-between text-muted-foreground/60">
            <span>freerouting</span>
            <span className="tabular-nums">16min · 7 defects</span>
          </div>
        </div>
      </Section>

      <Section title="HPWL PLACEMENT SCORE">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="font-mono text-xl font-semibold tabular-nums text-foreground">
              {run.metrics.hpwl.toLocaleString()}
            </span>
            <span className="text-[11px] text-muted-foreground">
              mm half-perimeter wirelength
            </span>
          </div>
          <Sparkline values={run.metrics.hpwlHistory} />
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

      <Section title="ARTIFACTS">
        {run.real ? (
          <ul className="flex flex-col gap-1">
            {REAL_ARTIFACTS.map((artifact) => (
              <li key={artifact.name}>
                <a
                  href={artifact.href}
                  download
                  className="flex w-full items-center justify-between gap-2 rounded-sm border border-border bg-secondary px-2.5 py-1.5 font-mono text-[11px] text-foreground transition-colors hover:border-primary/40 hover:text-primary"
                >
                  <span className="flex items-center gap-2">
                    <Download className="size-3" />
                    {artifact.name}
                  </span>
                  <span className="text-muted-foreground">real</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
        <ul className="flex flex-col gap-1">
          {ARTIFACTS.map((artifact) => {
            const ready = run.status === 'PASSED'
            return (
              <li key={artifact.name}>
                <button
                  type="button"
                  disabled={!ready}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-sm border border-border px-2.5 py-1.5 font-mono text-[11px] transition-colors',
                    ready
                      ? 'bg-secondary text-foreground hover:border-primary/40 hover:text-primary'
                      : 'bg-secondary/50 text-muted-foreground/50',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Download className="size-3" />
                    {artifact.name}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {ready ? artifact.size : 'gated'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        )}
      </Section>
    </aside>
  )
}
