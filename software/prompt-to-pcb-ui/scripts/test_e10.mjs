/** E10 regression: security/deployment baseline. */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const DOCS = path.join(APP, 'docs', 'enterprise')

const checks = []
function check(name, ok, detail = '') {
  checks.push(ok)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
}

const baseline = JSON.parse(fs.readFileSync(path.join(DOCS,
  'enterprise-security-deployment-baseline-v1.json'), 'utf8'))

check('1 baseline exists with compliance EXPLICITLY not claimed',
  baseline.baseline.compliance_not_claimed.length >= 6
  && baseline.baseline.compliance_statement.includes('NO compliance'))
check('2 auth assumptions + gaps documented honestly',
  baseline.baseline.authentication_assumptions.gaps.some(
    (g) => g.includes('SSO')))
check('3 authorization references E5 RBAC; audit references hash chain',
  baseline.baseline.authorization_model.includes('RBAC')
  && baseline.baseline.audit_log.includes('hash-chained'))
check('4 known gaps list is non-empty (honest)',
  baseline.baseline.known_gaps.length >= 5)
check('5 runtime report documents the Tailwind/GLB crash + port gotcha',
  baseline.runtime.known_runtime_issues.some((i) => i.includes('oxide'))
  && baseline.runtime.known_runtime_issues.some(
    (i) => i.includes('EADDRINUSE')))
check('6 runtime matrix distinguishes validated vs not-validated',
  Object.values(baseline.runtime.allowed_runtime_matrix).some(
    (v) => v.includes('NOT validated')))
check('7 deployment checklist forbids weakening gates',
  fs.readFileSync(path.join(DOCS, 'enterprise-deployment-checklist.md'),
                  'utf8').includes('do not weaken'))

// live secret scan of tracked files
let scanOk = true
try { execSync('node scripts/secret_scan.mjs', { cwd: APP }) }
catch { scanOk = false }
check('8 secret scan of tracked files is CLEAN', scanOk)

// no compliance claim leaks into customer-facing examples
const exDir = path.join(DOCS, 'customer-report-examples')
const claims = fs.readdirSync(exDir).some((f) => {
  const t = fs.readFileSync(path.join(exDir, f), 'utf8')
  return /SOC\s?2 certified|ISO 27001 certified|FedRAMP authorized/i.test(t)
})
check('9 no compliance claims in customer report examples', !claims)

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E10 checks pass`)
process.exit(n === checks.length ? 0 : 1)
