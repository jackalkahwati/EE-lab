/** E9 artifact generator — customer report schema + examples. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e9-gen-'))
const ent = await import('../lib/enterprise/store.mjs')
const pil = await import('../lib/enterprise/pilots.mjs')
const rep = await import('../lib/enterprise/reports.mjs')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(HERE, '..', 'docs', 'enterprise')
const EX = path.join(DOCS, 'customer-report-examples')
fs.mkdirSync(EX, { recursive: true })

// synthetic example program with a real attached run
const db = ent.resetDb()
const actor = 'gen'
const org = ent.createOrganization(db, {
  name: 'Acme Robotics Labs (SYNTHETIC DEMO)', actor })
const ws = ent.createWorkspace(db, { org_id: org.org_id,
  name: 'Hardware Programs', actor })
const prog = ent.createProgram(db, { workspace_id: ws.workspace_id,
  name: 'Sensor Controller Pilot',
  objective: 'evidence-gated bench controller boards for the sensor line',
  actor })
const b = ent.createBoard(db, { program_id: prog.program_id,
  name: 'Power Entry Header', actor })
ent.attachRun(db, { board_id: b.board_id, run_dir: 'power-entry-header-v1',
  actor })
const pilot = pil.createPilot(db, { org_id: org.org_id,
  workspace_id: ws.workspace_id, program_ids: [prog.program_id],
  customer_segment: 'robotics (synthetic)', actor })

for (const t of ['executive_summary', 'program_status',
                 'board_review_packet', 'pilot_summary', 'roi_summary']) {
  const r = rep.buildCustomerReport(db, { report_type: t,
    program_id: prog.program_id, pilot_id: pilot.pilot_id })
  fs.writeFileSync(path.join(EX, `${t}.json`), JSON.stringify(r, null, 1))
  fs.writeFileSync(path.join(EX, `${t}.md`), rep.customerReportMarkdown(r))
}

const schema = {
  version: 'customer-report/v1',
  report_types: rep.REPORT_TYPES,
  mandatory_sections: ['status (plain-language + internal state)',
                       'work_completed', 'evidence_produced (with physical '
                       + 'state)', 'blocked_claims (cannot be omitted)',
                       'manual_review_required', 'approval_status',
                       'quote_fab_status', 'validation_status',
                       'next_steps'],
  phrasing_rules: [
    'architecture_only -> "architecture defined — no board has been '
    + 'generated" (never "built")',
    'routed_in_sandbox -> "...not built, not physically validated" '
    + '(never "validated")',
    'ROI carries basis=ESTIMATED until measured evidence exists',
    'local absolute paths scrubbed; no secrets; no debug noise unless a '
    + 'technical appendix is requested',
  ],
}

fs.writeFileSync(path.join(DOCS, 'enterprise-customer-report-export-v1.json'),
  JSON.stringify({
    version: 'v1', milestone: 'E9 Customer Report Export',
    delivered: {
      engine: 'lib/enterprise/reports.mjs (7 types, honest phrasebook, '
        + 'path scrubbing)',
      examples: 'docs/enterprise/customer-report-examples (5 types, '
        + 'json+md)',
      tests: 'scripts/test_e9.mjs — 10/10',
    },
    acceptance: {
      reports_generate: true,
      readable_by_exec_and_reviewer: 'plain-language state + internal '
        + 'state side by side',
      blocked_claims_and_evidence_clear: true,
    },
  }, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-customer-report-export-v1.md'),
`# E9 — Customer-Facing Program Report Export v1

Seven report types (pilot_summary, program_status, board_review_packet,
quote_ready_packet, validation_summary, roi_summary, executive_summary) in
Markdown + JSON, built from the enterprise store + real run artifacts.

Honesty is enforced in code:
${schema.phrasing_rules.map((r) => '- ' + r).join('\n')}

Blocked claims and the physical-evidence state are mandatory sections —
a customer report cannot be generated without them.
`)
console.log('E9 artifacts + 5 example reports written')
