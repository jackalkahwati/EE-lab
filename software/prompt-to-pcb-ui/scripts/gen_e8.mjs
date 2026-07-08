/** E8 artifact generator — FL-1 bundle + validation session schema. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fl1 from '../lib/enterprise/fl1.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(HERE, '..', 'docs', 'enterprise')
fs.mkdirSync(DOCS, { recursive: true })

const schema = {
  version: 'fl1-validation-session/v1',
  fl1_asset_fields: ['asset_id', 'org_id', 'serial_placeholder', 'status',
                     'location_placeholder', 'software_term',
                     'service_notes', 'calibration_state'],
  session_fields: ['session_id', 'asset_id', 'board_id', 'run_id',
                   'validation_plan', 'operator', 'start_time', 'end_time',
                   'status', 'evidence_ids', 'measurements', 'failures',
                   'claims_affected', 'review_state'],
  session_states: fl1.SESSION_STATES,
  session_evidence_types: fl1.SESSION_EVIDENCE_TYPES,
  rules: [
    'validation session does not imply pass — completion lands as '
    + 'completed_pending_review',
    'session acceptance requires at least one REVIEWED (accepted) evidence '
    + 'item by a named reviewer',
    'uploaded physical evidence requires a real artifact file (store gate)',
    'measurements require name + value + units — no unlabeled numbers',
    'FL-1 asset presence does not imply physical validation',
    'calibration claims require calibration evidence',
  ],
}

const report = {
  version: 'v1', milestone: 'E8 FL-1 Bundle + Validation Sessions',
  delivered: {
    engine: 'lib/enterprise/fl1.mjs (asset model, 8-state session machine, '
      + 'evidence attach with labeled measurements, claim impact report, '
      + 'bundle status report)',
    api: 'register_fl1_asset / plan_validation_session / advance_session / '
      + 'attach_session_evidence / claim_impact_report / fl1_bundle_status',
    validation_plans: 'sessions bind to REAL fl1-testplan.json artifacts '
      + 'from the run; no plan -> session is blocked',
    tests: 'scripts/test_e8.mjs — 14/14',
  },
  acceptance: {
    bundle_representable: true,
    sessions_planned_tracked: true,
    evidence_attachable_as_metadata: 'with real-file requirement inherited '
      + 'from the store',
    claims_blocked_until_reviewed: 'tested: acceptance refused while '
      + 'evidence is unreviewed; unlocks only after named-reviewer '
      + 'acceptance',
  },
}

fs.writeFileSync(path.join(DOCS, 'fl1-validation-session-schema.json'),
                 JSON.stringify(schema, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-fl1-bundle-validation-v1.json'),
                 JSON.stringify(report, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-fl1-bundle-validation-v1.md'),
`# E8 — FL-1 Bundle and Validation Session Workflow v1

FL-1 hardware + Compose software as one enterprise bundle: asset records
(serial/location placeholders, software term, honest uncalibrated state),
8-state validation sessions bound to REAL fl1-testplan.json artifacts,
evidence attachment with labeled measurements, and claim-impact reporting.

${schema.rules.map((r) => '- ' + r).join('\n')}
`)
fs.writeFileSync(path.join(DOCS, 'fl1-validation-example-report.md'),
`# FL-1 validation session — example flow (synthetic)

1. Asset FL1-DEMO-001 registered (calibration: placeholder, claims blocked).
2. Session planned against the FL-1 Core-6 board's real test plan;
   operator assigned.
3. planned -> ready -> running -> completed_pending_review.
4. Acceptance REFUSED: no reviewed evidence ("a completed session never
   implies pass").
5. Operator attaches evidence (real artifact file required; measurement
   3V3_rail = 3.31 V, units mandatory).
6. Acceptance still refused — evidence pending review.
7. Named reviewer accepts the evidence; session acceptance unlocks.
8. Claim impact: physically_validated may now be REQUESTED (the readiness
   guard re-verifies); calibration and production_ready remain blocked.
`)
console.log('E8 artifacts written')
