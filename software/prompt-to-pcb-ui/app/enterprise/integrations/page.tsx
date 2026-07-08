'use client'

/**
 * Integrations — EDA/CAD tool connectors (Altium, Eagle/Fusion, OrCAD, native
 * KiCad, interchange formats), API keys, webhooks, and SSO/SCIM. Honest status
 * throughout: what actually round-trips today vs planned; SSO/webhook delivery/
 * API enforcement are labelled as configuration records, not live functionality,
 * until wired.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { EnterpriseNav } from '@/components/enterprise-nav'

type Any = Record<string, any>

const CONN_STYLE: Record<string, string> = {
  native: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  supported: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  evaluating: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  planned: 'border-border bg-muted/30 text-muted-foreground',
}

export default function IntegrationsPage() {
  const [db, setDb] = useState<Any | null>(null)
  useEffect(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])
  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading integrations…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const ig = db.organizations?.[0]?.integrations ?? {}
  const connectors: Any[] = ig.eda_connectors ?? []
  const apiKeys: Any[] = ig.api_keys ?? []
  const webhooks: Any[] = ig.webhooks ?? []
  const sso = ig.sso ?? {}

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <Link href="/enterprise" className="text-muted-foreground hover:text-foreground">← Programs</Link>
        <h1 className="text-base font-semibold">Integrations</h1>
      </div>
      <EnterpriseNav />

      {/* EDA / CAD connectors */}
      <div className="mb-4">
        <h2 className="mb-2 text-xs font-semibold">EDA / CAD tool connectors</h2>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {connectors.map((c) => (
            <div key={c.name} className="rounded-md border border-border bg-card/40 p-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">{c.name}</span>
                <span className={cn('shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
                  CONN_STYLE[c.status] ?? 'border-border bg-muted/30 text-muted-foreground')}>
                  {c.status}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">{c.io}</div>
              <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/70">{c.kind}</div>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[9px] text-muted-foreground">
          KiCad is the native engine (Compose builds, routes and DRCs in KiCad).
          Altium / Eagle / OrCAD are import-export connectors — status reflects
          what actually round-trips today, not aspiration.
        </p>
      </div>

      {/* API keys + webhooks */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">API keys</div>
          <div className="divide-y divide-border">
            {apiKeys.map((k) => (
              <div key={k.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{k.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{k.masked}</span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">{k.scope}</span>
                </div>
                <div className="mt-0.5 text-[9px] text-amber-500">{k.note}</div>
              </div>
            ))}
            {!apiKeys.length && <p className="px-3 py-2 text-muted-foreground">No API keys.</p>}
          </div>
        </div>
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">Webhooks</div>
          <div className="divide-y divide-border">
            {webhooks.map((w) => (
              <div key={w.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{w.url}</span>
                  <span className={cn('shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
                    w.delivery === 'wired' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-500')}>
                    {w.delivery === 'wired' ? 'delivering' : 'not wired'}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">events: {(w.events ?? []).join(' · ')}</div>
                <div className="mt-0.5 text-[9px] text-muted-foreground/70">{w.note}</div>
              </div>
            ))}
            {!webhooks.length && <p className="px-3 py-2 text-muted-foreground">No webhooks.</p>}
          </div>
        </div>
      </div>

      {/* SSO / SCIM */}
      <div>
        <h2 className="mb-2 text-xs font-semibold">SSO / SCIM</h2>
        <div className="rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
              sso.status === 'configured' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-500')}>
              {sso.status?.replace(/_/g, ' ') ?? 'not configured'}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {(sso.protocols ?? []).join(' · ')} · SCIM {sso.scim ? 'on' : 'off'}
            </span>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">{sso.note ?? 'Single sign-on is available on Enterprise / Defense tiers.'}</p>
        </div>
      </div>
    </div>
  )
}
