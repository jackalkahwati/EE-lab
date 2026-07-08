/**
 * E6 — Sales-led pilot workspace + ROI model.
 *
 * ROI is ESTIMATED unless the customer supplies measured evidence — the
 * two never mix. Every assumption is configurable with a provenance note;
 * conservative / base / aggressive scenarios plus a sensitivity table are
 * mandatory. Instrument (FL-1) capex is amortized PER PROGRAM-YEAR across
 * the programs actually sharing the asset — it is structurally impossible
 * to charge the same capex twice, and equally impossible to double-COUNT
 * savings from it (amortization is a cost, subtracted once).
 */
import { newId, appendAudit } from './store.mjs'

// default assumptions — CONFIG with provenance, editable per pilot
export const DEFAULT_ASSUMPTIONS = {
  loaded_ee_cost_per_hour: {
    value: 150, units: 'USD/h',
    provenance: 'placeholder — set from customer loaded-cost data' },
  baseline_cycle_time_weeks: {
    value: 6, units: 'weeks/revision',
    provenance: 'placeholder — set from customer baseline interviews' },
  baseline_engineering_hours: {
    value: 120, units: 'h/board revision',
    provenance: 'placeholder — set from customer baseline' },
  baseline_revisions_per_board: {
    value: 3, units: 'revisions',
    provenance: 'industry-typical placeholder — customer to confirm' },
  compose_review_hours: {
    value: 24, units: 'h/board (human review of generated package)',
    provenance: 'internal estimate — review remains mandatory' },
  fab_cost_per_revision: {
    value: 1500, units: 'USD (fab+assembly, small batch)',
    provenance: 'placeholder — quote-dependent' },
  revisions_avoided: {
    value: 1, units: 'revisions',
    provenance: 'CONSERVATIVE default: evidence-gated packages may avoid '
      + 'one respin; NOT customer-verified' },
  fl1_instrument_capex: {
    value: 25000, units: 'USD',
    provenance: 'placeholder FL-1 bundle price — sales-configured' },
  fl1_amortization_years: {
    value: 3, units: 'years',
    provenance: 'placeholder depreciation schedule' },
}

export function createPilot(db, { org_id, workspace_id, program_ids = [],
                                  customer_segment = '', use_case = '',
                                  baseline_process = '', assumptions = {},
                                  actor }) {
  const merged = structuredClone(DEFAULT_ASSUMPTIONS)
  for (const [k, v] of Object.entries(assumptions)) {
    if (merged[k]) merged[k] = { ...merged[k], ...v, overridden: true }
  }
  const pilot = {
    pilot_id: newId('pil'), org_id, workspace_id, program_ids,
    customer_segment, use_case, baseline_process,
    assumptions: merged,
    measured_evidence: [],   // stays empty until the CUSTOMER provides data
    created_at: new Date().toISOString(),
  }
  db.pilots.push(pilot)
  appendAudit(db, { actor, action: 'create_pilot',
                    scope: { org_id, pilot_id: pilot.pilot_id },
                    after: { use_case } })
  return pilot
}

function num(a, k) { return a[k].value }

/**
 * ROI for one pilot. sharing_program_count = programs sharing the FL-1
 * asset THIS year (amortization divides by it — never multiplied).
 */
export function roiReport(db, { pilot_id, boards_per_year = 4,
                                sharing_program_count = null }) {
  const pilot = db.pilots.find((p) => p.pilot_id === pilot_id)
  if (!pilot) return { error: 'no such pilot' }
  const a = pilot.assumptions
  const sharing = sharing_program_count
    ?? Math.max(1, pilot.program_ids.length)

  const scenario = (mult) => {
    const hoursSaved = Math.max(0,
      (num(a, 'baseline_engineering_hours')
        - num(a, 'compose_review_hours')) * mult)
    const engSaved = hoursSaved * num(a, 'loaded_ee_cost_per_hour')
    const fabAvoided = num(a, 'revisions_avoided') * mult
      * num(a, 'fab_cost_per_revision')
    // instrument amortization: capex / years / sharing programs — a COST,
    // subtracted once; program/year aware
    const amortization = num(a, 'fl1_instrument_capex')
      / num(a, 'fl1_amortization_years') / sharing
    const perBoard = engSaved + fabAvoided
    const perYear = perBoard * boards_per_year - amortization
    return {
      multiplier: mult,
      hours_saved_per_board: Math.round(hoursSaved),
      engineering_saved_per_board_usd: Math.round(engSaved),
      fab_avoided_per_board_usd: Math.round(fabAvoided),
      instrument_amortization_per_program_year_usd: Math.round(amortization),
      net_estimated_value_per_year_usd: Math.round(perYear),
    }
  }

  const sensitivity = []
  for (const ee of [100, 150, 250]) {
    for (const rev of [0, 1, 2]) {
      const hs = Math.max(0, num(a, 'baseline_engineering_hours')
        - num(a, 'compose_review_hours'))
      sensitivity.push({
        loaded_ee_cost: ee, revisions_avoided: rev,
        net_per_year_usd: Math.round(
          (hs * ee + rev * num(a, 'fab_cost_per_revision'))
          * boards_per_year
          - num(a, 'fl1_instrument_capex')
            / num(a, 'fl1_amortization_years') / sharing),
      })
    }
  }

  return {
    pilot_id, generated_at: new Date().toISOString(),
    basis: 'ESTIMATED', // never 'measured' without customer evidence
    measured_evidence_items: pilot.measured_evidence.length,
    measured_vs_estimated: pilot.measured_evidence.length === 0
      ? 'ALL figures below are ESTIMATES from configurable assumptions; '
        + 'no customer-verified savings exist'
      : 'measured items present — reconcile before publishing',
    assumptions: pilot.assumptions,
    amortization_note: `FL-1 capex ${num(a, 'fl1_instrument_capex')} USD / `
      + `${num(a, 'fl1_amortization_years')}y / ${sharing} sharing `
      + 'program(s) — divided, never multiplied; counted once as a cost',
    scenarios: {
      conservative: scenario(0.5),
      base: scenario(1.0),
      aggressive: scenario(1.5),
    },
    sensitivity_table: sensitivity,
    caveats: [
      'estimates only — no verified savings without customer evidence',
      'physical validation is a separate evidence track, not an ROI input',
      'review hours remain mandatory (packages are review-required)',
      'fab/assembly costs are quote-dependent',
    ],
    not_counted: [
      'firmware development beyond scaffold', 'compliance/qualification',
      'production ramp', 'opportunity cost of engineer availability'],
    physical_evidence_status: 'ledger empty — no physical claims',
  }
}

export function addMeasuredEvidence(db, { pilot_id, description, source,
                                          artifact_path, actor }) {
  const pilot = db.pilots.find((p) => p.pilot_id === pilot_id)
  if (!pilot) return { error: 'no such pilot' }
  if (!source || !artifact_path) {
    return { error: 'measured evidence requires a source and artifact' }
  }
  pilot.measured_evidence.push({ description, source, artifact_path,
                                 at: new Date().toISOString() })
  appendAudit(db, { actor, action: 'add_measured_roi_evidence',
                    scope: { pilot_id }, after: { description, source } })
  return pilot
}

// dispatcher handlers ---------------------------------------------------------
export function handlers(db, actor) {
  return {
    create_pilot: (p) => createPilot(db, { ...p, actor }),
    roi_report: (p) => roiReport(db, p),
    add_measured_roi_evidence: (p) => addMeasuredEvidence(db, { ...p, actor }),
  }
}
