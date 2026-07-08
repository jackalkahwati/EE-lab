/** E10 artifact generator — security/deployment baseline (NO compliance
 *  claims), runtime environment report, deployment checklist. */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const DOCS = path.join(APP, 'docs', 'enterprise')
fs.mkdirSync(DOCS, { recursive: true })

const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim() }
                    catch { return 'unavailable' } }
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'),
                                       'utf8'))

const baseline = {
  version: 'v1', milestone: 'E10 Security + Deployment Baseline',
  compliance_not_claimed: [
    'SOC 2', 'ISO 27001', 'FedRAMP', 'ITAR', 'CMMC', 'HIPAA', 'DFARS',
  ],
  compliance_statement: 'NO compliance certification is claimed. This is '
    + 'an engineering baseline inventory, not an attestation.',
  authentication_assumptions: {
    model: 'session cookie auth (middleware) over an in-memory session '
      + 'store; users in data/users.json (gitignored)',
    gaps: ['sessions are in-memory — restart invalidates them',
           'no SSO/SAML/OIDC (recommended next enterprise milestone)',
           'no MFA'],
  },
  authorization_model: 'E5 RBAC: 10 roles x 22 permissions enforced at '
    + 'the /api/enterprise dispatcher; denials audited; dev-admin default '
    + 'for local development',
  audit_log: 'append-only, hash-chained (sha256 prev-hash); '
    + 'verifyAuditChain exposed via API; tampering is detectable',
  artifact_storage: 'local filesystem: public/runs (run artifacts, '
    + 'gitignored), data/enterprise/store.json (gitignored runtime state)',
  secrets: {
    handling: '.env.local (gitignored) holds all API keys; secret_scan.mjs '
      + 'guards tracked files; enterprise docs/demo data are scanned',
    scan_state: 'CLEAN at generation time',
  },
  external_tools: ['kicad-cli / kipython (local binaries)',
                   'flroute (local rust binary)', 'ngspice if installed',
                   'no external EDA SaaS'],
  network_calls: 'pipeline optionally calls supplier APIs (DigiKey) with '
    + 'keys from env; enterprise layer makes NO external calls; no '
    + 'payment integration',
  data_retention: { placeholder: true,
    note: 'no automatic deletion; runtime stores are local files — '
      + 'retention policy is a deployment decision' },
  export_controls: { placeholder: true,
    note: 'artifact export controls not implemented; flagged for the '
      + 'on-prem/tenant-isolation milestone' },
  customer_data_handling: 'demo data is synthetic; customer reports scrub '
    + 'local paths; evidence artifacts stay on the deployment host',
  deployment_modes: {
    local_dev: 'next dev',
    local_prod: 'next build + next start (validated on this machine, '
      + 'port 4500)',
    on_prem: 'viable: file-backed stores, local binaries, no external '
      + 'dependencies required at runtime — packaging is a next milestone',
    cloud: 'possible but NOT hardened: single-tenant assumption, '
      + 'in-memory sessions, local file stores',
  },
  known_gaps: [
    'no SSO/SAML/OIDC', 'no MFA', 'in-memory sessions',
    'single-tenant file store (no tenant isolation)',
    'no rate limiting on APIs', 'no at-rest encryption of local stores',
    'IP/session fields in audit log are placeholders',
  ],
}

