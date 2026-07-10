/**
 * E1 — Enterprise Program Workspace store.
 *
 * File-backed JSON store (data/enterprise/store.json — gitignored runtime
 * state; the demo seed script regenerates it). Plain ESM so the same module
 * runs under Next API routes and plain-node tests.
 *
 * INVARIANT: nothing in the enterprise layer weakens an engineering gate.
 * Readiness promotion is guarded here (guardReadiness): production_ready is
 * structurally unreachable without accepted physical + yield + manufacturing
 * evidence AND an explicit approval; approved_for_quote requires an approval
 * record; physically_validated requires an ACCEPTED evidence item whose
 * artifact file really exists. Blocked claims are never deleted by state
 * changes — only explicit review can move them, and this layer has no API
 * to do so.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = path.resolve(HERE, '..', '..')
const STORE_DIR = process.env.ENTERPRISE_STORE_DIR
  || path.join(APP_ROOT, 'data', 'enterprise')
const STORE = path.join(STORE_DIR, 'store.json')

export const PROGRAM_STATUSES = [
  'intake', 'architecture', 'board_generation', 'review_required',
  'package_ready_with_review', 'quote_ready', 'approved_for_quote',
  'fab_pending', 'built_pending_evidence', 'validation_in_progress',
  'validated_with_evidence', 'blocked', 'archived',
]

export const READINESS_STATES = [
  'architecture_only', 'blocked', 'routed_in_sandbox',
  'package_ready_with_review', 'approved_for_quote',
  'physical_evidence_pending', 'physically_validated', 'production_ready',
]

export const EVIDENCE_TYPES = [
  'route_evidence', 'drc_report', 'erc_report', 'external_eda_analysis',
  'manufacturing_package', 'firmware_build', 'validation_plan',
  'physical_measurement', 'visual_inspection', 'continuity_results',
  'i2c_scan', 'oscilloscope_capture', 'thermal_image', 'yield_evidence',
  'manufacturing_evidence', 'calibration_evidence', 'operator_notes',
]

// evidence that asserts something PHYSICAL must point at a real file
const PHYSICAL_EVIDENCE_TYPES = new Set([
  'physical_measurement', 'visual_inspection', 'continuity_results',
  'i2c_scan', 'oscilloscope_capture', 'thermal_image', 'yield_evidence',
  'manufacturing_evidence', 'calibration_evidence',
])

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`
}

function emptyDb() {
  return {
    version: 1,
    organizations: [], workspaces: [], programs: [], boards: [], runs: [],
    evidence: [], approvals: [], usage: [], audit: [],
    pilots: [], quotes: [], fl1_assets: [], validation_sessions: [],
  }
}

export function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'))
  } catch {
    return emptyDb()
  }
}

export function saveDb(db) {
  fs.mkdirSync(STORE_DIR, { recursive: true })
  const tmp = STORE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1))
  fs.renameSync(tmp, STORE)
  return db
}

export function resetDb() {
  return saveDb(emptyDb())
}

// ---------------------------------------------------------------------------
// audit (append-only; hash-chained so tampering is detectable)
// ---------------------------------------------------------------------------
export function appendAudit(db, entry) {
  const prev = db.audit[db.audit.length - 1]
  const body = {
    seq: db.audit.length,
    actor: entry.actor ?? 'system',
    action: entry.action,
    scope: entry.scope ?? {},
    before: entry.before ?? null,
    after: entry.after ?? null,
    note: entry.note ?? null,
    evidence_snapshot: entry.evidence_snapshot ?? null,
    approval_snapshot: entry.approval_snapshot ?? null,
    session: entry.session ?? null,
    at: new Date().toISOString(),
    prev_hash: prev ? prev.hash : 'genesis',
  }
  body.hash = crypto.createHash('sha256')
    .update(JSON.stringify(body)).digest('hex').slice(0, 24)
  db.audit.push(body)
  return body
}

export function verifyAuditChain(db) {
  let prev = 'genesis'
  for (const e of db.audit) {
    const { hash, ...body } = e
    if (body.prev_hash !== prev) return { ok: false, broken_at: e.seq }
    const h = crypto.createHash('sha256')
      .update(JSON.stringify(body)).digest('hex').slice(0, 24)
    if (h !== hash) return { ok: false, broken_at: e.seq }
    prev = hash
  }
  return { ok: true, entries: db.audit.length }
}

// ---------------------------------------------------------------------------
// entity constructors
// ---------------------------------------------------------------------------
export function createOrganization(db, { name, plan = 'pilot', actor }) {
  const org = {
    org_id: newId('org'), name, plan,
    created_at: new Date().toISOString(),
    policies: { default_evidence_policy: 'review_required',
                default_approval_policy: 'enterprise_external_board' },
    security_settings: { auth: 'session', demo: false },
    credit_allocation: 0, usage_limits: { monthly_runs: null },
  }
  db.organizations.push(org)
  appendAudit(db, { actor, action: 'create_organization',
                    scope: { org_id: org.org_id }, after: { name, plan } })
  return org
}

export function createWorkspace(db, { org_id, name, description = '', actor }) {
  const ws = {
    workspace_id: newId('ws'), org_id, name, description,
    members: [], programs: [],
    default_evidence_policy: 'review_required',
    default_approval_policy: 'enterprise_external_board',
    credit_allocation: 0,
    created_at: new Date().toISOString(),
  }
  db.workspaces.push(ws)
  appendAudit(db, { actor, action: 'create_workspace',
                    scope: { org_id, workspace_id: ws.workspace_id },
                    after: { name } })
  return ws
}

export function createProgram(db, { workspace_id, name, owner = 'internal',
                                    objective = '', business_context = '',
                                    technical_scope = '', target_dates = {},
                                    budget_credits = 0, actor }) {
  const p = {
    program_id: newId('prog'), workspace_id, name, owner,
    objective, business_context, technical_scope,
    board_list: [], target_dates,
    status: 'intake',
    budget: { credits_allocated: budget_credits, credits_consumed: 0 },
    risks: [], blocked_claims: [],
    evidence_state: 'none',
    approval_state: 'not_requested',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  db.programs.push(p)
  const ws = db.workspaces.find((w) => w.workspace_id === workspace_id)
  if (ws) ws.programs.push(p.program_id)
  appendAudit(db, { actor, action: 'create_program',
                    scope: { workspace_id, program_id: p.program_id },
                    after: { name, owner } })
  return p
}

export function createBoard(db, { program_id, name, board_class = '',
                                  requested_function = '',
                                  architecture_summary = '', actor }) {
  const b = {
    board_id: newId('brd'), program_id, name, board_class,
    requested_function, architecture_summary,
    current_design_state: 'not_started',
    routed_state: 'not_routed',
    package_state: 'package_not_ready',
    validation_state: 'not_planned',
    physical_evidence_state: 'none',
    production_readiness_state: 'not_production_ready',
    readiness: 'architecture_only',
    blocked_claims: [], review_required_items: [],
    latest_run_id: null,
    manufacturing_packages: [], validation_workflows: [],
    created_at: new Date().toISOString(),
  }
  db.boards.push(b)
  const p = db.programs.find((x) => x.program_id === program_id)
  if (p) { p.board_list.push(b.board_id); p.updated_at = b.created_at }
  appendAudit(db, { actor, action: 'create_board',
                    scope: { program_id, board_id: b.board_id },
                    after: { name, board_class } })
  return b
}

/** Attach an EXISTING Compose run (public/runs/<runDir>) to a board. Reads
 *  the real last-run + drc artifacts so route/DRC states are facts, not
 *  claims. Never fabricates: missing artifacts -> 'unknown'. */
