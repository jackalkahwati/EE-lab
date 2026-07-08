'use client'

/**
 * Console-home widget board (AWS-console-home pattern, Compose-honest). A fixed
 * grid of tiles over the real enterprise store: Cost & Usage, Telemetry,
 * Reports & Analytics, Compose quick-launch, Security. The journey spine
 * (Design -> Review -> Quote -> Build -> Validate -> Learn) stays the work
 * surface; these tiles are the "what's happening" glance a buyer opens with.
 * Cost is shown in credits with an EXPLICIT $0 fab spend / empty-ledger line —
 * transparency, never an implied spend that did not occur.
 */
import Link from 'next/link'
import { cn } from '@/lib/utils'
import {
  Activity, BarChart3, CircuitBoard, Coins, ShieldCheck, Users,
} from 'lucide-react'

type Any = Record<string, any>

function Card({ title, icon, children, href }: {
  title: string; icon: React.ReactNode; children: React.ReactNode; href?: string
}) {
  const head = (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs font-semibold">{title}</span>
      {href && <span className="ml-auto font-mono text-[9px] text-muted-foreground">open →</span>}
    </div>
  )
  const body = <div className="p-3">{children}</div>
  return href ? (
    <Link href={href} className="block rounded-md border border-border bg-card/40 transition-colors hover:border-primary/40">
      {head}{body}
    </Link>
  ) : (
    <div className="rounded-md border border-border bg-card/40">{head}{body}</div>
  )
}

