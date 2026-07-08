/**
 * E8 — FL-1 bundle + validation session workflow.
 *
 * Represents FL-1 hardware + Compose software as an enterprise bundle.
 * A validation session NEVER implies pass: sessions end in
 * completed_pending_review; uploaded evidence must be REVIEWED before any
 * claim moves; an FL-1 asset on the books is not physical validation;
 * calibration claims require calibration evidence. No fake measurements —
 * evidence rides the store's physical-file requirement.
 */
import { newId, appendAudit, addEvidence } from './store.mjs'

export const SESSION_STATES = [
  'planned', 'ready', 'running', 'blocked', 'completed_pending_review',
  'accepted', 'rejected', 'archived',
]

const SESSION_TRANSITIONS = {
  planned: ['ready', 'blocked', 'archived'],
  ready: ['running', 'blocked', 'archived'],
  running: ['completed_pending_review', 'blocked'],
  blocked: ['planned', 'archived'],
  completed_pending_review: ['accepted', 'rejected'],
  accepted: ['archived'],
  rejected: ['planned', 'archived'],
  archived: [],
}

export const SESSION_EVIDENCE_TYPES = [
  'visual_inspection', 'continuity_results', 'physical_measurement',
  'i2c_scan', 'oscilloscope_capture', 'thermal_image', 'operator_notes',
]

export function registerFl1Asset(db, { org_id, serial_placeholder = 'FL1-XXXX',
                                       location_placeholder = 'customer lab',
                                       software_term_months = 12, actor }) {
  const asset = {
    asset_id: newId('fl1'), org_id,
    serial_placeholder, status: 'registered',
    location_placeholder,
    software_term: { months: software_term_months,
                     started_at: new Date().toISOString() },
    service_notes: [],
    calibration_state: 'uncalibrated_placeholder — calibration claims '
      + 'require calibration evidence',
  }
  db.fl1_assets.push(asset)
  appendAudit(db, { actor, action: 'register_fl1_asset',
                    scope: { org_id, asset_id: asset.asset_id },
                    after: { serial: serial_placeholder } })
  return asset
}

export function planValidationSession(db, { asset_id, board_id, run_id = null,
                                            operator, validation_plan = null,
                                            actor }) {
  const asset = db.fl1_assets.find((a) => a.asset_id === asset_id)
  if (!asset) return { error: 'no such FL-1 asset' }
  const board = db.boards.find((b) => b.board_id === board_id)
  if (!board) return { error: 'no such board' }
  if (!operator) return { error: 'session requires an assigned operator' }
  const run = db.runs.find((r) => r.run_id === (run_id ?? board.latest_run_id))
  const plan = validation_plan
    ?? (run?.validation_artifacts?.length
      ? `public/runs/${run.source_run_dir}/data/fl1-testplan.json`
      : null)
  const s = {
    session_id: newId('vses'), asset_id, board_id,
    run_id: run?.run_id ?? null,
    validation_plan: plan,
    operator,
    start_time: null, end_time: null,
    status: plan ? 'planned' : 'blocked',
    blocked_reason: plan ? null
      : 'no validation plan — generate fl1-testplan.json first',
    evidence_ids: [], measurements: [], failures: [],
    claims_affected: ['physically_validated (board readiness)',
                      'validation_state (board)'],
    review_state: 'not_reviewed',
  }
  db.validation_sessions.push(s)
  appendAudit(db, { actor, action: 'plan_validation_session',
                    scope: { asset_id, board_id,
                             session_id: s.session_id },
                    after: { status: s.status, operator } })
  return s
}

