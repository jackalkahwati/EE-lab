'use client'

/**
 * E1 — Enterprise Program Workspace UI.
 * Org/workspace selector → program list → program detail → board detail with
 * Runs / Evidence / Approvals / Usage / Risks tabs. Read-honest: readiness
 * and blocked claims render verbatim from the store; architecture_only and
 * routed_in_sandbox are never dressed up as built or validated hardware.
 */
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

type Db = Record<string, any>

const READINESS_STYLE: Record<string, string> = {
  architecture_only: 'border-border bg-muted/30 text-muted-foreground',
  blocked: 'border-destructive/40 bg-destructive/10 text-destructive',
  routed_in_sandbox: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  package_ready_with_review: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  approved_for_quote: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  physical_evidence_pending: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  physically_validated: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  production_ready: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
}

function Badge({ s }: { s: string }) {
  return (
    <span className={cn(
      'inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
      READINESS_STYLE[s] ?? 'border-border bg-muted/30 text-muted-foreground')}>
      {s.replace(/_/g, ' ')}
    </span>
  )
}

const TABS = ['Runs', 'Evidence', 'Approvals', 'Usage', 'Risks'] as const

export default function EnterprisePage() {
  const [db, setDb] = useState<Db | null>(null)
  const [wsId, setWsId] = useState<string | null>(null)
  const [progId, setProgId] = useState<string | null>(null)
  const [boardId, setBoardId] = useState<string | null>(null)
  const [tab, setTab] = useState<(typeof TABS)[number]>('Runs')

  const refresh = useCallback(() => {
    fetch('/api/enterprise', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        setDb(d)
        if (!wsId && d.workspaces?.[0]) setWsId(d.workspaces[0].workspace_id)
      })
  }, [wsId])
  useEffect(() => { refresh() }, [refresh])

  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading enterprise workspace…</div>

  const workspaces = db.workspaces ?? []
  const ws = workspaces.find((w: any) => w.workspace_id === wsId)
  const org = db.organizations?.find((o: any) => o.org_id === ws?.org_id)
  const programs = (db.programs ?? []).filter(
    (p: any) => p.workspace_id === wsId)
  const program = programs.find((p: any) => p.program_id === progId)
  const boards = (db.boards ?? []).filter(
    (b: any) => b.program_id === progId)
  const board = boards.find((b: any) => b.board_id === boardId)
  const runs = (db.runs ?? []).filter((r: any) => r.board_id === boardId)
  const evidence = (db.evidence ?? []).filter(
    (e: any) => e.scope_id === boardId
      || runs.some((r: any) => r.run_id === e.scope_id))
  const approvals = (db.approvals ?? []).filter(
    (a: any) => a.scope?.board_id === boardId
      || a.scope?.program_id === progId)
  const usage = (db.usage ?? []).filter(
    (u: any) => u.program_id === progId)

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-base font-semibold">Enterprise Programs</h1>
        {org && (
          <span className="text-muted-foreground">
            {org.name} · plan: {org.plan}
            {org.security_settings?.demo && (
              <span className="ml-2 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">
                SYNTHETIC DEMO DATA
              </span>
            )}
          </span>
        )}
        <select
          className="ml-auto rounded-sm border border-border bg-secondary px-2 py-1"
          value={wsId ?? ''}
          onChange={(e) => { setWsId(e.target.value); setProgId(null); setBoardId(null) }}
        >
          {workspaces.map((w: any) => (
            <option key={w.workspace_id} value={w.workspace_id}>{w.name}</option>
          ))}
        </select>
      </div>

      {workspaces.length === 0 && (
        <div className="rounded-md border border-border p-6 text-muted-foreground">
          No enterprise data. Seed the demo workspace:
          <code className="ml-2 rounded bg-muted px-1">node scripts/seed_enterprise_demo.mjs</code>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* program list */}
        <div className="space-y-1">
          {programs.map((p: any) => (
            <button
              key={p.program_id}
              type="button"
              onClick={() => { setProgId(p.program_id); setBoardId(null) }}
              className={cn(
                'block w-full rounded-md border p-2 text-left',
                progId === p.program_id
                  ? 'border-primary/40 bg-primary/5' : 'border-border')}
            >
              <div className="font-medium">{p.name}</div>
              <div className="mt-0.5 flex items-center gap-2 text-muted-foreground">
                <span className="font-mono text-[10px]">{p.status}</span>
                <span>· {p.board_list.length} board(s)</span>
                <span>· {p.budget.credits_consumed}/{p.budget.credits_allocated} cr</span>
              </div>
            </button>
          ))}
        </div>

        {/* program + board detail */}
        <div className="space-y-4">
          {program && (
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{program.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{program.status}</span>
                <span className="ml-auto text-muted-foreground">owner: {program.owner}</span>
              </div>
              <p className="mt-1 text-muted-foreground">{program.objective}</p>
              {program.blocked_claims.length > 0 && (
                <p className="mt-1 text-destructive">
                  blocked: {program.blocked_claims.join(' · ')}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {boards.map((b: any) => (
                  <button
                    key={b.board_id}
                    type="button"
                    onClick={() => setBoardId(b.board_id)}
                    className={cn(
                      'rounded-md border px-2 py-1.5 text-left',
                      boardId === b.board_id
                        ? 'border-primary/40 bg-primary/5' : 'border-border')}
                  >
                    <div className="font-medium">{b.name}</div>
                    <Badge s={b.readiness} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {board && (
            <div className="rounded-md border border-border">
              <div className="flex items-center gap-2 border-b border-border p-3">
                <span className="text-sm font-semibold">{board.name}</span>
                <Badge s={board.readiness} />
                <span className="text-muted-foreground">{board.board_class}</span>
                <a
                  href={`/api/enterprise/evidence-pack?board_id=${board.board_id}&format=md`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto rounded-sm border border-border bg-secondary px-2 py-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                >
                  evidence pack ↓
                </a>
              </div>
              {(board.blocked_claims.length > 0
                || board.review_required_items.length > 0) && (
                <div className="border-b border-border bg-amber-500/5 p-3">
                  {board.blocked_claims.map((c: string, i: number) => (
                    <div key={i} className="text-destructive">blocked claim: {c}</div>
                  ))}
                  {board.review_required_items.map((c: string, i: number) => (
                    <div key={i} className="text-amber-500">review required: {c}</div>
                  ))}
                </div>
              )}
              <div className="flex gap-1 border-b border-border px-2">
                {TABS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={cn(
                      'border-b-2 px-3 py-1.5',
                      tab === t ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground')}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="max-h-96 space-y-1.5 overflow-y-auto p-3">
                {tab === 'Runs' && (runs.length ? runs.map((r: any) => (
                  <div key={r.run_id} className="rounded-md border border-border p-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px]">{r.run_id}</span>
                      <Badge s={r.readiness_state} />
                      <span className="text-muted-foreground">
                        route: {r.route_evidence_state} · drc: {r.drc_state} · erc: {r.erc_state}
                      </span>
                    </div>
                    {r.source_run_dir && (
                      <div className="text-muted-foreground">artifacts: /runs/{r.source_run_dir}</div>
                    )}
                  </div>
                )) : <p className="text-muted-foreground">No runs attached.</p>)}

                {tab === 'Evidence' && (evidence.length ? evidence.map((e: any) => (
                  <div key={e.evidence_id} className="rounded-md border border-border p-2">
                    <span className="font-medium">{e.evidence_type}</span>
                    <span className={cn('ml-2 font-mono text-[10px]',
                      e.status === 'accepted' ? 'text-emerald-500'
                        : e.status === 'rejected' ? 'text-destructive'
                          : 'text-amber-500')}>{e.status}</span>
                    <div className="text-muted-foreground">
                      {e.source} {e.reviewer ? `· reviewer: ${e.reviewer}` : '· UNREVIEWED'}
                    </div>
                  </div>
                )) : <p className="text-muted-foreground">
                  No evidence items. Physical evidence ledger state: EMPTY —
                  no physical claims possible.</p>)}

                {tab === 'Approvals' && (approvals.length ? approvals.map((a: any) => (
                  <div key={a.approval_id} className="rounded-md border border-border p-2">
                    <span className="font-medium">{a.approval_type}</span>
                    <span className={cn('ml-2 font-mono text-[10px]',
                      a.status === 'approved' ? 'text-emerald-500'
                        : a.status === 'rejected' || a.status === 'revoked'
                          ? 'text-destructive' : 'text-amber-500')}>{a.status}</span>
                    <div className="text-muted-foreground">
                      requested by {a.requested_by}
                      {a.approver ? ` · decided by ${a.approver}` : ''}
                    </div>
                  </div>
                )) : <p className="text-muted-foreground">
                  No approvals. Quote/order paths stay locked without one.</p>)}

                {tab === 'Usage' && (usage.length ? usage.map((u: any) => (
                  <div key={u.usage_id} className="flex justify-between rounded-md border border-border p-2">
                    <span>{u.usage_type}</span>
                    <span className="font-mono">{u.credits} cr</span>
                  </div>
                )) : <p className="text-muted-foreground">No usage recorded.</p>)}

                {tab === 'Risks' && (
                  <>
                    {(program?.risks ?? []).map((r: string, i: number) => (
                      <div key={i} className="text-amber-500">{r}</div>
                    ))}
                    {board.blocked_claims.map((c: string, i: number) => (
                      <div key={i} className="text-destructive">blocked: {c}</div>
                    ))}
                    {!program?.risks?.length && !board.blocked_claims.length && (
                      <p className="text-muted-foreground">No recorded risks or blockers.</p>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
