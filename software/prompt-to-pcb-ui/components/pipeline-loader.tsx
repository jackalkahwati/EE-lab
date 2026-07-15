'use client'

/**
 * Pipeline loader — the middle-pane animation shown while the full pipeline runs
 * end-to-end. A sleek configurator-style loader (rotating conic sweep + counter-
 * orbiting arcs + a pulsing core), driven by REAL pipeline status: the percentage
 * and the ticking stage list reflect which disciplines have actually finished, so
 * it's honest progress, not a fake spinner. Self-contained (no external assets).
 */
import { PIPE_ORDER, type PipeStatus } from '@/lib/run-pipeline'

const LABELS: Record<string, { label: string; verb: string }> = {
  electronics: { label: 'Electronics', verb: 'Routing the chip-scale board' },
  mechanical: { label: 'Mechanical', verb: 'Generating the enclosure (CAD)' },
  simulation: { label: 'Simulation', verb: 'Running the physics simulations' },
  firmware: { label: 'Firmware', verb: 'Architecting the firmware' },
  manufacturing: { label: 'Manufacturing', verb: 'Planning manufacturing + DFM' },
  supplyChain: { label: 'Supply chain', verb: 'Sourcing the supply chain' },
  validation: { label: 'Validation', verb: 'Building the validation plan' },
}

// Exhaustive over the orchestrator's real PipeStatus union: if the union ever
// gains a value, the `never` defaults below turn into compile errors instead of
// the UI silently stalling progress or dimming an unknown status as "pending".
function isFinished(st: PipeStatus): boolean {
  switch (st) {
    case 'passed': case 'skipped': case 'failed': case 'blocked': return true
    case 'pending': case 'running': return false
    default: { const exhaustive: never = st; void exhaustive; return true }
  }
}

function dotColor(st: PipeStatus): string {
  switch (st) {
    case 'passed': return 'bg-emerald-400'
    case 'failed': return 'bg-red-400'
    case 'blocked': return 'bg-amber-400'
    case 'running': return 'bg-[hsl(var(--primary))] animate-pulse'
    case 'skipped': return 'bg-white/20'
    case 'pending': return 'bg-white/15'
    // unreachable by type; if a rogue value arrives at runtime, render it LOUD
    default: { const exhaustive: never = st; void exhaustive; return 'bg-fuchsia-500 animate-pulse' }
  }
}

export function PipelineLoader({ status }: { status: Record<string, { status: PipeStatus; detail?: string }> }) {
  const stages = PIPE_ORDER.map((key) => ({ key, ...LABELS[key], st: status[key]?.status ?? 'pending', detail: status[key]?.detail }))
  const finished = stages.filter((s) => isFinished(s.st)).length
  const total = stages.length
  const pct = Math.min(100, Math.round((finished / total) * 100))
  const running = stages.find((s) => s.st === 'running')

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-[#0a0a0a] px-6">
      <style>{`
        @keyframes fl-spin { to { transform: rotate(360deg) } }
        @keyframes fl-spin-rev { to { transform: rotate(-360deg) } }
        @keyframes fl-pulse { 0%,100% { opacity: .45; transform: scale(.86) } 50% { opacity: .95; transform: scale(1.06) } }
        @keyframes fl-float { 0%,100% { opacity:.25 } 50% { opacity:.6 } }
        .fl-orb { position: relative; width: 168px; height: 168px; }
        .fl-ring { position:absolute; inset:0; border-radius:50%; }
        .fl-sweep {
          background: conic-gradient(from 0deg, transparent 0deg, transparent 240deg, hsl(var(--primary)) 360deg);
          -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
          mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
          animation: fl-spin 1.15s linear infinite;
        }
        .fl-arc1 { inset:22px; border:1.5px solid transparent; border-top-color: hsl(var(--primary)/.85); border-right-color: hsl(var(--primary)/.4); animation: fl-spin-rev 2.4s linear infinite; }
        .fl-arc2 { inset:42px; border:1.5px solid transparent; border-bottom-color: rgba(150,190,255,.7); border-left-color: rgba(150,190,255,.3); animation: fl-spin 3.4s linear infinite; }
        .fl-core { position:absolute; inset:60px; border-radius:50%; background: radial-gradient(circle at 50% 45%, hsl(var(--primary)/.9), hsl(var(--primary)/.15) 60%, transparent 72%); filter: blur(2px); animation: fl-pulse 1.9s ease-in-out infinite; }
        .fl-glow { position:absolute; inset:-30px; border-radius:50%; background: radial-gradient(circle, hsl(var(--primary)/.18), transparent 62%); }
        .fl-pct { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-variant-numeric: tabular-nums; }
        .fl-dot { width:6px; height:6px; border-radius:50%; }
        .fl-bar-fill { transition: width .5s cubic-bezier(.4,0,.2,1); }
      `}</style>

      {/* faint drifting grid for depth (configurator vibe) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{ backgroundImage: 'linear-gradient(rgba(120,150,200,.25) 1px, transparent 1px), linear-gradient(90deg, rgba(120,150,200,.25) 1px, transparent 1px)', backgroundSize: '34px 34px', animation: 'fl-float 4s ease-in-out infinite' }} />

      <div className="fl-orb">
        <div className="fl-glow" />
        <div className="fl-ring fl-sweep" />
        <div className="fl-ring fl-arc1" />
        <div className="fl-ring fl-arc2" />
        <div className="fl-core" />
        <div className="fl-pct">
          <span className="font-mono text-2xl font-semibold text-white/90">{pct}<span className="text-sm text-white/40">%</span></span>
        </div>
      </div>

      <div className="mt-8 text-center">
        <div className="text-[13px] font-medium text-white/90">
          {running ? `${running.verb}…` : pct >= 100 ? 'Finalizing the pipeline…' : 'Running the full pipeline…'}
        </div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-white/35">
          {finished} / {total} disciplines · electronics → mechanical → simulation → firmware → mfg → supply → validation
        </div>
      </div>

      {/* progress bar */}
      <div className="mt-4 h-1 w-64 max-w-full overflow-hidden rounded-full bg-white/10">
        <div className="fl-bar-fill h-full rounded-full" style={{ width: `${pct}%`, background: 'hsl(var(--primary))' }} />
      </div>

      {/* live discipline checklist */}
      <div className="mt-6 grid max-w-md grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
        {stages.map((s) => {
          const color = dotColor(s.st)
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className={`fl-dot shrink-0 ${color}`} />
              <span className={`truncate text-[11px] ${s.st === 'pending' ? 'text-white/35' : 'text-white/75'}`}>{s.label}</span>
            </div>
          )
        })}
      </div>

      {running?.detail && (
        <div className="mt-4 max-w-md truncate text-center text-[10px] text-white/40">{running.detail}</div>
      )}
    </div>
  )
}
