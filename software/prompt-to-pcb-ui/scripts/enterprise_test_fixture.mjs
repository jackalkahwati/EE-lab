/** Test-only module tree. Never reads or copies the checkout's public/runs. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function withEnterpriseFixture(label, modules, run, scripts = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-test-`))
  const previousStoreDir = process.env.ENTERPRISE_STORE_DIR
  try {
    // store.mjs fixes APP_ROOT from import.meta.url. A store env override alone
    // does not isolate artifact reads, so copy the actual modules under test.
    for (const file of [
      ...new Set(['store', ...modules].map((name) => `lib/enterprise/${name}.mjs`)),
      ...scripts.map((name) => `scripts/${name}`),
    ]) {
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(new URL(`../${file}`, import.meta.url), target)
    }
    process.env.ENTERPRISE_STORE_DIR = path.join(root, 'data', 'enterprise')
    const fixture = {
      root,
      importModule: (name) => import(pathToFileURL(
        path.join(root, 'lib', 'enterprise', `${name}.mjs`)).href),
      artifact(runDir, name, data) {
        const target = path.join(root, 'public', 'runs', runDir, 'data', name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data))
        return target
      },
      routedRun(runDir) {
        this.artifact(runDir, 'last-run.json', {
          prompt: 'Synthetic enterprise regression fixture',
          status: 'PASSED', board: { unroutedNets: [] },
        })
        this.artifact(runDir, 'drc.json', { violations: [] })
      },
    }
    return await run(fixture)
  } finally {
    if (previousStoreDir === undefined) delete process.env.ENTERPRISE_STORE_DIR
    else process.env.ENTERPRISE_STORE_DIR = previousStoreDir
    fs.rmSync(root, { recursive: true, force: true })
  }
}
