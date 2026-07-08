'use client'

/**
 * Enterprise workspace Settings — Members, Billing & Usage, Security.
 * Reads the real enterprise store (org plan, RBAC members + role catalog,
 * credit/usage ledger, security policies, audit chain). Enterprise-only: there
 * is no self-serve checkout here — billing is an org-level license managed by
 * an admin. Read-honest: nothing shown implies physical validation or spend
 * that did not occur.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { EnterpriseNav } from '@/components/enterprise-nav'

type Any = Record<string, any>
const TABS = ['Members', 'Billing & Usage', 'Security'] as const

const ROLE_STYLE: Record<string, string> = {
  org_admin: 'border-primary/40 bg-primary/10 text-primary',
  workspace_admin: 'border-primary/40 bg-primary/10 text-primary',
  reviewer: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  procurement: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  finance_viewer: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  security_auditor: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
}

function RoleBadge({ r }: { r: string }) {
  return (
    <span className={cn(
      'rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
      ROLE_STYLE[r] ?? 'border-border bg-muted/30 text-muted-foreground')}>
      {r.replace(/_/g, ' ')}
    </span>
  )
}

export default function SettingsPage() {
  const [db, setDb] = useState<Any | null>(null)
  const [tab, setTab] = useState<(typeof TABS)[number]>('Members')

  useEffect(() => {
    fetch('/api/enterprise', { cache: 'no-store' })
      .then((r) => r.json()).then(setDb).catch(() => {})
  }, [])

  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading settings…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const org = db.organizations?.[0]
  const members: Any[] = db.members ?? []
  const roles: string[] = db.rbac?.roles ?? []
  const rolePerms: Record<string, string[]> = db.rbac?.role_permissions ?? {}
  const usage: Any[] = db.usage ?? []
  const programs: Any[] = db.programs ?? []
  const progName = (id: string) =>
    programs.find((p) => p.program_id === id)?.name ?? '—'

  const consumed = usage.reduce((s, u) => s + (u.credits || 0), 0)
  const allocation = org?.credit_allocation ?? 0
  const remaining = Math.max(0, allocation - consumed)
  const byUser = usage.reduce((m: Record<string, number>, u) => {
    m[u.user] = (m[u.user] || 0) + u.credits; return m
  }, {})
  const byProgram = usage.reduce((m: Record<string, number>, u) => {
    if (u.program_id) m[u.program_id] = (m[u.program_id] || 0) + u.credits
    return m
  }, {})

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-4 flex items-center gap-3">
        <Link href="/enterprise" className="text-muted-foreground hover:text-foreground">← Programs</Link>
        <h1 className="text-base font-semibold">Workspace settings</h1>
        {org && (
          <span className="text-muted-foreground">
            {org.name} · plan: <span className="font-mono">{org.plan}</span>
            {org.security_settings?.demo && (
              <span className="ml-2 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">
                SYNTHETIC DEMO DATA
              </span>
            )}
          </span>
        )}
      </div>

      <EnterpriseNav />

      <div className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn('border-b-2 px-3 py-1.5',
              tab === t ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Members' && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="rounded-md border border-border">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="text-xs font-semibold">Team members</span>
              <span className="font-mono text-[10px] text-muted-foreground">{members.length}</span>
              <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                assigning roles requires manage_members (org / workspace admin)
              </span>
            </div>
            <div className="divide-y divide-border">
              {members.length === 0 && (
                <p className="px-3 py-3 text-muted-foreground">
                  No members beyond the workspace admin. Assign roles to invite the team.
                </p>
              )}
              {members.map((m, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                    {m.actor?.[0]?.toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{m.actor}</span>
                  <RoleBadge r={m.role} />
                  <span className="hidden font-mono text-[9px] text-muted-foreground sm:inline">
                    by {m.granted_by}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold">
              Role catalog ({roles.length})
            </div>
            <div className="max-h-[28rem] divide-y divide-border overflow-y-auto">
              {roles.map((r) => (
                <div key={r} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <RoleBadge r={r} />
                    <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                      {(rolePerms[r] ?? []).length} permission(s)
                    </span>
                  </div>
                  {(rolePerms[r] ?? []).length > 0 && (
                    <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                      {(rolePerms[r] ?? []).slice(0, 6).map((p) => p.replace(/_/g, ' ')).join(' · ')}
                      {(rolePerms[r] ?? []).length > 6 && ' …'}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'Billing & Usage' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: 'Plan', value: org?.plan ?? '—', mono: true },
              { label: 'Credits allocated', value: String(allocation) },
              { label: 'Consumed', value: String(consumed) },
              { label: 'Remaining', value: String(remaining), tone: remaining ? 'emerald' : 'amber' },
            ].map((s) => (
              <div key={s.label} className="rounded-md border border-border bg-card/40 p-2.5">
                <div className={cn('text-sm font-semibold',
                  s.mono && 'font-mono text-xs',
                  s.tone === 'emerald' && 'text-emerald-500',
                  s.tone === 'amber' && 'text-amber-500')}>
                  {s.value}
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="rounded-md border border-border bg-muted/10 px-3 py-2 text-[10px] text-muted-foreground">
            Enterprise license, annual. Credits are allocated to the organization
            and drawn down by usage; there is no self-serve purchase in the app.
            Monthly run limit:{' '}
            <span className="font-mono text-foreground">{org?.usage_limits?.monthly_runs ?? 'unlimited'}</span>.
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border border-border">
              <div className="border-b border-border px-3 py-2 text-xs font-semibold">Usage by member</div>
              <div className="divide-y divide-border">
                {Object.entries(byUser).sort((a, b) => b[1] - a[1]).map(([u, c]) => (
                  <div key={u} className="flex items-center justify-between px-3 py-1.5">
                    <span className="text-xs">{u}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{c} cr</span>
                  </div>
                ))}
                {!Object.keys(byUser).length && <p className="px-3 py-2 text-muted-foreground">No usage.</p>}
              </div>
            </div>
            <div className="rounded-md border border-border">
              <div className="border-b border-border px-3 py-2 text-xs font-semibold">Usage by program</div>
              <div className="divide-y divide-border">
                {Object.entries(byProgram).sort((a, b) => b[1] - a[1]).map(([p, c]) => (
                  <div key={p} className="flex items-center justify-between px-3 py-1.5">
                    <span className="truncate text-xs">{progName(p)}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{c} cr</span>
                  </div>
                ))}
                {!Object.keys(byProgram).length && <p className="px-3 py-2 text-muted-foreground">No usage.</p>}
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold">
              Usage ledger <span className="font-mono text-[10px] text-muted-foreground">{usage.length} entries</span>
            </div>
            <div className="max-h-72 divide-y divide-border overflow-y-auto">
              {usage.map((u, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-40 shrink-0 font-mono text-[10px] text-muted-foreground">{u.usage_type}</span>
                  <span className="w-14 shrink-0 font-mono text-[11px]">{u.credits} cr</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{u.user}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{progName(u.program_id)}</span>
                  <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground">
                    {String(u.timestamp).slice(0, 16).replace('T', ' ')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'Security' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold">Authentication & policies</div>
            <div className="space-y-2 p-3">
              <Row k="Auth" v={org?.security_settings?.auth ?? 'session'} />
              <Row k="SSO" v="not configured" muted note="SAML/OIDC available on Enterprise/Defense" />
              <Row k="Default evidence policy" v={org?.policies?.default_evidence_policy ?? '—'} />
              <Row k="Default approval policy" v={org?.policies?.default_approval_policy ?? '—'} />
              <Row k="Demo mode" v={org?.security_settings?.demo ? 'on (synthetic data)' : 'off'} />
            </div>
          </div>
          <div className="rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold">Audit trail</div>
            <div className="space-y-2 p-3">
              <Row k="Audit chain"
                v={db.audit_chain?.ok ? 'verified · tamper-evident' : 'BROKEN'}
                tone={db.audit_chain?.ok ? 'emerald' : 'red'} />
              <Row k="Recent audited actions" v={String((db.audit_tail ?? []).length)} />
              <p className="pt-1 text-[10px] leading-snug text-muted-foreground">
                Every write (role change, approval, quote, evidence) is hash-chained
                and RBAC-gated through the audited dispatcher. Deletions and
                permission changes are recorded, not silent.
              </p>
              <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-sm border border-border bg-background p-2">
                {(db.audit_tail ?? []).slice(-8).reverse().map((a: Any, i: number) => (
                  <div key={i} className="flex items-center gap-2 font-mono text-[9px] text-muted-foreground">
                    <span className={cn('shrink-0', String(a.action).startsWith('DENIED') && 'text-destructive')}>
                      {a.action}
                    </span>
                    <span className="ml-auto shrink-0">{a.actor}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ k, v, muted, tone, note }: {
  k: string; v: string; muted?: boolean; tone?: string; note?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1.5 last:border-0">
      <span className="text-[11px] text-muted-foreground">{k}</span>
      <span className="text-right">
        <span className={cn('font-mono text-[11px]',
          muted && 'text-muted-foreground',
          tone === 'emerald' && 'text-emerald-500',
          tone === 'red' && 'text-destructive')}>
          {v}
        </span>
        {note && <span className="block text-[9px] text-muted-foreground/70">{note}</span>}
      </span>
    </div>
  )
}
