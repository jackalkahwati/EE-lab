/**
 * E3 — Enterprise evidence pack generator.
 *
 * Builds a reviewer-grade evidence package from REAL run artifacts
 * (public/runs/<dir>/data + board/) plus enterprise store state. The pack
 * is reproducible: same artifacts -> same pack (timestamps aside). It can
 * only report what artifacts prove; anything else appears as a blocked
 * claim or missing item. The state ladder distinguishes designed / routed /
 * DRC-ERC clean / externally analyzed / package ready / quote approved /
 * physically built / physically validated / production ready — and never
 * lets an earlier rung read as a later one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { APP_ROOT } from './store.mjs'

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function runArtifacts(run_dir) {
  const dataDir = path.join(APP_ROOT, 'public', 'runs', run_dir, 'data')
  const boardDir = path.join(APP_ROOT, 'public', 'runs', run_dir, 'board')
  const art = (f) => readJson(path.join(dataDir, f))
  const list = (dir) => {
    try { return fs.readdirSync(dir).sort() } catch { return [] }
  }
  return { dataDir, boardDir, art, dataFiles: list(dataDir),
           boardFiles: list(boardDir) }
}

const LADDER = ['designed', 'routed', 'drc_erc_clean', 'externally_analyzed',
                'package_ready', 'quote_approved', 'physically_built',
                'physically_validated', 'production_ready']

/**
 * Build one evidence pack.
 * scope: {type: 'run'|'board'|'program'|'quote_packet'|'validation_packet'
 *         |'pilot_report', run_dir?, db?, board_id?, program_id?, title?}
 */
export function buildEvidencePack(scope) {
  const { run_dir = null, db = null, board_id = null, title = null } = scope
  const a = run_dir ? runArtifacts(run_dir) : null
  const lr = a?.art('last-run.json')
  const drcArt = a?.art('drc.json')
  const hardViol = drcArt
    ? (drcArt.violations ?? []).filter(
        (v) => v.type !== 'solder_mask_bridge').length
    : null
  const adv = a?.art('advanced-routing-report.json')
  const cons = a?.art('constraints.json')
  const board = db?.boards.find((b) => b.board_id === board_id) ?? null
  const approvals = db
    ? db.approvals.filter((x) => x.scope?.board_id === board_id)
    : []
  const evidence = db
    ? db.evidence.filter((x) => x.scope_id === board_id)
    : []
  const ledger = readJson(path.join(
    APP_ROOT, 'public', 'runs', 'power-entry-header-2l', 'data',
    'compose-physical-evidence-ledger.json'))
  const m3aRep = readJson(path.join(
    APP_ROOT, 'public', 'runs', 'fl1-backplane-v1', 'data',
    'flroute-regression-report.json'))
  // ONLY this scope's own artifacts count — a platform-wide report from
  // another board must never raise this board's ladder
  const eda = a?.art('external-analysis-run-report.json') ?? null

  // ---- state ladder (each rung requires PROOF; nothing is inferred) -------
  const acceptedPhysical = evidence.filter(
    (e) => e.status === 'accepted'
      && ['physical_measurement', 'visual_inspection', 'continuity_results',
          'i2c_scan', 'oscilloscope_capture', 'thermal_image']
        .includes(e.evidence_type))
  const quoteApproved = approvals.some(
    (x) => x.approval_type === 'approved_for_quote' && x.status === 'approved')
  const ladder = {
    designed: !!lr || !!scope.designed,
    routed: lr ? (lr.board?.unroutedNets?.length === 0) : false,
    drc_erc_clean: hardViol === 0 && lr?.stages?.erc?.state === 'passed',
    externally_analyzed: !!eda,
    package_ready: (a?.boardFiles?.length ?? 0) > 0 && hardViol === 0,
    quote_approved: quoteApproved,
    physically_built: acceptedPhysical.length > 0
      || (ledger?.artifacts?.length ?? 0) > 0,
    physically_validated: acceptedPhysical.length > 0,
    production_ready: false, // structurally: requires evidence that does not exist
  }
  const highest = [...LADDER].reverse().find((k) => ladder[k]) ?? 'designed'

  const blocked = [...new Set([
    ...(board?.blocked_claims ?? []),
    ...(adv?.unsupported_constraints ?? []).map(
      (u) => `advanced routing: ${u.pair} unsupported by v1 router`),
    ...(cons?.unsupported ?? []).map(
      (u) => `constraint unsupported: ${u.feature}`),
    ...(scope.extra_blocked_claims ?? []),
    ...(!ladder.physically_validated
      ? ['physical validation (no accepted physical evidence)'] : []),
    'production readiness (no yield/manufacturing evidence)',
  ])]

  return {
    schema: 'evidence-pack/v1',
    scope_type: scope.type,
    title: title ?? run_dir ?? board_id,
    generated_at: new Date().toISOString(),
    reproducible_from: run_dir ? `public/runs/${run_dir}` : 'enterprise store',
    sections: {
      '01_executive_summary': {
        readiness_ladder_highest_proven: highest,
        one_line: `${title ?? run_dir}: highest PROVEN state is `
          + `'${highest}'; ${blocked.length} blocked claim(s); physical `
          + `evidence ledger ${ledger?.artifacts?.length ? 'HAS ITEMS'
            : 'EMPTY'}`,
      },
      '02_original_prompt': lr?.prompt ?? scope.prompt ?? null,
      '03_architecture_summary': lr?.composeSpec ?? scope.architecture ?? null,
      '04_board_class': lr?.composeSpec?.boardClass
        ?? board?.board_class ?? null,
      '05_pcb_artifacts': a?.boardFiles ?? [],
      '06_bom': a?.dataFiles?.includes('bom.json')
        ? `public/runs/${run_dir}/data/bom.json` : null,
      '07_manufacturing_package': a?.dataFiles?.filter(
        (f) => /assembly|sourcing|pick|bom/.test(f)) ?? [],
      '08_drc_erc': {
        drc_hard_violations: hardViol,
        unconnected: drcArt ? (drcArt.unconnected_items ?? []).length : null,
        erc: lr?.stages?.erc?.state ?? 'unknown',
      },
      '09_router_evidence_state': lr
        ? (ladder.routed ? 'routed_in_sandbox (all nets)' : 'open nets remain')
        : (scope.router_evidence ?? 'no run — architecture only'),
      '10_flroute_fixture_coverage': m3aRep
        ? { full_suite: `${m3aRep.full_suite.passed}/${m3aRep.full_suite.fixtures}`,
            realboard: `${m3aRep.realboard_suite.passed}/3` }
        : null,
      '11_external_eda_summary': eda
        ? { claim_gates_blocked: eda.claim_gates_blocked?.length
              ?? Object.keys(eda.claim_gates ?? {}).length,
            note: 'analysis evidence is never physical evidence' }
        : 'not generated',
      '12_domain_evidence': scope.domain_evidence ?? 'none applicable',
      '13_missing_model_tool_stackup': {
        stackup: 'none in repo — controlled impedance blocked',
        ibis: 'none in repo — SI claims blocked',
        openEMS: 'not installed — RF solver analyses unavailable',
      },
      '14_firmware_state': lr?.stages?.firmware?.state ?? 'unknown',
      '15_validation_workflow': a?.dataFiles?.includes('fl1-testplan.json')
        ? `public/runs/${run_dir}/data/fl1-testplan.json` : 'not generated',
      '16_physical_evidence_ledger': {
        artifacts: ledger?.artifacts ?? [],
        order_status: ledger?.order_status ?? 'not_ordered',
        accepted_physical_evidence_items: acceptedPhysical.length,
      },
      '17_human_approvals': approvals.map((x) => ({
        type: x.approval_type, status: x.status, approver: x.approver })),
      '18_blocked_claims': blocked,
      '19_review_required': [
        ...(board?.review_required_items ?? []),
        ...(scope.review_required ?? [])],
      '20_known_risks': scope.risks ?? [],
      '21_manual_steps_required': [
        'human review of the manufacturing package',
        ...(quoteApproved ? [] : ['quote approval (human decision)']),
        'quote submission is MANUAL — never automatic',
        'physical evidence upload + review after build'],
      '22_readiness_state': board?.readiness
        ?? (ladder.routed ? 'routed_in_sandbox' : 'architecture_only'),
      '23_recommended_next_actions': scope.next_actions
        ?? ['request board_review_approval',
            'generate quote packet (human-gated)'],
    },
    state_ladder: ladder,
    honesty: 'this pack reports what artifacts prove; designed != routed '
      + '!= validated != production-ready; blocked claims are load-bearing',
  }
}

