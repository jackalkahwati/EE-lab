/**
 * Enterprise platform API — single dispatcher over the file-backed store.
 * GET  -> current enterprise state (org/workspace/program/board/run tree)
 * POST -> { action, params } mutation dispatch.
 *
 * Every mutation is audited; readiness promotions run through the same
 * guardReadiness used by tests — the UI cannot reach a state the gates
 * refuse. RBAC checks wrap this dispatcher (E5).
 */
// @ts-ignore - plain ESM modules shared with node test scripts
import * as ent from '@/lib/enterprise/store.mjs'
// @ts-ignore
import * as rbac from '@/lib/enterprise/rbac.mjs'
// @ts-ignore
import * as approvals from '@/lib/enterprise/approvals.mjs'
// @ts-ignore
import * as credits from '@/lib/enterprise/credits.mjs'
// @ts-ignore
import * as quotes from '@/lib/enterprise/quotes.mjs'
// @ts-ignore
import * as fl1 from '@/lib/enterprise/fl1.mjs'
// @ts-ignore
import * as pilots from '@/lib/enterprise/pilots.mjs'
// @ts-ignore
import * as integrations from '@/lib/enterprise/integrations.mjs'

export const dynamic = 'force-dynamic'

// action -> webhook event fired after a successful mutation
const WEBHOOK_FOR: Record<string, string> = {
  request_approval: 'approval.requested',
  decide_approval: 'approval.decided',
  advance_quote: 'quote.advanced',
  add_evidence: 'evidence.added',
  review_evidence: 'evidence.reviewed',
}

export async function GET() {
  const db = ent.loadDb()
  return Response.json({
    // never leak API-key hashes or webhook secrets through the read API
    organizations: (db.organizations ?? []).map((o: any) => ({
      ...o, integrations: integrations.redactIntegrations(o.integrations) })),
    workspaces: db.workspaces,
    programs: db.programs,
    boards: db.boards,
    runs: db.runs,
    evidence: db.evidence,
    approvals: db.approvals,
    usage: db.usage,
    pilots: db.pilots,
    quotes: db.quotes,
    fl1_assets: db.fl1_assets,
    validation_sessions: db.validation_sessions,
    members: db.members ?? [],
    audit_tail: db.audit.slice(-50),
    audit_chain: ent.verifyAuditChain(db),
    // static RBAC catalog so Settings can render roles + what each can do
    // (Sets aren't JSON-serialisable — expand to arrays)
    rbac: {
      roles: rbac.ROLES,
      permissions: rbac.PERMISSIONS,
      role_permissions: Object.fromEntries(
        rbac.ROLES.map((r: string) => [r, [...(rbac.ROLE_PERMISSIONS[r] ?? [])]])),
    },
  })
}

export async function POST(req: Request) {
  const { action, params = {}, actor = 'dev-admin' } = await req.json()
  const db = ent.loadDb()

  const gate = rbac.checkAction(db, actor, action, params)
  if (!gate.ok) {
    ent.appendAudit(db, {
      actor, action: `DENIED:${action}`, scope: params,
      note: gate.reason,
    })
    ent.saveDb(db)
    return Response.json({ error: 'permission denied', detail: gate.reason },
                         { status: 403 })
  }

  const handlers: Record<string, (p: any) => any> = {
    create_organization: (p) => ent.createOrganization(db, { ...p, actor }),
    create_workspace: (p) => ent.createWorkspace(db, { ...p, actor }),
    create_program: (p) => ent.createProgram(db, { ...p, actor }),
    create_board: (p) => ent.createBoard(db, { ...p, actor }),
    attach_run: (p) => ent.attachRun(db, { ...p, actor }),
    add_evidence: (p) => ent.addEvidence(db, { ...p, actor }),
    review_evidence: (p) => ent.reviewEvidence(db, { ...p, actor }),
    set_readiness: (p) => ent.setBoardReadiness(db, { ...p, actor }),
    set_member_role: (p) => {
      const r = rbac.setMemberRole(db, { ...p, actor })
      if (!r.error) ent.appendAudit(db, {
        actor, action: 'set_member_role', scope: p, after: r })
      return r
    },
    remove_member: (p) => {
      const r = rbac.removeMember(db, { ...p, actor })
      if (!r.error) ent.appendAudit(db, {
        actor, action: 'remove_member', scope: p, after: r })
      return r
    },
    audit_log_report: (p) => rbac.auditLogReport(db, p ?? {}),
  }
  // milestone extensions (approvals E2, credits E4, quotes E7, FL-1 E8,
  // pilots E6) — each module owns its handlers
  for (const m of [approvals, credits, quotes, fl1, pilots, integrations]) {
    Object.assign(handlers, m.handlers(db, actor))
  }

  const fn = handlers[action]
  if (!fn) return Response.json({ error: `unknown action ${action}` },
                                { status: 400 })
  const result = fn(params)
  if (result?.error) return Response.json(result, { status: 422 })
  // fire subscribed webhooks (best-effort, HMAC-signed) before persisting the
  // last_delivery status they record
  const event = WEBHOOK_FOR[action]
  if (event) { try { await integrations.fireWebhooks(db, event, { action, params, result }) } catch { /* best effort */ } }
  ent.saveDb(db)
  return Response.json({ ok: true, result })
}
