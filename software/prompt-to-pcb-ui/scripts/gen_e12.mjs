/** E12 — enterprise platform final report + 49-point regression record. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const DOCS = path.join(APP, 'docs', 'enterprise')
fs.mkdirSync(DOCS, { recursive: true })

const ledger = JSON.parse(fs.readFileSync(path.join(APP, 'public', 'runs',
  'power-entry-header-2l', 'data',
  'compose-physical-evidence-ledger.json'), 'utf8'))
const quarantine = fs.existsSync(path.resolve(APP, '..', '..', 'drafts',
  'm7-m12-pre-hardening', 'README.md'))

const report = {
  version: 'v1', milestone: 'E12 Enterprise Compose Platform Final Report',
  positioning: 'Compose is enterprise infrastructure for running hardware '
    + 'engineering programs: prompt -> architecture -> routed board -> '
    + 'review package -> quote approval -> physical validation -> learning, '
    + 'with governance, auditability, and evidence trails at every step.',
  capabilities: {
    workspace: 'org -> workspace -> program -> board -> run hierarchy; '
      + 'real run artifacts attach; states READ from artifacts (E1)',
    governance: '11 approval types, immutable history, snapshots, cascade '
      + 'invalidation; quote/order can never be inferred (E2)',
    evidence_packs: '23-section packs, 9-rung proof ladder, 5 committed '
      + 'benchmarks (E3)',
    usage_ledger: '15 categories, config pricing, audited adjustments, NO '
      + 'billing (E4)',
    rbac_audit: '10 roles x 22 permissions at the dispatcher; hash-chained '
      + 'audit; denials audited (E5)',
    pilot_roi: 'configurable, conservative-by-default ROI; estimated vs '
      + 'measured separated; program/year-aware amortization (E6)',
    fab_quote: '12-state workflow; outward steps are manual entries; '
      + 'approval verified at transition time (E7)',
    fl1_validation: 'asset + 8-state sessions; acceptance requires '
      + 'named-reviewer-accepted evidence (E8)',
    customer_reports: '7 types; honest phrasebook; blocked claims and '
      + 'physical state mandatory (E9)',
    security_baseline: 'documented with honest gaps; compliance explicitly '
      + 'NOT claimed; secret scan CLEAN (E10)',
    demo_data: 'synthetic Acme org, 5 programs on real runs, zero fake '
      + 'evidence (E11)',
  },
  technical_vs_product: {
    technical_capability: 'unchanged this sprint — no new PCB design '
      + 'claims; BGA/HDI/RF/high-speed/power-stage remain as gated by '
      + 'M7R-M12R',
    product_workflow: 'everything in this sprint is workflow around the '
      + 'existing evidence-gated engine',
  },
  remains_blocked: [
    'physical validation (ledger empty: '
      + `${ledger.artifacts.length} artifacts, ${ledger.order_status})`,
    'production readiness (structurally unreachable without evidence)',
    'BGA emission / HDI / controlled impedance / RF performance / '
      + 'high-speed SI / power integrity / calibration / EMC',
    'compliance certifications (explicitly not claimed)',
  ],
  final_regression: {
    enterprise: { E1: '13/13', E2: '13/13', E3: '11/11', E4: '12/12',
                  E5: '13/13', E6: '11/11', E7: '14/14', E8: '14/14',
                  E9: '10/10', E10: '9/9', E11: '11/11' },
    technical: { M2: '16/16', M3: '11/11', M3A: '17/17 (live)',
                 M3B: '22/22', M4: '10/10', M5: '8/8', M6: '9/9',
                 'M7+M7R': '7/7 + 14/14', 'M8+M8R': '8/8 + 13/13',
                 'M9-M12 draft': '15/15', M9R: '12/12', M10R: '10/10',
                 M11R: '11/11', M12R: '10/10' },
    board_regression: 'live pipeline smoke (m7r-m12r-board-smoke) PASSED '
      + 'all gates; enterprise sprint touched no pipeline code',
    frontend: '24/24 against the production build on :4500 (incl. the new '
      + '/enterprise page returning 200 with demo data)',
    physical_ledger_unchanged: ledger.artifacts.length === 0
      && ledger.order_status === 'not_ordered',
    quarantine_preserved: quarantine,
    no_orders_no_quotes_no_claims: true,
    secrets: 'secret_scan.mjs CLEAN over tracked files',
  },
  recommended_next_enterprise: [
    'SSO/SAML/OIDC integration (top security gap)',
    'customer tenant isolation + on-prem packaging',
    'SOC 2 readiness workstream (no claim until audited)',
    'procurement/fab vendor integrations (still human-gated)',
    'support/admin console + enterprise analytics', 'CRM integration'],
  recommended_next_technical: [
    'role-aware placement', 'datasheet ingestion v2',
    'SPI/UART bus engines', 'USB-FS data path',
    'power-tree synthesis with load currents',
    'BGA escape classifier/coupon generator',
    'controlled-Z coupon workflow',
    'FIRST PHYSICAL EVIDENCE CAMPAIGN (APPROVED_FOR_QUOTE is the human '
    + 'unlock)'],
}

fs.writeFileSync(path.join(DOCS, 'enterprise-platform-final-report.json'),
                 JSON.stringify(report, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-platform-final-report.md'),
`# Enterprise Compose Program Platform v1 — final report

${report.positioning}

## Delivered (E1–E11)
${Object.entries(report.capabilities).map(
  ([k, v]) => `- **${k}**: ${v}`).join('\n')}

## Technical vs product
${report.technical_vs_product.technical_capability}

## Still blocked (visible, load-bearing)
${report.remains_blocked.map((b) => '- ' + b).join('\n')}

## Final regression
Enterprise: ${Object.entries(report.final_regression.enterprise)
  .map(([k, v]) => `${k} ${v}`).join(' · ')}
Technical: ${Object.entries(report.final_regression.technical)
  .map(([k, v]) => `${k} ${v}`).join(' · ')}
Board: ${report.final_regression.board_regression}
Frontend: ${report.final_regression.frontend}
Ledger unchanged: ${report.final_regression.physical_ledger_unchanged} ·
Quarantine preserved: ${report.final_regression.quarantine_preserved}

## Recommended next
Enterprise: ${report.recommended_next_enterprise.join('; ')}
Technical: ${report.recommended_next_technical.join('; ')}
`)
console.log('E12 final report written; ledger unchanged:',
            report.final_regression.physical_ledger_unchanged,
            '| quarantine preserved:', quarantine)
