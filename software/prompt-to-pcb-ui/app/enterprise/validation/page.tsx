'use client'

/**
 * Validation console — FL-1 assets, validation sessions, and the physical
 * evidence ledger, wired to the real RBAC-gated dispatcher. HONESTY RAIL:
 * uploading evidence records it as review-required only; it never marks a board
 * physically_validated. Physical evidence is accepted ONLY by a reviewer's
 * explicit decision, and the ledger stays empty until that happens.
 */
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { currentActor, enterpriseAction } from '@/lib/enterprise-actions'

type Any = Record<string, any>

const STATUS_STYLE: Record<string, string> = {
  planned: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  ready: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  running: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  completed_pending_review: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  accepted: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  rejected: 'border-destructive/40 bg-destructive/10 text-destructive',
  blocked: 'border-destructive/40 bg-destructive/10 text-destructive',
  archived: 'border-border bg-muted/30 text-muted-foreground',
}
const SESSION_NEXT: Record<string, string[]> = {
  planned: ['ready'], ready: ['running'], running: ['completed_pending_review'],
  completed_pending_review: ['accepted', 'rejected'],
}
const EVIDENCE_TYPES = [
  'physical_measurement', 'visual_inspection', 'continuity_results', 'i2c_scan',
  'oscilloscope_capture', 'thermal_image', 'calibration_evidence', 'operator_notes',
]