export function attachRun(db, { board_id, run_dir, prompt = null,
                                created_by = 'system', actor }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run_dir ?? '')) {
    return { error: 'invalid run_dir' }
  }
  const dataDir = path.join(APP_ROOT, 'public', 'runs', run_dir, 'data')
  const readJson = (f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')) }
    catch { return null }
  }
  const lr = readJson('last-run.json')
  const drc = readJson('drc.json')
  const adv = readJson('advanced-routing-report.json')
  const hardViol = drc
    ? (drc.violations ?? []).filter((v) => v.type !== 'solder_mask_bridge').length
    : null
  const run = {
    run_id: newId('run'), board_id,
    source_run_dir: run_dir,
    prompt: prompt ?? lr?.prompt ?? null,
    repo_commit: lr?.repoCommit ?? null,
    tool_versions: { kicad: lr?.board?.drc?.kicadVersion ?? null },
    route_evidence_state: lr
      ? (lr.board?.unroutedNets?.length === 0 ? 'routed_in_sandbox'
         : 'routed_with_open_nets')
      : 'unknown',
    drc_state: hardViol === null ? 'unknown'
      : hardViol === 0 ? 'drc_clean' : `drc_violations:${hardViol}`,
    erc_state: lr?.stages?.erc?.state ?? 'unknown',
    firmware_state: lr?.stages?.firmware?.state ?? 'unknown',
    external_eda_state: readJson('external-analysis-run-report.json')
      ? 'analyses_recorded' : 'inventory_only_or_absent',
    package_artifacts: fs.existsSync(path.join(dataDir, '..', 'board'))
      ? ['board/'] : [],
    validation_artifacts: readJson('fl1-testplan.json')
      ? ['fl1-testplan.json'] : [],
    credit_usage: null,
    approval_requirements: [],
    readiness_state: lr?.status === 'PASSED'
      ? 'routed_in_sandbox' : (lr ? 'blocked' : 'architecture_only'),
    created_by,
    created_at: new Date().toISOString(),
  }
  db.runs.push(run)
  const b = db.boards.find((x) => x.board_id === board_id)
  if (b) {
    b.latest_run_id = run.run_id
    b.routed_state = run.route_evidence_state
    if (run.readiness_state === 'routed_in_sandbox'
        && b.readiness === 'architecture_only') {
      b.readiness = 'routed_in_sandbox'
    }
    // inherit honest warnings as review-required items (never hidden)
    const cons = readJson('constraints.json')
    for (const u of cons?.unsupported ?? []) {
      b.review_required_items.push(`unsupported constraint: ${u.feature}`)
    }
    for (const u of adv?.unsupported_constraints ?? []) {
      b.blocked_claims.push(`advanced routing: ${u.pair} unsupported by v1 router`)
    }
  }
  appendAudit(db, { actor, action: 'attach_run',
                    scope: { board_id, run_id: run.run_id },
                    after: { run_dir, readiness: run.readiness_state } })
  return run
}

