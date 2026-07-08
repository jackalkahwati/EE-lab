/** E3 — generate the five benchmark evidence packs + schema + reports. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEvidencePack, packToMarkdown }
  from '../lib/enterprise/evidencepack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(HERE, '..', 'docs', 'enterprise')
const EX = path.join(DOCS, 'evidence-pack-examples')
fs.mkdirSync(EX, { recursive: true })

const BENCHMARKS = [
  { name: 'power-entry-header',
    scope: { type: 'run', run_dir: 'power-entry-header-v1',
             title: 'Power Entry Header v1 (synthesized, routed, DRC clean)' } },
  { name: 'txb0102-multi-rail',
    scope: { type: 'run', run_dir: 'chipdown-txb0102-v1',
             title: 'TXB0102 multi-rail chip-down (M6 domain-aware rails)' } },
  { name: 'bga-architecture-only',
    scope: { type: 'board', designed: true,
             title: 'iCE40HX4K BGA-121 study — ARCHITECTURE ONLY',
             prompt: 'FPGA board study around iCE40HX4K-BG121',
             architecture: { boardClass: 'bga-architecture-study' },
             router_evidence: 'M7R bga fixture suite: ring-0 escapes; '
               + 'ring-1 trapped; interior unreachable (no escape emitter)',
             domain_evidence: 'm7r-bga-replay-report / '
               + 'm7r-bga-router-evidence (fixture-proven gap)',
             extra_blocked_claims: [
               'BGA routing support', 'BGA board emission',
               'HDI/microvia/via-in-pad support', 'FPGA board support'],
             next_actions: ['build the ball-grid escape emitter (M7R '
               + 'fixtures are its acceptance tests)'] } },
  { name: 'rf-blocked',
    scope: { type: 'board', designed: true,
             title: 'RF adapter request — BLOCKED (no solver/stackup/'
               + 'S-parameters/measurement)',
             prompt: 'SMA RF adapter with antenna path',
             router_evidence: 'no run — RF gate returned architecture_only',
             domain_evidence: 'm10r-rf-replay-report: blockers cite '
               + 'recorded M3B states',
             extra_blocked_claims: [
               'impedance_correctness', 'antenna_performance',
               'RF_compliance', 'EMC', 'link_budget', 'radiated_power'],
             next_actions: ['acquire stackup data (cheapest unlock)',
                            'install openEMS or obtain S-parameters'] } },
  { name: 'm3-physical-quote-pending',
    scope: { type: 'quote_packet', run_dir: 'power-entry-header-2l',
             title: 'M3 physical loop board — quote PENDING human approval',
             review_required: ['APPROVED_FOR_QUOTE is the human unlock; '
               + 'no approval record exists yet'],
             next_actions: ['human decision on approved_for_quote',
                            'manual quote submission if approved'] } },
]

const results = []
for (const b of BENCHMARKS) {
  const pack = buildEvidencePack(b.scope)
  fs.writeFileSync(path.join(EX, `${b.name}.evidence-pack.json`),
                   JSON.stringify(pack, null, 1))
  fs.writeFileSync(path.join(EX, `${b.name}.evidence-pack.md`),
                   packToMarkdown(pack))
  results.push({
    name: b.name,
    highest_proven: pack.sections['01_executive_summary']
      .readiness_ladder_highest_proven,
    blocked_claims: pack.sections['18_blocked_claims'].length,
    ledger_empty: pack.sections['16_physical_evidence_ledger']
      .artifacts.length === 0,
  })
}

const schema = {
  version: 'evidence-pack/v1',
  scopes: ['run', 'board', 'program', 'quote_packet', 'validation_packet',
           'pilot_report'],
  sections: 23,
  section_ids: Object.keys(buildEvidencePack(
    { type: 'run', run_dir: 'power-entry-header-v1' }).sections),
  state_ladder: ['designed', 'routed', 'drc_erc_clean',
                 'externally_analyzed', 'package_ready', 'quote_approved',
                 'physically_built', 'physically_validated',
                 'production_ready'],
  rules: [
    'packs never hide blocked claims (section 18 is mandatory)',
    'each ladder rung requires artifact/record proof; nothing inferred',
    'physical ledger state always included (section 16)',
    'reproducible from run artifacts (path recorded in the pack)',
    'no fake customer data; synthetic scopes are labeled',
  ],
  formats: ['json', 'markdown'],
}

const report = {
  version: 'v1', milestone: 'E3 Enterprise Evidence Pack',
  delivered: {
    generator: 'lib/enterprise/evidencepack.mjs (23 sections, state ladder)',
    api: '/api/enterprise/evidence-pack?run_dir|board_id&format=json|md',
    ui: 'evidence pack ↓ button on /enterprise board detail',
    benchmarks: results,
    tests: 'scripts/test_e3.mjs',
  },
  acceptance: {
    packs_generate: results.length === 5,
    blocked_claims_visible: results.every((r) => r.blocked_claims > 0),
    ledger_state_visible: true,
    approvals_included: 'section 17',
    no_production_ready_without_evidence: results.every(
      (r) => r.highest_proven !== 'production_ready'),
  },
}

const md = `# E3 — Enterprise Evidence Pack v1

23-section reviewer-grade packs built from REAL run artifacts, with a
9-rung state ladder where every rung needs proof. Five benchmarks:

${results.map((r) => `- **${r.name}** — highest proven: \`${r.highest_proven}\`, `
  + `${r.blocked_claims} blocked claim(s), ledger empty: ${r.ledger_empty}`).join('\n')}

Rules: blocked claims mandatory (section 18); physical ledger state
mandatory (section 16); designed / routed / DRC-clean / analyzed / package /
quote-approved / built / validated / production-ready are distinct rungs;
production_ready is structurally false without evidence that does not
exist. Packs are reproducible from the recorded artifact path.
`

fs.writeFileSync(path.join(DOCS, 'evidence-pack-schema.json'),
                 JSON.stringify(schema, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-evidence-pack-v1.json'),
                 JSON.stringify(report, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-evidence-pack-v1.md'), md)
console.log('E3: %d benchmark packs -> docs/enterprise/evidence-pack-examples',
            results.length)
for (const r of results) console.log(' ', r.name, '->', r.highest_proven)
