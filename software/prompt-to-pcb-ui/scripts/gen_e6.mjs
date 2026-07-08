/** E6 artifact generator — ROI schema + example report. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e6-gen-'))
const ent = await import('../lib/enterprise/store.mjs')
const pil = await import('../lib/enterprise/pilots.mjs')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(HERE, '..', 'docs', 'enterprise')
fs.mkdirSync(DOCS, { recursive: true })

// build a synthetic example pilot (clearly fake) and its ROI report
const db = ent.resetDb()
const org = ent.createOrganization(db, {
  name: 'Acme Robotics Labs (SYNTHETIC DEMO)', actor: 'gen' })
const ws = ent.createWorkspace(db, { org_id: org.org_id,
  name: 'Hardware Programs', actor: 'gen' })
const p1 = ent.createProgram(db, { workspace_id: ws.workspace_id,
  name: 'Sensor Controller Pilot', actor: 'gen' })
const pilot = pil.createPilot(db, { org_id: org.org_id,
  workspace_id: ws.workspace_id, program_ids: [p1.program_id],
  customer_segment: 'robotics OEM (synthetic)',
  use_case: 'bench sensor controller boards',
  baseline_process: 'manual EDA + external layout contractor, 3 revisions '
    + 'typical', actor: 'gen' })
const roi = pil.roiReport(db, { pilot_id: pilot.pilot_id })

const schema = {
  version: 'roi-model/v1',
  pilot_fields: ['pilot_id', 'org/workspace/program', 'customer_segment',
                 'use_case', 'target boards', 'baseline_process',
                 'baseline cycle time', 'baseline engineering cost',
                 'baseline fab/revision assumptions',
                 'Compose outputs delivered', 'credits consumed',
                 'estimated time saved', 'estimated cost avoided',
                 'blocked claims', 'validation state', 'next step',
                 'expansion path'],
  assumptions: Object.fromEntries(Object.entries(pil.DEFAULT_ASSUMPTIONS)
    .map(([k, v]) => [k, { units: v.units, provenance: v.provenance }])),
  outputs: ['conservative/base/aggressive scenarios', 'assumption table',
            'sensitivity table (9 combinations)', 'caveats', 'not_counted',
            'physical_evidence_status', 'measured_vs_estimated statement'],
  rules: [
    'ROI never claims verified savings without customer evidence',
    'basis is ESTIMATED until measured items exist; then reconciliation '
    + 'is demanded, never automatic',
    'FL-1 capex amortization = capex / years / sharing programs — '
    + 'program/year aware, divided never multiplied, counted once as cost',
    'physical validation is a separate evidence track, not an ROI input',
    'all assumptions configurable with provenance notes',
  ],
}

const report = {
  version: 'v1', milestone: 'E6 Pilot ROI Dashboard',
  delivered: {
    engine: 'lib/enterprise/pilots.mjs',
    api: 'create_pilot / roi_report / add_measured_roi_evidence',
    example: 'roi-example-report.md (synthetic Acme pilot)',
    tests: 'scripts/test_e6.mjs — 11/11 incl. amortization halving check',
  },
  acceptance: {
    pilot_dashboard_exists: 'pilot entities + ROI report API; UI surfaces '
      + 'through the enterprise workspace',
    configurable_and_conservative: 'defaults marked placeholder; '
      + 'conservative scenario is 0.5x',
    amortization_not_double_counted: 'tested: 2 sharing programs halve '
      + 'the per-program amortization',
    estimated_vs_measured_separated: true,
    evidence_and_blocked_claims_shown: true,
  },
}

const exampleMd = `# ROI example report — SYNTHETIC demo pilot

*${roi.measured_vs_estimated}*

## Scenarios (boards/year = 4, 1 sharing program)
| scenario | hours saved/board | eng saved/board | fab avoided/board | FL-1 amortization/yr | net/yr |
|---|---|---|---|---|---|
${['conservative', 'base', 'aggressive'].map((s) => {
  const x = roi.scenarios[s]
  return `| ${s} | ${x.hours_saved_per_board} | $${x.engineering_saved_per_board_usd} | $${x.fab_avoided_per_board_usd} | -$${x.instrument_amortization_per_program_year_usd} | $${x.net_estimated_value_per_year_usd} |`
}).join('\n')}

${roi.amortization_note}

## Caveats
${roi.caveats.map((c) => '- ' + c).join('\n')}

## Not counted
${roi.not_counted.map((c) => '- ' + c).join('\n')}

Physical evidence status: ${roi.physical_evidence_status}
`

fs.writeFileSync(path.join(DOCS, 'roi-model-schema.json'),
                 JSON.stringify(schema, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-pilot-roi-dashboard-v1.json'),
                 JSON.stringify(report, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-pilot-roi-dashboard-v1.md'),
`# E6 — Sales-Led Pilot Workspace and ROI Dashboard v1

Pilot entities carry segment, use case, baseline process, and a fully
configurable assumption set (every value has units + provenance).
roiReport() produces conservative/base/aggressive scenarios, a 9-row
sensitivity table, caveats, a not-counted list, and the physical-evidence
status. Basis is ESTIMATED until customer-measured items exist — and even
then the report demands human reconciliation.

${schema.rules.map((r) => '- ' + r).join('\n')}
`)
fs.writeFileSync(path.join(DOCS, 'roi-example-report.md'), exampleMd)
console.log('E6 artifacts written; base net/yr =',
            roi.scenarios.base.net_estimated_value_per_year_usd)