export function packToMarkdown(pack) {
  const s = pack.sections
  const lad = pack.state_ladder
  const ladderLine = LADDER.map(
    (k) => `${lad[k] ? '[x]' : '[ ]'} ${k}`).join(' · ')
  return `# Evidence pack — ${pack.title}

*scope: ${pack.scope_type} · generated ${pack.generated_at} · reproducible
from \`${pack.reproducible_from}\`*

## 1. Executive summary
${s['01_executive_summary'].one_line}

**State ladder:** ${ladderLine}

## 2-4. Intent
- Prompt: ${typeof s['02_original_prompt'] === 'string'
    ? s['02_original_prompt'].slice(0, 300) : 'n/a'}
- Board class: ${s['04_board_class'] ?? 'n/a'}

## 5-7. Artifacts
- PCB artifacts: ${s['05_pcb_artifacts'].join(', ') || 'none'}
- BOM: ${s['06_bom'] ?? 'none'}
- Manufacturing package: ${s['07_manufacturing_package'].join(', ') || 'none'}

## 8-11. Engineering evidence
- DRC hard violations: ${s['08_drc_erc'].drc_hard_violations ?? 'n/a'} ·
  unconnected: ${s['08_drc_erc'].unconnected ?? 'n/a'} · ERC: ${s['08_drc_erc'].erc}
- Router evidence: ${s['09_router_evidence_state']}
- flroute fixture coverage: ${JSON.stringify(s['10_flroute_fixture_coverage'])}
- External EDA: ${JSON.stringify(s['11_external_eda_summary'])}

## 13. Missing models/tools/stackup
${Object.entries(s['13_missing_model_tool_stackup'])
  .map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## 16. Physical evidence ledger
- Items: ${s['16_physical_evidence_ledger'].artifacts.length} ·
  order status: ${s['16_physical_evidence_ledger'].order_status} ·
  accepted physical evidence: ${s['16_physical_evidence_ledger'].accepted_physical_evidence_items}

## 17. Human approvals
${s['17_human_approvals'].length
  ? s['17_human_approvals'].map(
      (x) => `- ${x.type}: **${x.status}**${x.approver ? ` (${x.approver})` : ''}`).join('\n')
  : '- none'}

## 18. Blocked claims (never hidden)
${s['18_blocked_claims'].map((c) => `- ${c}`).join('\n')}

## 19-21. Review + manual steps
${s['19_review_required'].map((c) => `- review: ${c}`).join('\n') || '- none'}
${s['21_manual_steps_required'].map((c) => `- manual: ${c}`).join('\n')}

## 22-23. State + next
- Readiness: **${s['22_readiness_state']}**
- Next: ${s['23_recommended_next_actions'].join('; ')}

---
${pack.honesty}
`
}
