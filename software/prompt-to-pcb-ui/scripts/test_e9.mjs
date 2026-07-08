/** E9 regression: customer-facing report exports (isolated temp store). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e9-store-'))
const ent = await import('../lib/enterprise/store.mjs')
const pil = await import('../lib/enterprise/pilots.mjs')
const rep = await import('../lib/enterprise/reports.mjs')

const checks = []
function check(name, ok, detail = '') {
  checks.push(ok)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
}

const db = ent.resetDb()
const actor = 't'
const org = ent.createOrganization(db, {
  name: 'Acme Robotics Labs (SYNTHETIC DEMO)', actor })
const ws = ent.createWorkspace(db, { org_id: org.org_id, name: 'W', actor })
const prog = ent.createProgram(db, { workspace_id: ws.workspace_id,
  name: 'Sensor Controller Pilot', objective: 'bench controller family',
  actor })
const b1 = ent.createBoard(db, { program_id: prog.program_id,
  name: 'Power Entry', actor })
const b2 = ent.createBoard(db, { program_id: prog.program_id,
  name: 'BGA Study', actor })
ent.attachRun(db, { board_id: b1.board_id,
  run_dir: 'power-entry-header-v1', actor })
db.boards.find((x) => x.board_id === b2.board_id).blocked_claims.push(
  'BGA board emission (no escape emitter)')
const pilot = pil.createPilot(db, { org_id: org.org_id,
  workspace_id: ws.workspace_id, program_ids: [prog.program_id], actor })

check('1 seven report types', rep.REPORT_TYPES.length === 7)

// every type generates
const all = rep.REPORT_TYPES.map((t) => rep.buildCustomerReport(db, {
  report_type: t, program_id: prog.program_id, pilot_id: pilot.pilot_id }))
check('2 all seven types generate', all.every((r) => !r.error))

const ps = all.find((r) => r.report_type === 'program_status')
check('3 blocked claims cannot be omitted (present even when board-level '
      + 'list is empty)',
  ps.blocked_claims.length >= 1
  && all.every((r) => r.blocked_claims.length >= 1))
check('4 architecture_only never reads as built',
  ps.status.boards.find((x) => x.name === 'BGA Study')
    .state_plain_language.includes('no board has been generated'))
check('5 routed_in_sandbox never reads as validated',
  ps.status.boards.find((x) => x.name === 'Power Entry')
    .state_plain_language.includes('not physically validated'))
check('6 physical evidence state explicit',
  ps.evidence_produced.physical_evidence_state.includes(
    'NO physical evidence'))

const roi = all.find((r) => r.report_type === 'roi_summary')
check('7 ROI labeled ESTIMATED with caveats',
  roi.roi.basis === 'ESTIMATED' && roi.roi.caveats.length >= 3)

// markdown rendering
const md = rep.customerReportMarkdown(ps)
check('8 markdown carries blocked claims + evidence + plain-language states',
  md.includes('## Blocked claims') && md.includes('NO physical evidence')
  && md.includes('no board has been generated'))

// scrubbing: no local absolute paths
db.programs[0].risks.push(
  'debug note at /Users/someone/secret/place.txt should not leak')
const ps2 = rep.buildCustomerReport(db, { report_type: 'program_status',
  program_id: prog.program_id })
check('9 local absolute paths scrubbed from customer output',
  JSON.stringify(ps2).includes('[artifact path withheld]')
  && !JSON.stringify(ps2).includes('/Users/someone'))

// no secrets pattern
check('10 no obvious secret material in output',
  !/sk_live|api[_-]?key|password/i.test(JSON.stringify(all)))

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E9 checks pass`)
process.exit(n === checks.length ? 0 : 1)
