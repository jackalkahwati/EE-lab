/**
 * E10 — secret scanning guard.
 * Scans git-TRACKED files under the app for secret-shaped material.
 * Exits non-zero on findings. Run before committing enterprise docs/demo
 * data. .env* files are gitignored and therefore out of scope by design —
 * this guards what actually ships in git.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')

const PATTERNS = [
  [/sk_live_[A-Za-z0-9]{8,}/, 'stripe live key'],
  [/sk_test_[A-Za-z0-9]{8,}/, 'stripe test key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/, 'private key'],
  [/ghp_[A-Za-z0-9]{20,}/, 'github token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'slack token'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'google api key'],
  [/(api[_-]?key|secret|password)\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]/i,
   'inline credential assignment'],
]

const files = execSync('git ls-files', { cwd: APP, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .filter((f) => /\.(ts|tsx|js|mjs|json|md|py|sh|yml|yaml|css)$/.test(f))

const findings = []
for (const f of files) {
  let text
  try { text = fs.readFileSync(path.join(APP, f), 'utf8') } catch { continue }
  for (const [re, label] of PATTERNS) {
    const m = text.match(re)
    if (m) findings.push({ file: f, label, sample: m[0].slice(0, 12) + '…' })
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ scanned: files.length, findings }, null, 1))
} else {
  console.log(`secret scan: ${files.length} tracked files`)
  for (const f of findings) console.log(`  FINDING ${f.file}: ${f.label}`)
  console.log(findings.length === 0 ? 'CLEAN' : `${findings.length} finding(s)`)
}
process.exit(findings.length === 0 ? 0 : 1)