export function addEvidence(db, { scope_type, scope_id, evidence_type, source,
                                  artifact_path = null, reviewer = null,
                                  claim_implications = [], blocked_claims = [],
                                  notes = '', actor }) {
  if (!EVIDENCE_TYPES.includes(evidence_type)) {
    return { error: `unknown evidence_type ${evidence_type}` }
  }
  const physical = PHYSICAL_EVIDENCE_TYPES.has(evidence_type)
  if (physical) {
    const abs = artifact_path && path.isAbsolute(artifact_path)
      ? artifact_path : artifact_path && path.join(APP_ROOT, artifact_path)
    if (!abs || !fs.existsSync(abs)) {
      return { error: 'physical evidence requires a REAL artifact file; ' +
                      'refusing to record presence without one' }
    }
  }
  const ev = {
    evidence_id: newId('ev'), scope_type, scope_id, evidence_type, source,
    artifact_path,
    status: physical ? 'uploaded_pending_review' : 'recorded',
    reviewer, timestamp: new Date().toISOString(),
    claim_implications, blocked_claims, human_review_notes: notes,
  }
  db.evidence.push(ev)
  appendAudit(db, { actor, action: 'add_evidence',
                    scope: { [scope_type]: scope_id },
                    after: { evidence_type, status: ev.status } })
  return ev
}

/** Evidence review — the ONLY path that moves physical evidence to
 *  'accepted'. Requires a named reviewer. */
export function reviewEvidence(db, { evidence_id, decision, reviewer, notes = '',
                                     actor }) {
  const ev = db.evidence.find((e) => e.evidence_id === evidence_id)
  if (!ev) return { error: 'no such evidence' }
  if (!reviewer) return { error: 'review requires a named reviewer' }
  if (!['accepted', 'rejected'].includes(decision)) {
    return { error: 'decision must be accepted|rejected' }
  }
  const before = ev.status
  ev.status = decision
  ev.reviewer = reviewer
  ev.human_review_notes = notes
  appendAudit(db, { actor, action: 'review_evidence',
                    scope: { evidence_id }, before: { status: before },
                    after: { status: decision, reviewer } })
  return ev
}

