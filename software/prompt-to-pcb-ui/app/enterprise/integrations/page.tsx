'use client'

/**
 * Integrations — EDA/CAD tool connectors (Altium, Eagle/Fusion, OrCAD, native
 * KiCad, interchange formats), API keys, webhooks, and SSO/SCIM. Honest status
 * throughout: what actually round-trips today vs planned; SSO/webhook delivery/
 * API enforcement are labelled as configuration records, not live functionality,
 * until wired.
 */
import { useCallback, useEffect, useState } from 'react'
import { AccessGate } from '@/components/access-gate'
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
  // SSO / SCIM config form
  const [ssoProvider, setSsoProvider] = useState('oidc')
  const [ssoForm, setSsoForm] = useState<Record<string, string>>({})
  const [scimEnabled, setScimEnabled] = useState(false)
  const [newScim, setNewScim] = useState<string | null>(null)
  const sf = (k: string) => ssoForm[k] ?? ''
  const setF = (k: string, v: string) => setSsoForm((s) => ({ ...s, [k]: v }))

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
  if (db.error) return <AccessGate error={db.error} />

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
          <span className="text-xs font-semibold">Export to Altium / OrCAD · Allegro / Xpedition / Fusion</span>
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
          and ODB++ import into Altium (Import Wizard), Cadence OrCAD/Allegro,
          Siemens Xpedition, and Autodesk Fusion Electronics. Native vendor
          binaries (<span className="font-mono">.PcbDoc</span>, Allegro <span className="font-mono">.brd</span>, Xpedition <span className="font-mono">.pcb</span>) write is
          not offered — those are proprietary with no reliable open format, and
          faking one would be dishonest. Import back via KiCad's Altium importer (GUI).
        </p>
      </div>

      {/* API keys + webhooks — real, admin-gated, audited */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        {/* API keys */}
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">
            API keys <span className="ml-1 font-mono text-[9px] text-muted-foreground">hashed at rest · shown once</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/30 px-3 py-2">
            <input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="key name (e.g. ci-readonly)"
              className="w-40 rounded-sm border border-border bg-background px-1.5 py-1 text-[11px]" />
            <select value={keyScope} onChange={(e) => setKeyScope(e.target.value)}
              className="rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]">
              <option value="read">read</option>
              <option value="read_write">read_write</option>
            </select>
            <button type="button" disabled={busy}
              onClick={async () => {
                if (!keyName.trim()) { setMsg({ tone: 'err', text: 'enter a key name first' }); return }
                const r = await act('create_api_key', { name: keyName.trim(), scope: keyScope })
                if (r.plaintext) { setNewKey(r.plaintext); setKeyName('') }
              }}
              className="rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
              Generate
            </button>
          </div>
          {newKey && (
            <div className="border-b border-border bg-emerald-500/10 px-3 py-2">
              <div className="font-mono text-[9px] uppercase tracking-wide text-emerald-500">copy now — shown once</div>
              <div className="mt-0.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-sm bg-background px-1.5 py-1 font-mono text-[10px]">{newKey}</code>
                <button type="button" onClick={() => navigator.clipboard?.writeText(newKey)}
                  className="shrink-0 rounded-sm border border-border px-2 py-1 text-[10px] hover:text-foreground">copy</button>
                <button type="button" onClick={() => setNewKey(null)}
                  className="shrink-0 rounded-sm border border-border px-2 py-1 text-[10px] hover:text-foreground">done</button>
              </div>
            </div>
          )}
          <div className="divide-y divide-border">
            {apiKeys.filter((k) => !k.revoked).map((k) => (
              <div key={k.id} className="flex items-center gap-2 px-3 py-2">
                <span className="text-xs font-medium">{k.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{k.masked}</span>
                <span className="font-mono text-[9px] text-muted-foreground">{k.scope}</span>
                <span className="font-mono text-[9px] text-muted-foreground">{k.last_used ? 'used' : 'unused'}</span>
                <button type="button" disabled={busy}
                  onClick={() => act('revoke_api_key', { id: k.id })}
                  className="ml-auto rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/20 disabled:opacity-50">
                  Revoke
                </button>
              </div>
            ))}
            {!apiKeys.filter((k) => !k.revoked).length && <p className="px-3 py-2 text-muted-foreground">No active API keys.</p>}
          </div>
          <p className="border-t border-border px-3 py-1.5 font-mono text-[9px] text-muted-foreground">
            Authorization: Bearer flk_live_… · read_write to build · audited ·{' '}
            <a href="/docs/api" className="underline underline-offset-2 hover:text-foreground">API reference →</a>
          </p>
        </div>

        {/* Webhooks */}
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">
            Webhooks <span className="ml-1 font-mono text-[9px] text-muted-foreground">https-only · HMAC-signed</span>
          </div>
          <div className="border-b border-border bg-card/30 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <input value={whUrl} onChange={(e) => setWhUrl(e.target.value)} placeholder="https://hooks.example.com/compose"
                className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]" />
              <button type="button" disabled={busy}
                onClick={async () => {
                  if (!whUrl.trim()) { setMsg({ tone: 'err', text: 'enter a https URL' }); return }
                  if (!whEvents.length) { setMsg({ tone: 'err', text: 'select at least one event' }); return }
                  const r = await act('create_webhook', { url: whUrl.trim(), events: whEvents })
                  if (r.secret) { setNewSecret({ url: r.url, secret: r.secret }); setWhUrl(''); setWhEvents([]) }
                }}
                className="rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
                Add
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {WEBHOOK_EVENTS.map((ev) => {
                const on = whEvents.includes(ev)
                return (
                  <button key={ev} type="button"
                    onClick={() => setWhEvents((s) => on ? s.filter((x) => x !== ev) : [...s, ev])}
                    className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
                      on ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                    {ev}
                  </button>
                )
              })}
            </div>
          </div>
          {newSecret && (
            <div className="border-b border-border bg-emerald-500/10 px-3 py-2">
              <div className="font-mono text-[9px] uppercase tracking-wide text-emerald-500">signing secret — shown once</div>
              <div className="mt-0.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-sm bg-background px-1.5 py-1 font-mono text-[10px]">{newSecret.secret}</code>
                <button type="button" onClick={() => navigator.clipboard?.writeText(newSecret.secret)}
                  className="shrink-0 rounded-sm border border-border px-2 py-1 text-[10px] hover:text-foreground">copy</button>
                <button type="button" onClick={() => setNewSecret(null)}
                  className="shrink-0 rounded-sm border border-border px-2 py-1 text-[10px] hover:text-foreground">done</button>
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">verify: X-Compose-Signature = sha256 HMAC(secret, body)</div>
            </div>
          )}
          <div className="divide-y divide-border">
            {webhooks.map((w) => (
              <div key={w.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{w.url}</span>
                  {w.last_delivery && (
                    <span className={cn('shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
                      w.last_delivery.status === 200 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-500')}>
                      last: {String(w.last_delivery.status)}
                    </span>
                  )}
                  <button type="button" disabled={busy}
                    onClick={() => act('delete_webhook', { id: w.id })}
                    className="shrink-0 rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/20 disabled:opacity-50">
                    Delete
                  </button>
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">events: {(w.events ?? []).join(' · ')}</div>
              </div>
            ))}
            {!webhooks.length && <p className="px-3 py-2 text-muted-foreground">No webhooks.</p>}
          </div>
          <p className="border-t border-border px-3 py-1.5 font-mono text-[9px] text-muted-foreground">
            fires on approval / quote / evidence events · SSRF-guarded · admin-only
          </p>
        </div>
      </div>

      {/* SSO / SCIM — real config surface (admin-gated, secrets redacted) */}
      <div>
        <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold">
          SSO / SCIM
          <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
            sso.status === 'configured' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-500')}>
            {sso.status?.replace(/_/g, ' ') ?? 'not configured'}
          </span>
          {sso.status === 'configured' && (
            <span className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-500">
              login enforcement not active
            </span>
          )}
        </h2>
        <div className="rounded-md border border-border">
          {sso.status === 'configured' && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-card/30 px-3 py-2 text-[10px] text-muted-foreground">
              <span>provider: <span className="font-mono text-foreground">{sso.provider}</span></span>
              {sso.oidc && <span>issuer: <span className="font-mono">{sso.oidc.issuer}</span></span>}
              {sso.oidc && <span>client: <span className="font-mono">{sso.oidc.client_id}</span></span>}
              {sso.oidc && <span>secret: <span className="font-mono">{sso.oidc.client_secret ?? '—'}</span></span>}
              {sso.saml && <span>entity: <span className="font-mono">{sso.saml.entity_id}</span></span>}
              {sso.saml && <span>SSO URL: <span className="font-mono">{sso.saml.sso_url}</span></span>}
              {sso.saml && <span>cert: <span className="font-mono">{sso.saml.certificate ?? '—'}</span></span>}
              <span>SCIM: <span className="font-mono">{sso.scim?.enabled ? `on (${sso.scim.token_masked ?? 'token set'})` : 'off'}</span></span>
              <button type="button" disabled={busy} onClick={() => act('disable_sso', {})}
                className="ml-auto rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/20 disabled:opacity-50">
                Disable
              </button>
            </div>
          )}

          {newScim && (
            <div className="border-b border-border bg-emerald-500/10 px-3 py-2">
              <div className="font-mono text-[9px] uppercase tracking-wide text-emerald-500">SCIM token — shown once</div>
              <div className="mt-0.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-sm bg-background px-1.5 py-1 font-mono text-[10px]">{newScim}</code>
                <button type="button" onClick={() => navigator.clipboard?.writeText(newScim)}
                  className="shrink-0 rounded-sm border border-border px-2 py-1 text-[10px] hover:text-foreground">copy</button>
                <button type="button" onClick={() => setNewScim(null)}
                  className="shrink-0 rounded-sm border border-border px-2 py-1 text-[10px] hover:text-foreground">done</button>
              </div>
            </div>
          )}

          {/* config form */}
          <div className="space-y-2 p-3">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium">Provider</span>
              {['oidc', 'saml'].map((p) => (
                <button key={p} type="button" onClick={() => setSsoProvider(p)}
                  className={cn('rounded-sm border px-2 py-0.5 font-mono text-[10px]',
                    ssoProvider === p ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                  {p === 'oidc' ? 'OIDC' : 'SAML 2.0'}
                </button>
              ))}
            </div>

            {ssoProvider === 'oidc' ? (
              <div className="grid gap-2 sm:grid-cols-3">
                <input value={sf('issuer')} onChange={(e) => setF('issuer', e.target.value)} placeholder="issuer (https://acme.okta.com)"
                  className="rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]" />
                <input value={sf('client_id')} onChange={(e) => setF('client_id', e.target.value)} placeholder="client ID"
                  className="rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]" />
                <input value={sf('client_secret')} onChange={(e) => setF('client_secret', e.target.value)} placeholder="client secret" type="password"
                  className="rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]" />
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-3">
                <input value={sf('entity_id')} onChange={(e) => setF('entity_id', e.target.value)} placeholder="IdP entity ID"
                  className="rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]" />
                <input value={sf('sso_url')} onChange={(e) => setF('sso_url', e.target.value)} placeholder="SSO URL (https://…)"
                  className="rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]" />
                <input value={sf('certificate')} onChange={(e) => setF('certificate', e.target.value)} placeholder="X.509 signing certificate (PEM)"
                  className="rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]" />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-[11px]">
                <input type="checkbox" checked={scimEnabled} onChange={(e) => setScimEnabled(e.target.checked)} />
                Enable SCIM provisioning
              </label>
              <button type="button" disabled={busy}
                onClick={async () => {
                  const params: Record<string, any> = { provider: ssoProvider, scim_enabled: scimEnabled, ...ssoForm }
                  const r = await act('configure_sso', params)
                  if (r.status === 'configured') { setSsoForm({}); if (r.scim_token) setNewScim(r.scim_token) }
                }}
                className="rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
                {sso.status === 'configured' ? 'Update SSO' : 'Save SSO config'}
              </button>
              <span className="font-mono text-[9px] text-muted-foreground">admin-only · audited · secrets stored redacted</span>
            </div>

            <p className="text-[9px] text-muted-foreground">
              Stores the IdP connection. Login enforcement is a separate, verified
              step: it needs the callback/ACS endpoints wired against your live IdP.
              Nothing here logs a user in via SSO until that is done — the status
              stays honest ("configured — login enforcement not active").
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