export default function ValidationPage() {
  const [db, setDb] = useState<Any | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  // plan-session form
  const [pAsset, setPAsset] = useState('')
  const [pBoard, setPBoard] = useState('')
  const [pOperator, setPOperator] = useState('')
  // evidence form
  const [eBoard, setEBoard] = useState('')
  const [eType, setEType] = useState(EVIDENCE_TYPES[0])
  const [eSource, setESource] = useState('')
  const [eFile, setEFile] = useState<File | null>(null)
  const [me, setMe] = useState('')

  const refresh = useCallback(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])
  useEffect(() => { refresh(); currentActor().then(setMe) }, [refresh])

  async function run(action: string, params: Any, okText: string) {
    setBusy(true); setMsg(null)
    const r = await enterpriseAction(action, params)
    setBusy(false)
    if (r.error) setMsg({ tone: 'err', text: `${r.error}${r.detail ? ` — ${r.detail}` : ''}` })
    else { setMsg({ tone: 'ok', text: okText }); refresh() }
  }

  async function uploadEvidence() {
    if (!eBoard || !eFile) return
    setBusy(true); setMsg(null)
    const fd = new FormData()
    fd.append('file', eFile)
    fd.append('board_id', eBoard)
    fd.append('evidence_type', eType)
    fd.append('source', eSource || eFile.name)
    fd.append('actor', me)
    try {
      const res = await fetch('/api/evidence-upload', { method: 'POST', body: fd })
      const j = await res.json()
      if (j.error) setMsg({ tone: 'err', text: `${j.error}${j.detail ? ` — ${j.detail}` : ''}` })
      else { setMsg({ tone: 'ok', text: `uploaded ${j.result?.file} (${j.result?.status})` }); setEFile(null); setESource(''); refresh() }
    } catch (e: any) { setMsg({ tone: 'err', text: String(e?.message ?? e) }) }
    setBusy(false)
  }

  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading validation…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const org = db.organizations?.[0]
  const boards: Any[] = db.boards ?? []
  const boardName = (id: string) => boards.find((b) => b.board_id === id)?.name ?? id
  const sessions: Any[] = db.validation_sessions ?? []
  const assets: Any[] = db.fl1_assets ?? []
  const evidence: Any[] = (db.evidence ?? []).filter((e: Any) => e.physical)
  const accepted = evidence.filter((e: Any) => e.status === 'accepted')

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-base font-semibold">Validation console</h1>
        <span className="text-muted-foreground">{sessions.length} session(s) · {assets.length} asset(s)</span>
        {msg && (
          <span className={cn('ml-auto rounded-sm px-2 py-0.5 font-mono text-[10px]',
            msg.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-destructive/10 text-destructive')}>
            {msg.text}
          </span>
        )}
      </div>

      <div className="mb-3 rounded-md border border-border bg-muted/10 px-3 py-2 text-[10px] text-muted-foreground">
        Physical evidence ledger:{' '}
        <span className="font-mono text-foreground">{accepted.length ? `${accepted.length} accepted` : 'EMPTY'}</span>
        {' '}— uploading evidence records it review-required only; a board becomes
        physically_validated ONLY when a reviewer accepts real evidence.
      </div>

      {/* action row: register asset + plan session */}
      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2">
          <span className="text-[11px] font-medium">Register FL-1 asset</span>
          <button type="button" disabled={busy}
            onClick={() => run('register_fl1_asset', { org_id: org?.org_id }, 'asset registered')}
            className="rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
            Register
          </button>
          <span className="font-mono text-[9px] text-muted-foreground">gated by manage_fl1_assets</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2">
          <span className="text-[11px] font-medium">Plan session</span>
          <select value={pAsset} onChange={(e) => setPAsset(e.target.value)} className="rounded-sm border border-border bg-background px-1.5 py-1 text-[11px]">
            <option value="">asset…</option>
            {assets.map((a) => <option key={a.asset_id} value={a.asset_id}>{a.serial_placeholder ?? a.asset_id}</option>)}
          </select>
          <select value={pBoard} onChange={(e) => setPBoard(e.target.value)} className="rounded-sm border border-border bg-background px-1.5 py-1 text-[11px]">
            <option value="">board…</option>
            {boards.map((b) => <option key={b.board_id} value={b.board_id}>{b.name}</option>)}
          </select>
          <input value={pOperator} onChange={(e) => setPOperator(e.target.value)} placeholder="operator"
            className="w-24 rounded-sm border border-border bg-background px-1.5 py-1 text-[11px]" />
          <button type="button" disabled={busy || !pAsset || !pBoard || !pOperator}
            onClick={() => run('plan_validation_session', { asset_id: pAsset, board_id: pBoard, operator: pOperator }, 'session planned')}
            className="rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
            Plan
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">Validation sessions</div>
          <div className="divide-y divide-border">
            {sessions.length === 0 && <p className="px-3 py-3 text-muted-foreground">No sessions planned.</p>}
            {sessions.map((s) => (
              <div key={s.session_id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">{boardName(s.board_id)}</span>
                  <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
                    STATUS_STYLE[s.status] ?? 'border-border bg-muted/30 text-muted-foreground')}>
                    {s.status}
                  </span>
                  {(SESSION_NEXT[s.status] ?? []).map((to) => (
                    <button key={to} type="button" disabled={busy}
                      onClick={() => run('advance_session', { session_id: s.session_id, to }, `→ ${to.replace(/_/g, ' ')}`)}
                      className={cn('rounded-sm border px-1.5 py-0.5 text-[10px] disabled:opacity-50',
                        to === 'rejected' ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
                          : to === 'accepted' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
                            : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20')}>
                      → {to.replace(/_/g, ' ')}
                    </button>
                  ))}
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">{s.session_id}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span>operator: {s.operator ?? 'unassigned'}</span>
                  <span>measurements: {(s.measurements ?? []).length}</span>
                  <span>evidence: {(s.evidence_ids ?? []).length}</span>
                  {(s.failures ?? []).length > 0 && <span className="text-destructive">failures: {(s.failures ?? []).length}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">FL-1 validation assets</div>
          <div className="divide-y divide-border">
            {assets.length === 0 && <p className="px-3 py-3 text-muted-foreground">No FL-1 assets registered.</p>}
            {assets.map((a, i) => (
              <div key={i} className="px-3 py-2">
                <div className="text-xs font-medium">{a.serial_placeholder ?? a.asset_id ?? `asset ${i + 1}`}</div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {a.status ?? 'registered'}{a.location_placeholder ? ` · ${a.location_placeholder}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* physical evidence ledger + upload */}
      <div className="mt-4 rounded-md border border-border">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold">Physical evidence ledger</div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/30 px-3 py-2">
          <span className="text-[11px] font-medium">Record evidence</span>
          <select value={eBoard} onChange={(e) => setEBoard(e.target.value)} className="rounded-sm border border-border bg-background px-1.5 py-1 text-[11px]">
            <option value="">board…</option>
            {boards.map((b) => <option key={b.board_id} value={b.board_id}>{b.name}</option>)}
          </select>
          <select value={eType} onChange={(e) => setEType(e.target.value)} className="rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px]">
            {EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
          <input type="file" onChange={(e) => setEFile(e.target.files?.[0] ?? null)}
            className="max-w-[13rem] text-[10px] file:mr-2 file:rounded-sm file:border file:border-border file:bg-background file:px-2 file:py-0.5 file:text-[10px]" />
          <input value={eSource} onChange={(e) => setESource(e.target.value)} placeholder="note (optional)"
            className="w-40 rounded-sm border border-border bg-background px-1.5 py-1 text-[11px]" />
          <button type="button" disabled={busy || !eBoard || !eFile}
            onClick={uploadEvidence}
            className="rounded-sm border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
            Upload
          </button>
          <span className="font-mono text-[9px] text-amber-500">uploads a REAL file (≤20MB) · enters review-required · a reviewer must accept before it counts</span>
        </div>
        <div className="divide-y divide-border">
          {evidence.length === 0 && <p className="px-3 py-3 text-muted-foreground">No physical evidence on file.</p>}
          {evidence.map((e) => {
            const decidable = e.status !== 'accepted' && e.status !== 'rejected'
            return (
              <div key={e.evidence_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-mono text-[10px]">{e.evidence_type?.replace(/_/g, ' ')}</span>
                <span className="text-[11px] text-muted-foreground">{boardName(e.scope_id)}</span>
                <span className="text-[10px] text-muted-foreground">{e.source}</span>
                <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
                  STATUS_STYLE[e.status] ?? 'border-amber-500/40 bg-amber-500/10 text-amber-500')}>
                  {e.status ?? 'review_required'}
                </span>
                {decidable && (
                  <span className="ml-auto flex gap-1">
                    <button type="button" disabled={busy}
                      onClick={() => run('review_evidence', { evidence_id: e.evidence_id, decision: 'accepted', reviewer: me }, 'evidence accepted')}
                      className="rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-500 hover:bg-emerald-500/20 disabled:opacity-50">
                      Accept
                    </button>
                    <button type="button" disabled={busy}
                      onClick={() => run('review_evidence', { evidence_id: e.evidence_id, decision: 'rejected', reviewer: me }, 'evidence rejected')}
                      className="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/20 disabled:opacity-50">
                      Reject
                    </button>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
