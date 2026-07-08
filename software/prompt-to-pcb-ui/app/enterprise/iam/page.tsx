'use client'

/**
 * IAM — identity & access. The AWS-IAM analog for Compose: Users (who is in the
 * org and their role), Roles (the E5 role catalog), and a Roles × Permissions
 * matrix (the effective policy). Reads the real RBAC state from the enterprise
 * store. Role assignment is gated by manage_members through the audited
 * dispatcher; this view is read-first.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { enterpriseAction } from '@/lib/enterprise-actions'

type Any = Record<string, any>
const TABS = ['Users', 'Roles', 'Permissions'] as const

const ROLE_STYLE: Record<string, string> = {
  org_admin: 'border-primary/40 bg-primary/10 text-primary',
  workspace_admin: 'border-primary/40 bg-primary/10 text-primary',
  reviewer: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  procurement: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  finance_viewer: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  security_auditor: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
}
const RoleBadge = ({ r }: { r: string }) => (
  <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
    ROLE_STYLE[r] ?? 'border-border bg-muted/30 text-muted-foreground')}>
    {r.replace(/_/g, ' ')}
  </span>
)

export default function IamPage() {
  const [db, setDb] = useState<Any | null>(null)
  const [tab, setTab] = useState<(typeof TABS)[number]>('Users')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState('viewer')

  const refresh = useCallback(() => {
    fetch('/api/enterprise', { cache: 'no-store' })
      .then((r) => r.json()).then(setDb).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])

  async function run(key: string, action: string, params: Record<string, any>, okText: string) {
    setBusy(key); setMsg(null)
    const r = await enterpriseAction(action, params)
    setBusy(null)
    if (r.error) setMsg({ tone: 'err', text: `${r.error}${r.detail ? ` — ${r.detail}` : ''}` })
    else { setMsg({ tone: 'ok', text: okText }); refresh() }
  }
  const changeRole = (actor_name: string, role: string) =>
    run(actor_name, 'set_member_role', { actor_name, role }, `${actor_name} → ${role}`)
  async function addMember() {
    if (!newEmail) return
    await run('add', 'set_member_role', { actor_name: newEmail.trim(), role: newRole }, `added ${newEmail.trim()}`)
    setNewEmail('')
  }
  const removeMember = (actor_name: string) =>
    run(actor_name, 'remove_member', { actor_name }, `removed ${actor_name}`)

  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading IAM…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const org = db.organizations?.[0]
  const members: Any[] = db.members ?? []
  const roles: string[] = db.rbac?.roles ?? []
  const permissions: string[] = db.rbac?.permissions ?? []
  const rolePerms: Record<string, string[]> = db.rbac?.role_permissions ?? {}
  const usage: Any[] = db.usage ?? []
  const activityOf = (actor: string) => usage.filter((u) => u.user === actor).length

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-base font-semibold">IAM · identity &amp; access</h1>
        {org && (
          <span className="text-muted-foreground">
            {org.name}
            {org.security_settings?.demo && (
              <span className="ml-2 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">
                SYNTHETIC DEMO DATA
              </span>
            )}
          </span>
        )}
        {msg && (
          <span className={cn('rounded-sm px-2 py-0.5 font-mono text-[10px]',
            msg.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-destructive/10 text-destructive')}>
            {msg.text}
          </span>
        )}
        <Link href="/enterprise/settings"
          className="ml-auto rounded-sm border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
          Workspace settings →
        </Link>
      </div>

      <div className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={cn('border-b-2 px-3 py-1.5',
              tab === t ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Users' && (
        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold">Users</span>
            <span className="font-mono text-[10px] text-muted-foreground">{members.length}</span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground">
              invites &amp; role changes require manage_members · every change is audited
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/30 px-3 py-2">
            <span className="text-[11px] font-medium">Add member</span>
            <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="email"
              className="w-52 rounded-sm border border-border bg-background px-1.5 py-1 text-[11px]" />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}
              className="rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]">
              {roles.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
            </select>
            <button type="button" disabled={busy === 'add' || !newEmail} onClick={addMember}
              className="rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
              Add
            </button>
            <span className="font-mono text-[9px] text-muted-foreground">requires manage_members · audited</span>
          </div>
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4 border-b border-border px-3 py-1.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
            <span>User</span><span>Role</span><span className="text-right">Activity</span><span className="text-right">Granted by</span><span></span>
          </div>
          <div className="divide-y divide-border">
            {members.length === 0 && (
              <p className="px-3 py-3 text-muted-foreground">No users provisioned yet.</p>
            )}
            {members.map((m, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                    {m.actor?.[0]?.toUpperCase()}
                  </span>
                  <span className="truncate text-xs font-medium">{m.actor}</span>
                </span>
                <select value={m.role} disabled={busy === m.actor}
                  onChange={(e) => changeRole(m.actor, e.target.value)}
                  className="rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] disabled:opacity-50">
                  {roles.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
                </select>
                <span className="text-right font-mono text-[11px] text-muted-foreground">{activityOf(m.actor)} run(s)</span>
                <span className="text-right font-mono text-[9px] text-muted-foreground">{m.granted_by}</span>
                <button type="button" disabled={busy === m.actor} title="remove member"
                  onClick={() => removeMember(m.actor)}
                  className="rounded-sm border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/20 disabled:opacity-50">
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'Roles' && (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {roles.map((r) => (
            <div key={r} className="rounded-md border border-border bg-card/40 p-3">
              <div className="flex items-center gap-2">
                <RoleBadge r={r} />
                <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                  {(rolePerms[r] ?? []).length}/{permissions.length} perms
                </span>
              </div>
              <div className="mt-1 font-mono text-[9px] text-muted-foreground">
                {members.filter((m) => m.role === r).length} user(s)
              </div>
              <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
                {(rolePerms[r] ?? []).length
                  ? (rolePerms[r] ?? []).map((p) => p.replace(/_/g, ' ')).join(' · ')
                  : 'read-only (no write permissions)'}
              </p>
            </div>
          ))}
        </div>
      )}

      {tab === 'Permissions' && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="border-b border-border">
                <th className="sticky left-0 bg-background px-2 align-bottom pb-2 text-left font-mono font-normal text-muted-foreground">permission</th>
                {roles.map((r) => (
                  <th key={r} className="h-28 px-1 align-bottom font-mono font-normal text-muted-foreground">
                    <div className="mx-auto w-4 whitespace-nowrap text-[9px] leading-none [writing-mode:vertical-rl] rotate-180">
                      {r.replace(/_/g, ' ')}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map((perm) => (
                <tr key={perm} className="border-b border-border/60">
                  <td className="sticky left-0 bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {perm.replace(/_/g, ' ')}
                  </td>
                  {roles.map((r) => {
                    const has = (rolePerms[r] ?? []).includes(perm)
                    return (
                      <td key={r} className="px-1 py-1 text-center">
                        <span className={has ? 'text-emerald-500' : 'text-muted-foreground/25'}>
                          {has ? '●' : '·'}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-border px-2 py-2 text-[9px] text-muted-foreground">
            Effective policy: {permissions.length} permissions × {roles.length} roles.
            Quote/order approvals sit with procurement (+org admin); physical
            evidence acceptance with reviewer/engineer; validation-passed with
            reviewer only.
          </p>
        </div>
      )}
    </div>
  )
}