// ---------------------------------------------------------------------------
// readiness guard — the enterprise layer's load-bearing honesty rule
// ---------------------------------------------------------------------------
export function guardReadiness(db, board, next) {
  const reasons = []
  if (!READINESS_STATES.includes(next)) {
    return { ok: false, reasons: [`unknown readiness state ${next}`] }
  }
  const approvals = db.approvals.filter(
    (a) => a.scope?.board_id === board.board_id && a.status === 'approved')
  const acceptedEvidence = db.evidence.filter(
    (e) => e.scope_id === board.board_id && e.status === 'accepted')
  const acceptedOfType = (t) => acceptedEvidence.filter(
    (e) => e.evidence_type === t)

  if (next === 'approved_for_quote') {
    if (!approvals.some((a) => a.approval_type === 'approved_for_quote')) {
      reasons.push('approved_for_quote requires an explicit approved ' +
                   'approval record — it cannot be inferred')
    }
  }
  if (next === 'physically_validated') {
    const phys = acceptedEvidence.filter(
      (e) => PHYSICAL_EVIDENCE_TYPES.has(e.evidence_type))
    if (phys.length === 0) {
      reasons.push('physically_validated requires at least one ACCEPTED ' +
                   'physical evidence item with a real artifact file')
    }
  }
  if (next === 'production_ready') {
    if (acceptedOfType('physical_measurement').length === 0
        && acceptedOfType('visual_inspection').length === 0) {
      reasons.push('production_ready requires accepted physical evidence')
    }
    if (acceptedOfType('yield_evidence').length === 0) {
      reasons.push('production_ready requires accepted yield evidence')
    }
    if (acceptedOfType('manufacturing_evidence').length === 0) {
      reasons.push('production_ready requires accepted manufacturing evidence')
    }
    if (!approvals.some(
        (a) => a.approval_type === 'production_readiness_approval')) {
      reasons.push('production_ready requires an explicit ' +
                   'production_readiness_approval')
    }
  }
  return { ok: reasons.length === 0, reasons }
}

export function setBoardReadiness(db, { board_id, next, actor }) {
  const b = db.boards.find((x) => x.board_id === board_id)
  if (!b) return { error: 'no such board' }
  const guard = guardReadiness(db, b, next)
  if (!guard.ok) {
    appendAudit(db, { actor, action: 'readiness_promotion_REFUSED',
                      scope: { board_id }, before: { readiness: b.readiness },
                      after: { attempted: next }, note: guard.reasons.join('; ') })
    return { error: 'promotion refused', reasons: guard.reasons }
  }
  const before = b.readiness
  b.readiness = next
  appendAudit(db, { actor, action: 'set_readiness', scope: { board_id },
                    before: { readiness: before }, after: { readiness: next } })
  return b
}

// convenience lookups ---------------------------------------------------------
export function programSummary(db, program_id) {
  const p = db.programs.find((x) => x.program_id === program_id)
  if (!p) return null
  const boards = db.boards.filter((b) => b.program_id === program_id)
  const runs = db.runs.filter((r) => boards.some((b) => b.board_id === r.board_id))
  const evidence = db.evidence.filter(
    (e) => e.scope_id === program_id
      || boards.some((b) => b.board_id === e.scope_id)
      || runs.some((r) => r.run_id === e.scope_id))
  const approvals = db.approvals.filter(
    (a) => a.scope?.program_id === program_id
      || boards.some((b) => b.board_id === a.scope?.board_id))
  const usage = db.usage.filter((u) => u.program_id === program_id)
  return {
    program: p, boards, runs, evidence, approvals,
    usage_total_credits: usage.reduce((s, u) => s + (u.credits ?? 0), 0),
    blocked_claims: [...new Set([
      ...p.blocked_claims, ...boards.flatMap((b) => b.blocked_claims)])],
    review_required: boards.flatMap((b) => b.review_required_items),
  }
}
