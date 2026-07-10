/** E6 regression: pilot workspace + ROI model (isolated temp store). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e6-store-'))
const ent = await import('../lib/enterprise/store.mjs')
const pil = await import('../lib/enterprise/pilots.mjs')

const checks = []
function check(name, ok, detail = '') {
  checks.push(ok)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
}

const db = ent.resetDb()
const actor = 't'
const org = ent.createOrganization(db, { name: 'T', actor })
const ws = ent.createWorkspace(db, { org_id: org.org_id, name: 'W', actor })
const p1 = ent.createProgram(db, { workspace_id: ws.workspace_id,
  name: 'P1', actor })

// assumptions are config with provenance
check('1 every default assumption carries value+units+provenance',
  Object.values(pil.DEFAULT_ASSUMPTIONS).every(
    (a) => a.value !== undefined && a.units && a.provenance))

const pilot = pil.createPilot(db, { org_id: org.org_id,
  workspace_id: ws.workspace_id, program_ids: [p1.program_id],
  customer_segment: 'robotics', use_case: 'sensor controller',
  assumptions: { loaded_ee_cost_per_hour: { value: 180 } }, actor })
check('2 pilot created; assumption override marked',
  pilot.assumptions.loaded_ee_cost_per_hour.value === 180
  && pilot.assumptions.loaded_ee_cost_per_hour.overridden === true)

const roi = pil.roiReport(db, { pilot_id: pilot.pilot_id })
check('3 basis is ESTIMATED; measured/estimated explicitly separated',
  roi.basis === 'ESTIMATED'
  && roi.measured_vs_estimated.includes('ESTIMATES'))
check('4 conservative <= base <= aggressive',
  roi.scenarios.conservative.net_estimated_value_per_year_usd
    <= roi.scenarios.base.net_estimated_value_per_year_usd
  && roi.scenarios.base.net_estimated_value_per_year_usd
    <= roi.scenarios.aggressive.net_estimated_value_per_year_usd)
check('5 sensitivity table (9 rows) + caveats + not-counted list',
  roi.sensitivity_table.length === 9 && roi.caveats.length >= 3
  && roi.not_counted.length >= 3)
check('6 physical evidence status shown (ledger empty)',
  roi.physical_evidence_status.includes('ledger empty'))

// amortization: program/year aware, divided not multiplied
const roi1 = pil.roiReport(db, { pilot_id: pilot.pilot_id,
  sharing_program_count: 1 })
const roi2 = pil.roiReport(db, { pilot_id: pilot.pilot_id,
  sharing_program_count: 2 })
const a1 = roi1.scenarios.base.instrument_amortization_per_program_year_usd
const a2 = roi2.scenarios.base.instrument_amortization_per_program_year_usd
check('7 amortization halves when 2 programs share the FL-1 (never doubles)',
  a2 === Math.round(a1 / 2))
check('8 amortization = capex/years/sharing (counted once, as a cost)',
  a1 === Math.round(25000 / 3 / 1)
  && roi1.amortization_note.includes('never multiplied'))

// measured evidence path is gated
const bad = pil.addMeasuredEvidence(db, { pilot_id: pilot.pilot_id,
  description: 'claimed savings', source: '', artifact_path: '', actor })
check('9 measured evidence without source/artifact refused',
  bad.error !== undefined)
pil.addMeasuredEvidence(db, { pilot_id: pilot.pilot_id,
  description: 'customer cycle-time log', source: 'customer',
  artifact_path: 'uploads/cycle-log.csv', actor })
const roi3 = pil.roiReport(db, { pilot_id: pilot.pilot_id })
check('10 with measured items, report demands reconciliation (still not '
      + 'auto-verified)',
  roi3.measured_vs_estimated.includes('reconcile'))
ent.saveDb(db)
check('11 pilot creation + evidence audited, chain intact',
  ent.verifyAuditChain(ent.loadDb()).ok
  && db.audit.some((e) => e.action === 'create_pilot'))

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E6 checks pass`)
process.exit(n === checks.length ? 0 : 1)
