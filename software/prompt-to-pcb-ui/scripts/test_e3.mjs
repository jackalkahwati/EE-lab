/** E3 regression: evidence packs. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e3-store-'))
const ent = await import('../lib/enterprise/store.mjs')
const apr = await import('../lib/enterprise/approvals.mjs')
const ep = await import('../lib/enterprise/evidencepack.mjs')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EX = path.join(HERE, '..', 'docs', 'enterprise',
                     'evidence-pack-examples')

const checks = []
function check(name, ok, detail = '') {
  checks.push(ok)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
}

// benchmark examples exist (5 x json+md)
const files = fs.readdirSync(EX)
check('1 five benchmark packs exported (json + md)',
  files.filter((f) => f.endsWith('.json')).length === 5
  && files.filter((f) => f.endsWith('.md')).length === 5)

const load = (n) => JSON.parse(fs.readFileSync(
  path.join(EX, `${n}.evidence-pack.json`), 'utf8'))
const pe = load('power-entry-header')
check('2 pack has all 23 sections',
  Object.keys(pe.sections).length === 23)
check('3 routed board: ladder proves package_ready, NOT beyond',
  pe.state_ladder.package_ready === true
  && pe.state_ladder.quote_approved === false
  && pe.state_ladder.physically_built === false
  && pe.state_ladder.production_ready === false)
check('4 physical ledger state visible and EMPTY',
  pe.sections['16_physical_evidence_ledger'].artifacts.length === 0
  && pe.sections['16_physical_evidence_ledger'].order_status
  === 'not_ordered')
check('5 blocked claims present even on a clean board (physical validation '
      + '+ production readiness)',
  pe.sections['18_blocked_claims'].some((c) => c.includes('physical'))
  && pe.sections['18_blocked_claims'].some((c) => c.includes('production')))

const bga = load('bga-architecture-only')
check('6 architecture_only pack stays at designed; BGA claims blocked',
  bga.sections['01_executive_summary'].readiness_ladder_highest_proven
  === 'designed'
  && bga.sections['18_blocked_claims'].includes('BGA board emission'))
const rf = load('rf-blocked')
check('7 RF pack: blocked claims include impedance/antenna/EMC',
  ['impedance_correctness', 'antenna_performance', 'EMC'].every(
    (c) => rf.sections['18_blocked_claims'].includes(c)))
const m3 = load('m3-physical-quote-pending')
check('8 quote-pending pack: manual quote step + human unlock visible',
  m3.sections['21_manual_steps_required'].some((s) => s.includes('MANUAL'))
  && m3.sections['19_review_required'].some(
    (s) => s.includes('APPROVED_FOR_QUOTE')))

// approval integration: pack reflects an approved_for_quote record
const db = ent.resetDb()
const actor = 't'
const org = ent.createOrganization(db, { name: 'T', actor })
const ws = ent.createWorkspace(db, { org_id: org.org_id, name: 'W', actor })
const prog = ent.createProgram(db, { workspace_id: ws.workspace_id,
  name: 'P', actor })
const b = ent.createBoard(db, { program_id: prog.program_id, name: 'B',
  actor })
ent.attachRun(db, { board_id: b.board_id, run_dir: 'power-entry-header-v1',
  actor })
const rq = apr.requestApproval(db, { approval_type: 'approved_for_quote',
  scope: { board_id: b.board_id }, requested_by: 'pm', actor })
apr.decideApproval(db, { approval_id: rq.approval_id, decision: 'approved',
  approver: 'proc', actor })
const pack = ep.buildEvidencePack({ type: 'board', db,
  board_id: b.board_id, run_dir: 'power-entry-header-v1' })
check('9 approval state appears in the pack; ladder rung quote_approved '
      + 'flips only via the record',
  pack.sections['17_human_approvals'][0].status === 'approved'
  && pack.state_ladder.quote_approved === true)
check('10 reproducibility: pack records its artifact source path',
  pack.reproducible_from === 'public/runs/power-entry-header-v1')

// markdown rendering carries the honesty sections
const md = ep.packToMarkdown(pack)
check('11 markdown export includes blocked claims + ledger + ladder',
  md.includes('Blocked claims (never hidden)')
  && md.includes('Physical evidence ledger')
  && md.includes('State ladder'))

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E3 checks pass`)
process.exit(n === checks.length ? 0 : 1)
