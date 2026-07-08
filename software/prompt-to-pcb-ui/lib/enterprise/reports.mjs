/**
 * E9 — Customer-facing program report exports.
 *
 * Seven report types in enterprise-professional tone. Hard rules enforced
 * IN CODE, not by convention: blocked claims cannot be omitted; readiness
 * words are translated through an honest phrasebook so architecture_only
 * can never read as "built" and routed_in_sandbox can never read as
 * "validated"; ROI is labeled estimated vs measured; the physical
 * evidence state is always present. No internal debug noise, no secrets,
 * no local absolute paths.
 */
import { programSummary } from './store.mjs'
import { roiReport } from './pilots.mjs'

export const REPORT_TYPES = [
  'pilot_summary', 'program_status', 'board_review_packet',
  'quote_ready_packet', 'validation_summary', 'roi_summary',
  'executive_summary',
]

// the honest phrasebook — customer wording for internal states
const READINESS_PHRASE = {
  architecture_only: 'architecture defined — no board has been generated',
  blocked: 'blocked — see blocked claims',
  routed_in_sandbox: 'design routed and DRC-checked in software — not '
    + 'built, not physically validated',
  package_ready_with_review: 'manufacturing package generated — human '
    + 'review required before any quote',
  approved_for_quote: 'approved for quoting by your designated approver — '
    + 'quote submission is a manual step',
  physical_evidence_pending: 'boards in hand — physical evidence not yet '
    + 'reviewed',
  physically_validated: 'physically validated against reviewed bench '
    + 'evidence',
  production_ready: 'production ready (requires yield and manufacturing '
    + 'evidence — structurally unreachable without it)',
}

function scrub(text) {
  // no local absolute paths in customer output
  return String(text).replaceAll(/\/(Users|Volumes|home|private)\/[^\s'")]+/g,
                                 '[artifact path withheld]')
}

export function buildCustomerReport(db, { report_type, program_id,
                                          pilot_id = null,
                                          technical_appendix = false }) {
  if (!REPORT_TYPES.includes(report_type)) {
    return { error: `unknown report_type ${report_type}` }
  }
  const sum = programSummary(db, program_id)
  if (!sum) return { error: 'no such program' }
  const p = sum.program
  const org = db.organizations.find(
    (o) => db.workspaces.find((w) => w.workspace_id === p.workspace_id)
      ?.org_id === o.org_id)
  const quotes = db.quotes.filter(
    (q) => sum.boards.some((b) => b.board_id === q.board_id))
  const sessions = db.validation_sessions.filter(
    (s) => sum.boards.some((b) => b.board_id === s.board_id))
  const acceptedPhysical = sum.evidence.filter(
    (e) => e.status === 'accepted')
  const roi = pilot_id ? roiReport(db, { pilot_id }) : null

  const report = {
    schema: 'customer-report/v1',
    report_type,
    customer: org?.name ?? 'customer',
    program: p.name,
    objective: p.objective,
    generated_at: new Date().toISOString(),
    status: {
      program_status: p.status,
      boards: sum.boards.map((b) => ({
        name: b.name,
        state_plain_language: READINESS_PHRASE[b.readiness] ?? b.readiness,
        internal_state: b.readiness,
      })),
    },
    work_completed: sum.runs.map((r) => ({
      board: sum.boards.find((b) => b.board_id === r.board_id)?.name,
      routing: r.route_evidence_state, drc: r.drc_state, erc: r.erc_state,
    })),
    evidence_produced: {
      items: sum.evidence.length,
      accepted_after_review: acceptedPhysical.length,
      physical_evidence_state: acceptedPhysical.length > 0
        ? 'reviewed physical evidence exists'
        : 'NO physical evidence — nothing has been physically validated',
    },
    blocked_claims: sum.blocked_claims.length
      ? sum.blocked_claims
      : ['physical validation (no evidence)',
         'production readiness (no yield/manufacturing evidence)'],
    manual_review_required: sum.review_required.length
      ? sum.review_required
      : ['manufacturing package human review (standing requirement)'],
    risks: p.risks,
    approval_status: sum.approvals.map((a) => ({
      type: a.approval_type, status: a.status })),
    quote_fab_status: quotes.map((q) => ({ board_id: q.board_id,
      state: q.state })),
    validation_status: sessions.length
      ? sessions.map((s) => ({ session: s.session_id, status: s.status,
                               review_state: s.review_state }))
      : 'no validation sessions',
    roi: roi && !roi.error ? {
      basis: roi.basis,
      estimated_vs_measured: roi.measured_vs_estimated,
      scenarios: roi.scenarios,
      caveats: roi.caveats,
    } : (report_type === 'roi_summary' || report_type === 'pilot_summary'
      ? 'no pilot ROI configured' : undefined),
    next_steps: [
      ...(quotes.some((q) => q.state === 'quote_packet_ready')
        ? ['decide quote approval (human)'] : []),
      ...(acceptedPhysical.length === 0
        ? ['plan FL-1 validation session to produce physical evidence'] : []),
      'review blocked claims with your engineering reviewer'],
    tone_rules_applied: ['no unsupported claims', 'no internal debug noise'
      + (technical_appendix ? ' (technical appendix attached)' : ''),
      'blocked claims included', 'estimated vs measured ROI separated',
      'physical evidence state included'],
  }
  return JSON.parse(scrub(JSON.stringify(report)))
}

export function customerReportMarkdown(rep) {
  return `# ${rep.report_type.replace(/_/g, ' ')} — ${rep.program}

*Prepared for ${rep.customer} · ${rep.generated_at}*

## Objective
${rep.objective || 'n/a'}

## Status
Program: **${rep.status.program_status}**
${rep.status.boards.map(
  (b) => `- ${b.name}: ${b.state_plain_language}`).join('\n')}

## Work completed
${rep.work_completed.map(
  (w) => `- ${w.board}: routing ${w.routing}, DRC ${w.drc}, ERC ${w.erc}`)
  .join('\n') || '- none yet'}

## Evidence
${rep.evidence_produced.items} evidence item(s); `
  + `${rep.evidence_produced.accepted_after_review} accepted after review.
**${rep.evidence_produced.physical_evidence_state}**

## Blocked claims
${rep.blocked_claims.map((c) => `- ${c}`).join('\n')}

## Manual review required
${rep.manual_review_required.map((c) => `- ${c}`).join('\n')}

## Approvals
${rep.approval_status.map((a) => `- ${a.type}: ${a.status}`).join('\n')
  || '- none requested'}

## Quote / fab status
${(rep.quote_fab_status ?? []).map((q) => `- ${q.state}`).join('\n')
  || '- no quote workflow started'}

## Validation
${typeof rep.validation_status === 'string' ? rep.validation_status
  : rep.validation_status.map(
      (s) => `- ${s.session}: ${s.status} (${s.review_state})`).join('\n')}

${rep.roi && typeof rep.roi === 'object' ? `## ROI (${rep.roi.basis})
${rep.roi.estimated_vs_measured}

| scenario | net estimated value / year |
|---|---|
${Object.entries(rep.roi.scenarios).map(
  ([k, v]) => `| ${k} | $${v.net_estimated_value_per_year_usd} |`).join('\n')}
` : ''}
## Next steps
${rep.next_steps.map((s) => `- ${s}`).join('\n')}
`
}
