import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isValidRunId, runAccess } from './auth'
import { astraWorkspace, authorizeAstra } from './astra-beta'
import { AstraError } from './astra-execution'

export const ASTRA_MANIFEST = 'astra-manifest.json'
const metadata = new Set(['astra-policy.json', 'product-spec.json', 'timing.json', ASTRA_MANIFEST])
export const ASTRA_OUTPUTS = Object.freeze({
  'electronics/chipscale-board.json': 1024 * 1024,
  'electronics/chipscale.kicad_pcb': 16 * 1024 * 1024,
  'electronics/netlist.json': 128 * 1024,
  'electronics/native-evidence.json': 2 * 1024 * 1024,
  'electronics/drc.json': 4 * 1024 * 1024,
  'electronics/chipscale.svg': 8 * 1024 * 1024,
  'electronics/layer-top.svg': 8 * 1024 * 1024,
  'electronics/layer-bottom.svg': 8 * 1024 * 1024,
  'board/render-top.png': 16 * 1024 * 1024,
  'board/render-bottom.png': 16 * 1024 * 1024,
  'board/chipscale.glb': 64 * 1024 * 1024,
})
export type AstraArtifactName = keyof typeof ASTRA_OUTPUTS
export interface AstraManifest {
  version: 1
  runId: string
  scope: 'electronics-only'
  status: 'passed' | 'failed' | 'cancelled' | 'unknown'
  native: true
  routeAttempts: number
  createdAt: string
  proposalSha256: string
  tools: Record<string, string>
  checks: { drcAvailable: boolean; drcErrors: number | null; unrouted: number | null; identityPreserved: boolean; exportsComplete: boolean }
  artifacts: { path: AstraArtifactName; bytes: number; sha256: string }[]
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function parseAstraManifest(value: unknown, runId: string): AstraManifest {
  if (!object(value) || value.version !== 1 || value.runId !== runId || value.scope !== 'electronics-only' || value.native !== true
    || typeof value.status !== 'string' || !['passed', 'failed', 'cancelled', 'unknown'].includes(value.status)
    || !count(value.routeAttempts) || value.routeAttempts > 1 || !digest(value.proposalSha256)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !object(value.tools) || Object.keys(value.tools).length > 16 || !Object.values(value.tools).every(v => typeof v === 'string' && v.length <= 256)
    || !object(value.checks) || !Array.isArray(value.artifacts) || value.artifacts.length > Object.keys(ASTRA_OUTPUTS).length) {
    throw new AstraError('output', 'Native artifact manifest is invalid.')
  }
  const checks = value.checks
  if (typeof checks.drcAvailable !== 'boolean' || typeof checks.identityPreserved !== 'boolean' || typeof checks.exportsComplete !== 'boolean'
    || !(checks.drcErrors === null || count(checks.drcErrors)) || !(checks.unrouted === null || count(checks.unrouted))) {
    throw new AstraError('output', 'Native check evidence is invalid.')
  }
  const names = new Set<string>()
  for (const item of value.artifacts) {
    if (!object(item) || typeof item.path !== 'string' || !Object.hasOwn(ASTRA_OUTPUTS, item.path) || names.has(item.path)
      || !count(item.bytes) || item.bytes === 0 || item.bytes > ASTRA_OUTPUTS[item.path as AstraArtifactName] || !digest(item.sha256)) {
      throw new AstraError('output', 'Native artifact entry is invalid.')
    }
    names.add(item.path)
  }
  if (checks.exportsComplete && Object.keys(ASTRA_OUTPUTS).some(name => !names.has(name))) {
    throw new AstraError('output', 'Native exports are incomplete.')
  }
  if (value.status === 'passed' && (!checks.drcAvailable || checks.drcErrors !== 0 || checks.unrouted !== 0
    || !checks.identityPreserved || !checks.exportsComplete || value.routeAttempts !== 1)) {
    throw new AstraError('output', 'Native success lacks required evidence.')
  }
  return value as unknown as AstraManifest
}

function artifactLimit(relative: string): number {
  if (metadata.has(relative)) return relative === ASTRA_MANIFEST ? 64 * 1024 : 256 * 1024
  if (Object.hasOwn(ASTRA_OUTPUTS, relative)) return ASTRA_OUTPUTS[relative as AstraArtifactName]
  throw new AstraError('policy', 'This file is not a published Astra artifact.')
}

/** No recursive traversal: only exact known files in an owned, canonical run. */
export async function readAstraFile(root: string, runId: string, relative: string): Promise<Buffer> {
  const limit = artifactLimit(relative)
  if (!isValidRunId(runId) || !runId.startsWith('run-')) throw new AstraError('policy', 'Invalid Astra run identity.')
  const parts = [root, path.join(root, 'public'), path.join(root, 'public/runs'), path.join(root, 'public/runs', runId)]
  const segments = relative.split('/')
  for (const segment of segments.slice(0, -1)) parts.push(path.join(parts[parts.length - 1], segment))
  const snapshots: { dev: number; ino: number }[] = []
  for (const directory of parts) {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new AstraError('policy', 'Astra artifact directory is not isolated.')
    snapshots.push(stat)
  }
  const file = path.join(parts[parts.length - 1], segments[segments.length - 1])
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new AstraError('output', 'Astra artifact size is invalid.')
    const verify = async () => {
      for (let i = 0; i < parts.length; i++) {
        const current = await fs.lstat(parts[i])
        if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== snapshots[i].dev || current.ino !== snapshots[i].ino) throw new AstraError('policy', 'Astra artifact directory changed during access.')
      }
      const current = await fs.lstat(file)
      if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new AstraError('policy', 'Astra artifact changed during access.')
    }
    await verify()
    const buffer = Buffer.alloc(stat.size + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!result.bytesRead) break
      bytes += result.bytesRead
    }
    if (bytes !== stat.size) throw new AstraError('output', 'Astra artifact changed size during access.')
    await verify()
    return buffer.subarray(0, bytes)
  } finally { await handle.close() }
}

export function authorizeAstraRun(req: Request, runId: string): string {
  authorizeAstra(req)
  if (!isValidRunId(runId) || !runId.startsWith('run-') || runAccess(req, runId).access !== 'owner') {
    throw new AstraError('policy', 'This Astra run is not owned by the current operator.')
  }
  return astraWorkspace().root
}

export async function readAstraManifest(root: string, runId: string): Promise<AstraManifest> {
  return parseAstraManifest(JSON.parse((await readAstraFile(root, runId, ASTRA_MANIFEST)).toString('utf8')), runId)
}

export async function publishedAstraFile(req: Request, runId: string, relative: string): Promise<Buffer> {
  const root = authorizeAstraRun(req, runId)
  if (metadata.has(relative)) return readAstraFile(root, runId, relative)
  const manifest = await readAstraManifest(root, runId)
  const entry = manifest.artifacts.find(item => item.path === relative)
  if (!entry) throw new AstraError('policy', 'The requested native artifact is not published.')
  const buffer = await readAstraFile(root, runId, relative)
  if (buffer.length !== entry.bytes || createHash('sha256').update(buffer).digest('hex') !== entry.sha256) throw new AstraError('output', 'Native artifact integrity check failed.')
  return buffer
}