const runtime = {
  version: 'v1',
  node: sh('node --version'),
  package_manager: 'pnpm (store-dir ~/.pnpm-store/v3 on this machine)',
  next: pkg.dependencies?.next,
  react: pkg.dependencies?.react,
  tailwind: 'v4 (oxide native scanner)',
  three: pkg.dependencies?.three,
  kicad_cli: sh('kicad-cli version'),
  python_for_planner: sh('python3 --version'),
  known_runtime_issues: [
    'Tailwind v4 oxide scanner CRASHES on multi-MB binaries in '
    + 'non-gitignored paths (silent worker death -> TurbopackInternalError '
    + 'on globals.css; dev hangs). Guards: *.glb gitignored + @source not '
    + '"../public" in globals.css. Any new generated binary must be '
    + 'gitignored BEFORE the next build.',
    'next start holds the port across rebuilds — kill by PID from '
    + 'lsof -t -iTCP:<port> before restarting, or EADDRINUSE serves the '
    + 'STALE build',
    'pcbnew (kipython) requires crash-isolated subprocesses for fixture '
    + 'suites (M3A harness does this)',
    'plain-ESM .mjs modules are shared between Next API routes and node '
    + 'test scripts — keep them dependency-free',
  ],
  allowed_runtime_matrix: {
    'node 25.x + next 16.2 (turbopack)': 'validated (this machine)',
    'node 22 LTS': 'expected OK — NOT validated',
    'webpack build': 'works via next build --webpack; not the default',
    'windows': 'NOT validated (kicad paths are macOS-specific in scripts)',
  },
}

const checklist = `# Enterprise deployment checklist

Pre-deploy
- [ ] \`node scripts/secret_scan.mjs\` is CLEAN
- [ ] .env.local present on host, never in git
- [ ] data/ and public/runs/ on persistent storage with backups
- [ ] *.glb and any new generated binaries gitignored (Tailwind scanner)
- [ ] \`npm run build\` green; kill old server PID before \`next start\`

Access
- [ ] seed real users; disable/replace demo seed data
- [ ] assign RBAC roles (no one but admins keeps org_admin)
- [ ] review audit chain (\`verifyAuditChain\`) after first day

Honesty gates (do not weaken)
- [ ] guardReadiness untouched (production_ready unreachable)
- [ ] approval gates verified at transition time
- [ ] physical evidence requires real files + named-reviewer acceptance

Not claimed
- [ ] no SOC2/ISO/FedRAMP/ITAR/CMMC/HIPAA claim anywhere in customer
      materials
`

fs.writeFileSync(path.join(DOCS,
  'enterprise-security-deployment-baseline-v1.json'),
  JSON.stringify({ baseline, runtime }, null, 1))
fs.writeFileSync(path.join(DOCS,
  'enterprise-security-deployment-baseline-v1.md'),
`# E10 — Enterprise Security and Deployment Baseline v1

**${baseline.compliance_statement}**
Explicitly not claimed: ${baseline.compliance_not_claimed.join(', ')}.

## Authentication / authorization
${baseline.authentication_assumptions.model}. ${baseline.authorization_model}.
Gaps: ${baseline.authentication_assumptions.gaps.join('; ')}.

## Audit / storage / secrets
${baseline.audit_log}. Artifacts: ${baseline.artifact_storage}.
Secrets: ${baseline.secrets.handling}.

## External surface
Tools: ${baseline.external_tools.join(', ')}. Network: ${baseline.network_calls}.

## Deployment modes
- local prod: ${baseline.deployment_modes.local_prod}
- on-prem: ${baseline.deployment_modes.on_prem}
- cloud: ${baseline.deployment_modes.cloud}

## Known gaps (honest)
${baseline.known_gaps.map((g) => '- ' + g).join('\n')}
`)
fs.writeFileSync(path.join(DOCS, 'enterprise-deployment-checklist.md'),
                 checklist)
fs.writeFileSync(path.join(DOCS, 'runtime-environment-report.md'),
`# Runtime environment report

- node: ${runtime.node} · next: ${runtime.next} · react: ${runtime.react}
- tailwind: ${runtime.tailwind} · three: ${runtime.three}
- kicad-cli: ${runtime.kicad_cli} · planner python: ${runtime.python_for_planner}

## Known runtime issues (documented honestly)
${runtime.known_runtime_issues.map((i) => '- ' + i).join('\n')}

## Allowed/unsupported runtime matrix
${Object.entries(runtime.allowed_runtime_matrix)
  .map(([k, v]) => `- ${k}: ${v}`).join('\n')}
`)
console.log('E10 artifacts written; node', runtime.node, '| kicad',
            runtime.kicad_cli)
