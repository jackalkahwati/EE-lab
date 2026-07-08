/** E1 artifact generator — schema + workspace + UI reports into
 *  docs/enterprise/ (committed, reviewable). */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ent from '../lib/enterprise/store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(HERE, '..', 'docs', 'enterprise')
fs.mkdirSync(DOCS, { recursive: true })

const schema = {
  version: 'v1',
  hierarchy: ['Organization', 'Workspace', 'Program', 'Board', 'Run',
              'Evidence', 'Approval', 'Quote/Fab/Validation state',
              'Learning'],
  entities: {
    organization: ['org_id', 'name', 'plan', 'created_at', 'policies',
                   'security_settings', 'credit_allocation', 'usage_limits'],
    workspace: ['workspace_id', 'org_id', 'name', 'description', 'members',
                'programs', 'default_evidence_policy',
                'default_approval_policy'],
    program: ['program_id', 'workspace_id', 'name', 'owner', 'objective',
              'business_context', 'technical_scope', 'board_list',
              'target_dates', 'status', 'budget', 'risks', 'blocked_claims',
              'evidence_state', 'approval_state', 'created_at', 'updated_at'],
    board: ['board_id', 'program_id', 'name', 'board_class',
            'requested_function', 'architecture_summary',
            'current_design_state', 'routed_state', 'package_state',
            'validation_state', 'physical_evidence_state',
            'production_readiness_state', 'readiness', 'blocked_claims',
            'review_required_items', 'latest_run_id',
            'manufacturing_packages', 'validation_workflows'],
    run: ['run_id', 'board_id', 'source_run_dir', 'prompt', 'repo_commit',
          'tool_versions', 'route_evidence_state', 'drc_state', 'erc_state',
          'firmware_state', 'external_eda_state', 'package_artifacts',
          'validation_artifacts', 'credit_usage', 'approval_requirements',
          'readiness_state', 'created_by', 'created_at'],
    evidence: ['evidence_id', 'scope_type', 'scope_id', 'evidence_type',
               'source', 'artifact_path', 'status', 'reviewer', 'timestamp',
               'claim_implications', 'blocked_claims', 'human_review_notes'],
    approval: ['approval_id', 'scope', 'approval_type', 'requested_by',
               'approver', 'status', 'evidence_snapshot',
               'blocked_claims_snapshot', 'notes', 'timestamp'],
    usage: ['usage_id', 'org_id', 'program_id', 'board_id', 'run_id',
            'usage_type', 'credits', 'estimated_dollar_value', 'timestamp',
            'user', 'notes'],
  },
  program_statuses: ent.PROGRAM_STATUSES,
  readiness_states: ent.READINESS_STATES,
  evidence_types: ent.EVIDENCE_TYPES,
  gate_rules: [
    'production_ready structurally unreachable without accepted physical + '
    + 'yield + manufacturing evidence AND production_readiness_approval',
    'approved_for_quote requires an explicit approved approval record',
    'physically_validated requires an ACCEPTED physical evidence item '
    + 'whose artifact file exists on disk',
    'physical evidence items cannot be created without a real file',
    'blocked claims and review-required items are inherited from run '
    + 'artifacts and never hidden by state changes',
  ],
  storage: 'file-backed JSON at data/enterprise/store.json (gitignored '
           + 'runtime state; seed script regenerates); append-only '
           + 'hash-chained audit log',
}

const report = {
  version: 'v1', milestone: 'E1 Enterprise Program Workspace',
  delivered: {
    data_model: 'lib/enterprise/store.mjs (8 entities, enums, gate rules)',
    api: 'app/api/enterprise/route.ts (GET state, POST action dispatch, '
         + 'all mutations audited, RBAC hook in place)',
    ui: 'app/enterprise/page.tsx (workspace selector, program list, '
        + 'program detail, board detail with Runs/Evidence/Approvals/'
        + 'Usage/Risks tabs)',
    tests: 'scripts/test_e1.mjs — 13/13 (isolated temp store)',
  },
  honesty_invariants: schema.gate_rules,
  acceptance: {
    entities_exist: true,
    programs_contain_multiple_boards_and_runs: true,
    existing_artifacts_attachable: 'attachRun reads real public/runs '
      + 'artifacts; route/DRC/ERC states are read, never asserted',
    evidence_and_approval_states_visible: true,
    physical_production_claims_gated: true,
  },
}

const md = `# E1 — Enterprise Program Workspace v1

Organization → Workspace → Program → Board → Run → Evidence → Approval →
Quote/Fab/Validation state → Learning.

## What exists
- **Data model** \`lib/enterprise/store.mjs\`: 8 entities, 13 program
  statuses, 8 readiness states, 17 evidence types; file-backed JSON store
  with an append-only, hash-chained audit log.
- **API** \`/api/enterprise\`: GET full state; POST action dispatch. Every
  mutation writes an audit entry; refused promotions are audited too.
- **UI** \`/enterprise\`: workspace selector, program list, program detail,
  board detail with Runs / Evidence / Approvals / Usage / Risks tabs.
  Readiness renders verbatim; blocked claims and review-required items are
  always visible.

## Gate preservation (load-bearing)
${schema.gate_rules.map((r) => '- ' + r).join('\n')}

## Evidence
13/13 E1 checks: hierarchy, multi-board programs, multi-run boards, REAL
artifact attachment (power-entry-header-v1, FL-1 Core-6), physical-evidence
file requirement, refused promotions (approved_for_quote, physically_
validated, production_ready), audit chain integrity.
`

const uiReport = `# E1 — Enterprise workspace UI report

Route: \`/enterprise\` (behind the existing session auth middleware).

| Required view | Where |
|---|---|
| Organizations / workspace selector | header select, org name + plan chip |
| Program list | left column cards (status, board count, credits) |
| Program detail | main panel (owner, objective, blocked claims) |
| Board list inside program | board chips with readiness badges |
| Board detail | bordered panel with tab bar |
| Run history | Runs tab (route/DRC/ERC states from real artifacts) |
| Evidence tab | Evidence tab (status color-coded; empty state says the physical ledger is EMPTY) |
| Approval tab | Approvals tab (empty state says quote/order stays locked) |
| Usage tab | Usage tab (credits per event) |
| Risk/blocker tab | Risks tab (program risks + board blocked claims) |

Honesty notes: architecture_only and routed_in_sandbox render as their own
badges — no styling implies built or validated hardware; SYNTHETIC DEMO
DATA chip appears when the org is flagged demo.
`

fs.writeFileSync(path.join(DOCS, 'enterprise-workspace-schema.json'),
                 JSON.stringify(schema, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-program-workspace-v1.json'),
                 JSON.stringify(report, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-program-workspace-v1.md'), md)
fs.writeFileSync(path.join(DOCS, 'enterprise-workspace-ui-report.md'),
                 uiReport)
console.log('E1 artifacts written to docs/enterprise/')
