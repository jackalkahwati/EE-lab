'use client'

/**
 * Integrations — EDA/CAD tool connectors (Altium, Eagle/Fusion, OrCAD, native
 * KiCad, interchange formats), API keys, webhooks, and SSO/SCIM. Honest status
 * throughout: what actually round-trips today vs planned; SSO/webhook delivery/
 * API enforcement are labelled as configuration records, not live functionality,
 * until wired.
 */
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { enterpriseAction } from '@/lib/enterprise-actions'

type Any = Record<string, any>

const WEBHOOK_EVENTS = [
  'approval.requested', 'approval.decided', 'quote.advanced',
  'evidence.added', 'evidence.reviewed',
]

const FORMATS = [
  { fmt: 'ipc2581', label: 'IPC-2581', hint: 'Import Wizard → IPC-2581' },
  { fmt: 'odb', label: 'ODB++', hint: 'Import Wizard / CAMtastic' },
  { fmt: 'pack', label: 'Handoff pack (.zip)', hint: 'IPC-2581 + ODB++ + BOM + readme' },
]

const CONN_STYLE: Record<string, string> = {
  native: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  supported: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  evaluating: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  planned: 'border-border bg-muted/30 text-muted-foreground',
}

export default function IntegrationsPage() {
  const [db, setDb] = useState<Any | null>(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  // API key form + show-once reveal
  const [keyName, setKeyName] = useState('')
  const [keyScope, setKeyScope] = useState('read')
  const [newKey, setNewKey] = useState<string | null>(null)
  // webhook form + show-once reveal
  const [whUrl, setWhUrl] = useState('')
  const [whEvents, setWhEvents] = useState<string[]>([])
  const [newSecret, setNewSecret] = useState<{ url: string; secret: string } | null>(null)

  const refresh = useCallback(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])

  async function act(action: string, params: Any): Promise<Any> {
    setBusy(true); setMsg(null)
    const r = await enterpriseAction(action, params)
    setBusy(false)
    if (r.error) { setMsg({ tone: 'err', text: `${r.error}${r.detail ? ` — ${r.detail}` : ''}` }); return {} }
    setMsg({ tone: 'ok', text: 'done' }); refresh()
    return r.result ?? {}
  }

  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading integrations…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const ig = db.organizations?.[0]?.integrations ?? {}
  const connectors: Any[] = ig.eda_connectors ?? []
  const apiKeys: Any[] = ig.api_keys ?? []
  const webhooks: Any[] = ig.webhooks ?? []
  const sso = ig.sso ?? {}

  // board -> its KiCad run dir (for the real Altium export)
  const boards: Any[] = db.boards ?? []
  const runs: Any[] = db.runs ?? []
  const runDirOf = (board_id: string) =>
    runs.find((r) => r.board_id === board_id)?.source_run_dir ?? null
  const exportable = boards
    .map((b) => ({ b, run: runDirOf(b.board_id) }))
    .filter((x) => x.run)
  const pickedRun = runDirOf(pick)

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-base font-semibold">Integrations</h1>
        {msg && (
          <span className={cn('ml-auto rounded-sm px-2 py-0.5 font-mono text-[10px]',
            msg.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-destructive/10 text-destructive')}>
            {msg.text}
          </span>
        )}
      </div>

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

      {/* CAD export — real handoff via neutral formats (Altium · OrCAD/Allegro · CAM) */}
      <div className="mb-4 rounded-md border border-primary/30 bg-primary/[0.03]">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">Export to Altium / OrCAD / Allegro</span>
          <span className="rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-500">
            live
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <select value={pick} onChange={(e) => setPick(e.target.value)}
            className="rounded-sm border border-border bg-background px-2 py-1 text-xs">
            <option value="">select a board…</option>
            {exportable.map(({ b }) => <option key={b.board_id} value={b.board_id}>{b.name}</option>)}
          </select>
          {FORMATS.map((f) => (
            <a key={f.fmt}
              aria-disabled={!pickedRun}
              title={f.hint}
              href={pickedRun ? `/api/cad-export?run=${encodeURIComponent(pickedRun)}&format=${f.fmt}` : undefined}
              className={cn('rounded-sm border px-2.5 py-1 text-[11px]',
                pickedRun
                  ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                  : 'pointer-events-none border-border text-muted-foreground opacity-50')}>
              ↓ {f.label}
            </a>
          ))}
        </div>
        <p className="border-t border-border px-3 py-2 text-[9px] text-muted-foreground">
          Generates real files with kicad-cli and streams them to you: IPC-2581
          and ODB++ import into both Altium (File → Import Wizard) and Cadence
          Allegro. Native <span className="font-mono">.PcbDoc</span> / Allegro <span className="font-mono">.brd</span> write is
          not offered — those are proprietary binaries with no reliable open
          format, and faking one would be dishonest. Import back via KiCad's
          built-in Altium importer (GUI).
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