export function ConsoleWidgets({
  db, programs, onOpenBoard,
}: {
  db: Any; programs: Any[]; onOpenBoard: (b: Any) => void
}) {
  const org = db.organizations?.[0]
  const progIds = new Set(programs.map((p) => p.program_id))
  const boards = (db.boards ?? []).filter((b: Any) => progIds.has(b.program_id))
  const boardIds = new Set(boards.map((b: Any) => b.board_id))
  const usage = (db.usage ?? []).filter((u: Any) => boardIds.has(u.board_id) || progIds.has(u.program_id))
  const runs = (db.runs ?? []).filter((r: Any) => boardIds.has(r.board_id))

  // ---- Cost & Usage (credits; explicit $0 fab spend) ----------------------
  const allocation = org?.credit_allocation ?? 0
  const consumed = usage.reduce((s: number, u: Any) => s + (u.credits || 0), 0)
  const remaining = Math.max(0, allocation - consumed)
  const pct = allocation ? Math.min(100, Math.round((consumed / allocation) * 100)) : 0
  const now = new Date()
  const dayOfMonth = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const forecast = dayOfMonth > 0 ? Math.round((consumed / dayOfMonth) * daysInMonth) : consumed
  // physical spend: only real, accepted physical evidence + placed orders count;
  // quotes carry placeholder prices only, so fab dollars are genuinely $0.
  const physicalEvidence = (db.evidence ?? []).filter(
    (e: Any) => boardIds.has(e.scope_id) && e.status === 'accepted'
      && /physical|inspection|measurement|continuity/i.test(e.evidence_type || ''))

  // ---- Telemetry (pipeline/router/DRC health) -----------------------------
  const routedClean = runs.filter((r: Any) => r.route_evidence_state === 'routed_in_sandbox').length
  const drcClean = runs.filter((r: Any) => r.drc_state === 'drc_clean').length
  const ercPass = runs.filter((r: Any) => r.erc_state === 'passed').length
  const extAdvisory = runs.filter((r: Any) => /advisory|completed|passed/.test(r.external_eda_state || '')).length

  // ---- Reports & Analytics (readiness distribution) -----------------------
  const dist = boards.reduce((m: Record<string, number>, b: Any) => {
    const k = b.readiness || 'unknown'; m[k] = (m[k] || 0) + 1; return m
  }, {})
  const distOrder = ['architecture_only', 'routed_in_sandbox', 'package_ready_with_review',
    'approved_for_quote', 'physically_validated', 'production_ready', 'blocked']
  const DIST_TONE: Record<string, string> = {
    architecture_only: 'bg-muted-foreground/40', routed_in_sandbox: 'bg-sky-500',
    package_ready_with_review: 'bg-amber-500', approved_for_quote: 'bg-emerald-500',
    physically_validated: 'bg-emerald-500', production_ready: 'bg-emerald-500',
    blocked: 'bg-destructive',
  }

  // ---- Compose quick-launch (recent boards) -------------------------------
  const recent = [...boards].sort(
    (a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 4)

  // ---- Security -----------------------------------------------------------
  const blockedClaims = boards.reduce((s: number, b: Any) => s + (b.blocked_claims?.length || 0), 0)
  const auditOk = db.audit_chain?.ok

  return (
    <div className="mb-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
      {/* Cost & Usage */}
      <Card title="Cost & usage" icon={<Coins className="size-3.5" />} href="/enterprise/settings">
        <div className="flex items-end justify-between">
          <div>
            <div className="font-mono text-2xl font-semibold tabular-nums">{consumed}</div>
            <div className="text-[10px] text-muted-foreground">credits this period · of {allocation}</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm text-muted-foreground tabular-nums">~{forecast}</div>
            <div className="text-[10px] text-muted-foreground">forecast month-end</div>
          </div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full', pct > 90 ? 'bg-amber-500' : 'bg-primary')}
            style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 space-y-0.5 rounded-sm border border-border bg-background/50 p-2 text-[10px]">
          <div className="flex justify-between"><span className="text-muted-foreground">Fab spend</span><span className="font-mono text-emerald-500">$0 · nothing ordered</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Physical ledger</span><span className="font-mono text-muted-foreground">{physicalEvidence.length ? `${physicalEvidence.length} item(s)` : 'EMPTY'}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Remaining credits</span><span className="font-mono">{remaining}</span></div>
        </div>
      </Card>

      {/* Telemetry */}
      <Card title="Telemetry" icon={<Activity className="size-3.5" />}>
        <div className="grid grid-cols-2 gap-2">
          {[
            { k: 'Routed clean', v: `${routedClean}/${runs.length}` },
            { k: 'DRC clean', v: `${drcClean}/${runs.length}` },
            { k: 'ERC passed', v: `${ercPass}/${runs.length}` },
            { k: 'Ext. evidence', v: `${extAdvisory}/${runs.length}` },
          ].map((x) => (
            <div key={x.k} className="rounded-sm border border-border bg-background/40 p-2">
              <div className="font-mono text-sm font-semibold tabular-nums">{x.v}</div>
              <div className="text-[10px] text-muted-foreground">{x.k}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[9px] leading-snug text-muted-foreground">
          Router evidence + KiCad DRC/ERC per run · external EDA (ngspice) advisory
          only · routed_in_sandbox ≠ physically validated.
        </p>
      </Card>

      {/* Security */}
      <Card title="Security" icon={<ShieldCheck className="size-3.5" />} href="/enterprise/settings">
        <div className="flex items-center gap-3">
          <div>
            <div className={cn('font-mono text-2xl font-semibold', auditOk ? 'text-emerald-500' : 'text-destructive')}>
              {auditOk ? '✓' : '✗'}
            </div>
            <div className="text-[10px] text-muted-foreground">audit chain</div>
          </div>
          <div className="ml-auto text-right">
            <div className="font-mono text-sm tabular-nums">{(db.audit_tail ?? []).length}</div>
            <div className="text-[10px] text-muted-foreground">audited actions</div>
          </div>
        </div>
        <div className="mt-2 space-y-0.5 rounded-sm border border-border bg-background/50 p-2 text-[10px]">
          <div className="flex justify-between"><span className="text-muted-foreground">Auth</span><span className="font-mono">{org?.security_settings?.auth ?? 'session'}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Blocked claims</span><span className={cn('font-mono', blockedClaims ? 'text-destructive' : 'text-muted-foreground')}>{blockedClaims}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">RBAC</span><span className="font-mono">{(db.rbac?.roles ?? []).length} roles</span></div>
        </div>
      </Card>

      {/* Reports & Analytics */}
      <Card title="Reports & analytics" icon={<BarChart3 className="size-3.5" />}>
        <div className="mb-2 flex h-2 w-full overflow-hidden rounded-full">
          {distOrder.filter((k) => dist[k]).map((k) => (
            <div key={k} title={`${k.replace(/_/g, ' ')}: ${dist[k]}`}
              className={cn('h-full', DIST_TONE[k] ?? 'bg-muted')}
              style={{ width: `${(dist[k] / boards.length) * 100}%` }} />
          ))}
        </div>
        <div className="space-y-0.5">
          {distOrder.filter((k) => dist[k]).map((k) => (
            <div key={k} className="flex items-center justify-between text-[10px]">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className={cn('size-2 rounded-sm', DIST_TONE[k])} />
                {k.replace(/_/g, ' ')}
              </span>
              <span className="font-mono">{dist[k]}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[9px] text-muted-foreground">
          {boards.length} board(s) · evidence packs exportable per board.
        </p>
      </Card>

      {/* Compose quick-launch */}
      <Card title="Compose" icon={<CircuitBoard className="size-3.5" />}>
        <Link href="/compose"
          className="flex items-center justify-center gap-1.5 rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90">
          <CircuitBoard className="size-3.5" /> New board in Compose
        </Link>
        <p className="mb-1 mt-2 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Recent boards</p>
        <div className="space-y-1">
          {recent.map((b) => (
            <button key={b.board_id} type="button" onClick={() => onOpenBoard(b)}
              className="flex w-full items-center gap-2 rounded-sm border border-border px-2 py-1 text-left hover:border-primary/40">
              <span className="min-w-0 flex-1 truncate text-[11px]">{b.name}</span>
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{b.readiness?.replace(/_/g, ' ')}</span>
            </button>
          ))}
          {!recent.length && <p className="text-[10px] text-muted-foreground">No boards yet.</p>}
        </div>
      </Card>

      {/* IAM (Users) */}
      <Card title="IAM · users" icon={<Users className="size-3.5" />} href="/enterprise/iam">
        <div className="flex items-end justify-between">
          <div>
            <div className="font-mono text-2xl font-semibold tabular-nums">{(db.members ?? []).length}</div>
            <div className="text-[10px] text-muted-foreground">user(s)</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm tabular-nums">{(db.rbac?.roles ?? []).length}</div>
            <div className="text-[10px] text-muted-foreground">role(s)</div>
          </div>
        </div>
        <div className="mt-2 space-y-1">
          {(db.members ?? []).slice(0, 3).map((m: Any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-[10px]">
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">
                {m.actor?.[0]?.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.actor}</span>
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{m.role?.replace(/_/g, ' ')}</span>
            </div>
          ))}
          {!(db.members ?? []).length && <p className="text-[10px] text-muted-foreground">No users provisioned.</p>}
        </div>
      </Card>
    </div>
  )
}
