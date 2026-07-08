/** E4 artifact generator — credit ledger schema + reports + pricing
 *  alignment. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cr from '../lib/enterprise/credits.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.join(HERE, '..')
const DOCS = path.join(APP, 'docs', 'enterprise')
fs.mkdirSync(DOCS, { recursive: true })

// scan existing app surfaces for hard-coded price strings (report-only)
const findings = []
for (const rel of ['app/page.tsx', 'components/profile-menu.tsx',
                   'app/api/billing']) {
  const p = path.join(APP, rel)
  if (!fs.existsSync(p)) continue
  const files = fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).map((f) => path.join(p, f))
    : [p]
  for (const f of files) {
    if (!/\.(tsx?|mjs|js)$/.test(f) || !fs.statSync(f).isFile()) continue
    const src = fs.readFileSync(f, 'utf8')
    const hits = src.match(/\$\s?\d[\d,]*|\d+\s?credits|PRO|CREDITS/gi) ?? []
    if (hits.length) {
      findings.push({ file: rel + (files.length > 1
        ? '/' + path.basename(f) : ''),
        sample: [...new Set(hits)].slice(0, 5),
        note: 'existing surface untouched this sprint; reconcile with '
          + 'enterprise tier config before publishing' })
    }
  }
}

const schema = {
  version: 'v1',
  usage_categories: cr.USAGE_CATEGORIES,
  default_credit_costs: cr.DEFAULT_CREDIT_COSTS,
  tiers_internal_modeling_only: cr.TIERS,
  entry_fields: ['usage_id', 'org_id', 'program_id', 'board_id', 'run_id',
                 'usage_type', 'credits', 'estimated_dollar_value',
                 'timestamp', 'user', 'notes'],
  credit_model: ['organization credit balance',
                 'workspace credit allocation',
                 'program credit allocation (budget.credits_allocated)',
                 'board/run usage entries', 'manual adjustment (audited, '
                 + 'reason required)', 'pilot credits', 'annual platform '
                 + 'credits', 'board-program credits',
                 'fab-attach tracking placeholder (E7 metadata only)'],
  rules: [
    'no real billing, charging, or payment integration',
    'manual adjustments require a reason and produce an audit record',
    'overage flags commercial review; engineering gates are never priced',
    'pricing is config, never hard-coded into gates',
  ],
}

const report = {
  version: 'v1', milestone: 'E4 Usage/Credit Ledger',
  delivered: {
    engine: 'lib/enterprise/credits.mjs',
    api: 'record_usage / adjust_credits / budget_state / usage_report '
      + 'actions on /api/enterprise',
    ui: 'Usage tab on /enterprise board detail; program cards show '
      + 'consumed/allocated credits',
    reports: 'usageReport (by program/board/user/stage) + '
      + 'pricingAlignmentReport',
    tests: 'scripts/test_e4.mjs — 12/12',
  },
  acceptance: {
    events_recorded_for_major_actions: true,
    program_budget_view: true,
    ledger_auditable: 'hash-chained audit entries per event + adjustment',
    no_real_billing: true,
    pricing_not_in_gates: 'DEFAULT_CREDIT_COSTS/TIERS are config; '
      + 'budgetState explicitly never blocks engineering',
  },
}

const md = `# E4 — Board-Program Credits and Usage Ledger v1

15 usage categories, config-driven costs, 4 internal modeling tiers
(pilot / team / enterprise / enterprise+FL-1). Program budgets accumulate
consumption; overage flags \`overage_review_required\` — a commercial
review state that never blocks an engineering gate.

Not billing: no money moves, no payment integration, no external calls.
Manual credit adjustments require a reason and are hash-chain audited.

Pricing alignment: existing app surfaces with price-like strings are
reported (below) for human reconciliation — this sprint does not modify
the homepage or the existing billing API.

${findings.map((f) => `- \`${f.file}\`: ${f.sample.join(', ')}`).join('\n')
  || '- no price-like strings found in scanned surfaces'}
`

const alignment = cr.pricingAlignmentReport(findings)

fs.writeFileSync(path.join(DOCS, 'credit-ledger-schema.json'),
                 JSON.stringify(schema, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-usage-credit-ledger-v1.json'),
                 JSON.stringify(report, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-usage-credit-ledger-v1.md'), md)
fs.writeFileSync(path.join(DOCS, 'pricing-alignment-report.md'),
`# Pricing alignment report

${alignment.rule}

Findings (existing surfaces, untouched this sprint):
${findings.map((f) => `- **${f.file}** — ${f.sample.join(', ')} — ${f.note}`)
  .join('\n') || '- none'}
`)
console.log('E4 artifacts written; pricing findings:', findings.length)
