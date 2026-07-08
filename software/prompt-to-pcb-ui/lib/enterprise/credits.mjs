/**
 * E4 — Board-program credits and usage ledger.
 *
 * INTERNAL usage/credit accounting for sales-led enterprise pricing.
 * This is NOT billing: no money moves, no payment system is touched, no
 * external integration exists. Pricing lives in CONFIG (data-driven, never
 * hard-coded into engineering gates). Every entry and every manual
 * adjustment is audited; the ledger is append-only.
 */
import { newId, appendAudit } from './store.mjs'

export const USAGE_CATEGORIES = [
  'architecture_run', 'board_synthesis_run', 'placement_run', 'routing_run',
  'drc_erc_gate_run', 'external_eda_analysis_run', 'firmware_bsp_build',
  'manufacturing_package_generation', 'evidence_pack_generation',
  'validation_plan_generation', 'quote_packet_generation',
  'physical_evidence_ingestion', 'fl1_validation_session',
  'program_report_export', 'support_review_event',
]

// default credit costs per category — CONFIG, overridable per org
export const DEFAULT_CREDIT_COSTS = {
  architecture_run: 1, board_synthesis_run: 5, placement_run: 2,
  routing_run: 3, drc_erc_gate_run: 1, external_eda_analysis_run: 2,
  firmware_bsp_build: 1, manufacturing_package_generation: 3,
  evidence_pack_generation: 1, validation_plan_generation: 2,
  quote_packet_generation: 2, physical_evidence_ingestion: 1,
  fl1_validation_session: 10, program_report_export: 1,
  support_review_event: 0,
}

// internal modeling tiers — CONFIG for sales, not homepage truth
export const TIERS = {
  pilot: { annual_platform_credits: 200, board_program_credits: 2,
           note: 'pilot pricing is sales-configured' },
  team: { annual_platform_credits: 1000, board_program_credits: 10 },
  enterprise: { annual_platform_credits: 5000, board_program_credits: 50 },
  enterprise_fl1_bundle: {
    annual_platform_credits: 5000, board_program_credits: 50,
    fl1_assets_included: 1,
    note: 'FL-1 hardware term tracked in E8; fab-attach is placeholder '
      + 'metadata only' },
}

export function recordUsage(db, { org_id, program_id = null, board_id = null,
                                  run_id = null, usage_type, credits = null,
                                  user = 'system', notes = '',
                                  estimated_dollar_value = null, actor }) {
  if (!USAGE_CATEGORIES.includes(usage_type)) {
    return { error: `unknown usage_type ${usage_type}` }
  }
  const cost = credits ?? DEFAULT_CREDIT_COSTS[usage_type] ?? 0
  const entry = {
    usage_id: newId('use'), org_id, program_id, board_id, run_id,
    usage_type, credits: cost,
    estimated_dollar_value,
    timestamp: new Date().toISOString(), user, notes,
  }
  db.usage.push(entry)
  const p = db.programs.find((x) => x.program_id === program_id)
  if (p) {
    p.budget.credits_consumed += cost
    p.updated_at = entry.timestamp
  }
  appendAudit(db, { actor, action: 'record_usage',
                    scope: { org_id, program_id, board_id },
                    after: { usage_type, credits: cost } })
  return entry
}

/** manual credit adjustment — always audited, reason required */
export function adjustCredits(db, { org_id, program_id = null, delta,
                                    reason, actor }) {
  if (!reason) return { error: 'manual adjustment requires a reason' }
  const org = db.organizations.find((o) => o.org_id === org_id)
  if (!org) return { error: 'no such org' }
  if (program_id) {
    const p = db.programs.find((x) => x.program_id === program_id)
    if (!p) return { error: 'no such program' }
    p.budget.credits_allocated += delta
  } else {
    org.credit_allocation += delta
  }
  appendAudit(db, { actor, action: 'adjust_credits',
                    scope: { org_id, program_id },
                    after: { delta }, note: reason })
  return { ok: true, delta }
}

export function budgetState(db, program_id) {
  const p = db.programs.find((x) => x.program_id === program_id)
  if (!p) return { error: 'no such program' }
  const remaining = p.budget.credits_allocated - p.budget.credits_consumed
  return {
    program_id,
    allocated: p.budget.credits_allocated,
    consumed: p.budget.credits_consumed,
    remaining,
    state: remaining < 0 ? 'overage_review_required'
      : remaining <= p.budget.credits_allocated * 0.1 ? 'budget_warning'
        : 'ok',
    note: 'overage blocks NOTHING technical; it flags a commercial review — '
      + 'engineering gates are never priced',
  }
}

export function usageReport(db, { org_id = null } = {}) {
  const rows = db.usage.filter((u) => !org_id || u.org_id === org_id)
  const by = (key) => {
    const m = {}
    for (const r of rows) {
      const k = r[key] ?? 'unassigned'
      m[k] = (m[k] ?? 0) + r.credits
    }
    return m
  }
  return {
    generated_at: new Date().toISOString(),
    total_entries: rows.length,
    total_credits: rows.reduce((s, r) => s + r.credits, 0),
    by_program: by('program_id'),
    by_board: by('board_id'),
    by_user: by('user'),
    by_stage: by('usage_type'),
    auditability: 'every entry is in db.usage; every mutation and manual '
      + 'adjustment has a hash-chained audit record',
    no_billing: 'no money moved; no payment integration exists',
  }
}

/** pricing alignment: the homepage/billing surfaces are out of scope this
 *  sprint — report any hard-coded price strings so sales/marketing can
 *  reconcile instead of silently conflicting. */
export function pricingAlignmentReport(candidateStrings) {
  return {
    generated_at: new Date().toISOString(),
    scope: 'enterprise tier config vs existing app surfaces',
    enterprise_tiers: Object.keys(TIERS),
    homepage_out_of_scope: true,
    findings: candidateStrings,
    rule: 'tier config in lib/enterprise/credits.mjs is INTERNAL modeling; '
      + 'public pricing must be reconciled by a human before publication',
  }
}

// dispatcher handlers ---------------------------------------------------------
export function handlers(db, actor) {
  return {
    record_usage: (p) => recordUsage(db, { ...p, actor }),
    adjust_credits: (p) => adjustCredits(db, { ...p, actor }),
    budget_state: (p) => budgetState(db, p.program_id),
    usage_report: (p) => usageReport(db, p ?? {}),
  }
}