export function advanceSession(db, { session_id, to, note = '', actor }) {
  const s = db.validation_sessions.find((x) => x.session_id === session_id)
  if (!s) return { error: 'no such session' }
  if (!SESSION_STATES.includes(to)) return { error: `unknown state ${to}` }
  if (!(SESSION_TRANSITIONS[s.status] ?? []).includes(to)) {
    return { error: `illegal transition ${s.status} -> ${to}` }
  }
  // acceptance is a REVIEW decision and requires reviewed evidence
  if (to === 'accepted') {
    const accepted = db.evidence.filter(
      (e) => s.evidence_ids.includes(e.evidence_id)
        && e.status === 'accepted')
    if (accepted.length === 0) {
      appendAudit(db, { actor, action: 'session_accept_REFUSED',
                        scope: { session_id },
                        note: 'no ACCEPTED (reviewed) evidence items' })
      return { error: 'session acceptance requires at least one REVIEWED '
                      + '(accepted) evidence item — a completed session '
                      + 'never implies pass' }
    }
    s.review_state = 'reviewed_accepted'
  }
  if (to === 'rejected') s.review_state = 'reviewed_rejected'
  if (to === 'running') s.start_time = new Date().toISOString()
  if (to === 'completed_pending_review') s.end_time = new Date().toISOString()
  const before = s.status
  s.status = to
  appendAudit(db, { actor, action: 'advance_validation_session',
                    scope: { session_id },
                    before: { status: before }, after: { status: to },
                    note })
  return s
}

/** attach session evidence — rides addEvidence, so PHYSICAL types require
 *  a real file and land as uploaded_pending_review */
export function attachSessionEvidence(db, { session_id, evidence_type,
                                            artifact_path, source, notes = '',
                                            measurements = [], actor }) {
  const s = db.validation_sessions.find((x) => x.session_id === session_id)
  if (!s) return { error: 'no such session' }
  if (!SESSION_EVIDENCE_TYPES.includes(evidence_type)) {
    return { error: `evidence_type ${evidence_type} not valid for sessions` }
  }
  const ev = addEvidence(db, {
    scope_type: 'board_id', scope_id: s.board_id, evidence_type,
    source: source ?? `FL-1 session ${session_id}`,
    artifact_path, notes, actor })
  if (ev.error) return ev
  s.evidence_ids.push(ev.evidence_id)
  for (const m of measurements) {
    if (m.value === undefined || !m.units || !m.name) {
      return { error: 'measurements require name+value+units — no unlabeled '
                      + 'numbers' }
    }
    s.measurements.push({ ...m, evidence_id: ev.evidence_id })
  }
  return { session: s, evidence: ev }
}

export function claimImpactReport(db, { session_id }) {
  const s = db.validation_sessions.find((x) => x.session_id === session_id)
  if (!s) return { error: 'no such session' }
  const evs = db.evidence.filter((e) => s.evidence_ids.includes(e.evidence_id))
  return {
    session_id, status: s.status, review_state: s.review_state,
    evidence: evs.map((e) => ({ id: e.evidence_id, type: e.evidence_type,
                                status: e.status })),
    claims_affected: s.claims_affected,
    claims_promotable_now: s.status === 'accepted'
      ? ['physically_validated may now be requested via setBoardReadiness '
         + '(guard re-verifies accepted evidence)']
      : [],
    claims_blocked: [
      ...(s.status !== 'accepted'
        ? ['physically_validated — session not accepted'] : []),
      'calibration claims — no calibration evidence',
      'production_ready — yield/manufacturing evidence absent'],
    rules: ['session completion never implies pass',
            'evidence must be reviewed before claims move',
            'FL-1 asset presence is not physical validation'],
  }
}

export function bundleStatusReport(db) {
  return {
    generated_at: new Date().toISOString(),
    assets: db.fl1_assets.map((a) => ({
      asset_id: a.asset_id, serial: a.serial_placeholder, status: a.status,
      software_term: a.software_term,
      calibration_state: a.calibration_state })),
    sessions: db.validation_sessions.map((s) => ({
      session_id: s.session_id, board_id: s.board_id, status: s.status,
      operator: s.operator, evidence_count: s.evidence_ids.length,
      review_state: s.review_state })),
    honesty: 'an FL-1 on the books validates nothing; sessions validate '
      + 'nothing until reviewed evidence exists',
  }
}

// dispatcher handlers ---------------------------------------------------------
export function handlers(db, actor) {
  return {
    register_fl1_asset: (p) => registerFl1Asset(db, { ...p, actor }),
    plan_validation_session: (p) => planValidationSession(db, { ...p, actor }),
    advance_session: (p) => advanceSession(db, { ...p, actor }),
    attach_session_evidence: (p) => attachSessionEvidence(db, { ...p, actor }),
    claim_impact_report: (p) => claimImpactReport(db, p),
    fl1_bundle_status: () => bundleStatusReport(db),
  }
}
