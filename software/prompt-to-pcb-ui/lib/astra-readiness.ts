import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { astraWorkspace } from './astra-beta'
import { AstraError } from './astra-execution'
import { ASTRA_CATALOG } from './astra-local-parts'
import nativePins from './astra-native-pins.json'
import { ASTRA_VALIDATOR_IMAGE, validateAstraRuntimeEvidence } from './astra-validator-evidence'
import { astraGroundConnected } from './astra-ground-evidence'
import { validateAstraProjectPolicy, expectedAstraFootprintTable } from './astra-project-policy'
import { validateAstraGlb } from './astra-export-evidence'

// No probe, executable, network request, or environment override belongs here.
const TTL = 24 * 60 * 60 * 1000
const RECEIPT = 'astra-readiness.json'
export const ASTRA_READINESS_SOURCES = Object.freeze([
  'lib/astra-readiness.ts', 'lib/astra-native.ts', 'lib/astra-native-tools.ts', 'lib/astra-native-pins.json',
  'lib/astra-local-parts.ts', 'lib/astra-execution.ts', 'lib/astra-beta.ts', 'lib/astra-origin.ts', 'lib/astra-validator-client.ts',
  'lib/astra-project-policy.ts', 'lib/astra-drc.ts', 'lib/astra-validator-evidence.ts', 'lib/astra-validator-containment.ts', 'lib/astra-export-evidence.ts', 'lib/astra-ground-evidence.ts', 'lib/astra-catalog.json',
  'scripts/astra-native.py', 'scripts/astra-sandbox-probe.py', 'scripts/astra-validator-controller.mjs',
  'scripts/astra-stage-validator.mjs', 'scripts/astra-linux-runtime.mjs', 'scripts/astra-linux-drc.mjs',
])
const PROCESS_FILES = ['prepare-process.json', 'route-process.json', 'import-process.json', 'finish-process.json', 'inspect-process.json',
  'render-top-process.json', 'render-bottom-process.json', 'svg-top-process.json', 'svg-bottom-process.json', 'glb-process.json'] as const
const GUARD_FILES = ['render-top-hash-guard.json', 'render-bottom-hash-guard.json', 'svg-top-hash-guard.json', 'svg-bottom-hash-guard.json', 'glb-hash-guard.json'] as const
const PHASE_GUARDS = ['prepare-postexit-policy.json', 'route-continued-postexit-policy.json', 'import-continued-postexit-policy.json', 'finish-continued-postexit-policy.json', 'inspect-continued-postexit-policy.json'] as const
export const ASTRA_QUALIFICATION_FILES = Object.freeze({
  ...Object.fromEntries(PROCESS_FILES.map(name => [name, 2 * 1024 * 1024])),
  ...Object.fromEntries(GUARD_FILES.map(name => [name, 64 * 1024])),
  ...Object.fromEntries(PHASE_GUARDS.map(name => [name, 64 * 1024])),
  'prepared-evidence.json': 2 * 1024 * 1024, 'import-evidence.json': 2 * 1024 * 1024,
  'native-tools.json': 128 * 1024, 'continued-native-tools.json': 128 * 1024, 'export-tools.json': 128 * 1024,
  'native-test-provenance.json': 64 * 1024, 'export-source-provenance.json': 64 * 1024,
  'export-inspection.json': 256 * 1024, 'fill-evidence.json': 2 * 1024 * 1024,
  'native-input.json': 1024 * 1024, 'native-evidence.json': 2 * 1024 * 1024,
  'final-board.kicad_pcb': 16 * 1024 * 1024, 'final-board.kicad_pro': 1024 * 1024,
  'fp-lib-table': 64 * 1024, 'linux-authorization.json': 256 * 1024,
  'linux-runtime-receipt.json': 4 * 1024 * 1024, 'drc.json': 4 * 1024 * 1024,
  'top.png': 16 * 1024 * 1024, 'bottom.png': 16 * 1024 * 1024,
  'top.svg': 8 * 1024 * 1024, 'bottom.svg': 8 * 1024 * 1024, 'board.glb': 64 * 1024 * 1024,
})
type RecordValue = Record<string, unknown>
const object = (x: unknown): x is RecordValue => !!x && typeof x === 'object' && !Array.isArray(x)
const sha = (x: Uint8Array | string) => createHash('sha256').update(x).digest('hex')
const canonical = (x: unknown): string => JSON.stringify(x, (_key, value) => object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new AstraError('policy', 'Native qualification evidence is missing, stale, changed, or incomplete.')
}
const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
const json = (bytes: Buffer): RecordValue => { const value: unknown = JSON.parse(bytes.toString('utf8')); requireValid(object(value)); return value }
const exactHashes = (x: unknown, names: readonly string[]): x is Record<string, string> => object(x)
  && Object.keys(x).length === names.length && names.every(name => Object.hasOwn(x, name) && digest(x[name]))
function date(x: unknown): number { requireValid(typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(x)); const ms = Date.parse(x); requireValid(Number.isFinite(ms)); return ms }
async function directory(name: string, privateDirectory = true) {
  requireValid(path.isAbsolute(name) && path.resolve(name) === name)
  const stat = await fs.lstat(name)
  requireValid(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid!() && !(stat.mode & (privateDirectory ? 0o077 : 0o022)) && await fs.realpath(name) === name)
  return stat
}
async function read(name: string, limit: number, privateFile = true): Promise<Buffer> {
  requireValid(await fs.realpath(name) === name)
  const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    requireValid(before.isFile() && before.nlink === 1 && (privateFile ? before.uid === process.getuid!() : [0, process.getuid!()].includes(before.uid))
      && !(before.mode & (privateFile ? 0o077 : 0o022)) && before.size > 0 && before.size <= limit)
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead }
    const after = await handle.stat(), current = await fs.lstat(name)
    requireValid(offset === before.size && current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.dev === before.dev && current.ino === before.ino
      && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && await fs.realpath(name) === name)
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}
async function hashFile(name: string, limit: number): Promise<string> {
  // Executables may be large: hash bounded chunks rather than retain their bytes.
  requireValid(await fs.realpath(name) === name)
  const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    requireValid(before.isFile() && before.nlink === 1 && [0, process.getuid!()].includes(before.uid) && !(before.mode & 0o022) && before.size > 0 && before.size <= limit)
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    let offset = 0
    while (offset <= before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size + 1 - offset), offset)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
    }
    const after = await handle.stat(), current = await fs.lstat(name)
    requireValid(offset === before.size && current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.dev === before.dev && current.ino === before.ino
      && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && await fs.realpath(name) === name)
    return hash.digest('hex')
  } finally { await handle.close() }
}
function views(files: Record<string, Buffer>) {
  for (const side of ['top', 'bottom']) {
    requireValid(files[`${side}.png`].subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    const svg = files[`${side}.svg`].toString('utf8')
    requireValid(/<svg[\s>]/i.test(svg) && !/<\s*(script|foreignObject|iframe|image|use)\b|\bon\w+\s*=|\b(?:href|src)\s*=|<!ENTITY|url\s*\(/i.test(svg))
  }
}
function historicalChain(files: Record<string, Buffer>, native: RecordValue) {
  const prepared = json(files['prepared-evidence.json']), imported = json(files['import-evidence.json']), filled = json(files['fill-evidence.json'])
  const stages = [[prepared, 'prepared'], [imported, 'imported'], [filled, 'filled']] as const
  for (const [evidence, stage] of stages) requireValid(evidence.version === 1 && evidence.stage === stage
    && evidence.inputSha256 === sha(files['native-input.json']) && evidence.tableSha256 === sha(files['fp-lib-table']))
  requireValid(prepared.routeAttempts === 0 && digest(prepared.boardSha256) && digest(prepared.projectSha256) && digest(prepared.dsnSha256)
    && digest(imported.importedBoardSha256) && digest(imported.importedProjectSha256) && digest(imported.sesSha256))
  for (const evidence of [imported, filled, native]) {
    requireValid(evidence.preparedBoardSha256 === prepared.boardSha256 && evidence.preparedProjectSha256 === prepared.projectSha256
      && evidence.dsnSha256 === prepared.dsnSha256 && evidence.sesSha256 === imported.sesSha256)
  }
  requireValid(filled.importedBoardSha256 === imported.importedBoardSha256 && filled.importedProjectSha256 === imported.importedProjectSha256
    && filled.boardSha256 === sha(files['final-board.kicad_pcb']) && filled.projectSha256 === sha(files['final-board.kicad_pro'])
    && native.reservedCopperPreserved === true && Array.isArray(prepared.reservedCopper) && prepared.reservedCopper.length > 0
    && canonical(prepared.reservedCopper) === canonical(native.reservedCopper) && object(prepared.identity) && canonical(prepared.identity) === canonical(native.identity))
  const projects: Record<string, unknown> = { 'board.kicad_pro': prepared.projectSha256 }
  for (let i = 0; i < PHASE_GUARDS.length; i++) {
    if (i === 2) projects['imported-board.kicad_pro'] = imported.importedProjectSha256
    if (i === 3) projects['final-board.kicad_pro'] = filled.projectSha256
    const guard = json(files[PHASE_GUARDS[i]])
    requireValid(guard.verified === true && guard.tableSha256 === sha(files['fp-lib-table']) && canonical(guard.projects) === canonical(projects))
  }
}
function historicalTools(value: RecordValue) {
  const required = ['python-version', 'pcbnew', 'kicad-version', 'router-help', 'render-help', 'glb-help', 'svg-help', 'drc-help']
  requireValid(value.schema === 'astra-native-tools/v1' && value.platform === 'darwin' && value.containment === 'verified'
    && Array.isArray(value.capabilities) && canonical([...value.capabilities].sort()) === canonical([...required].sort())
    && object(value.tools) && Object.keys(value.tools).length === Object.keys(nativePins.tools).length && object(value.scripts)
    && canonical(value.assetRoots) === canonical(nativePins.assetRoots))
  for (const [name, pin] of Object.entries(nativePins.tools)) {
    const tool = value.tools[name]
    requireValid(object(tool) && tool.path === ('canonicalPath' in pin ? pin.canonicalPath : pin.path) && tool.sha256 === pin.sha256)
  }
  for (const [name, expected] of Object.entries(nativePins.scripts)) {
    const script = value.scripts[name]
    requireValid(object(script) && typeof script.path === 'string' && path.isAbsolute(script.path) && script.sha256 === expected)
  }
}
async function currentPins(root: string, sourceHashes: unknown) {
  requireValid(exactHashes(sourceHashes, ASTRA_READINESS_SOURCES))
  for (const name of ASTRA_READINESS_SOURCES) requireValid(await hashFile(path.join(root, name), 8 * 1024 * 1024) === sourceHashes[name])
  requireValid(sourceHashes['scripts/astra-native.py'] === nativePins.scripts.native && sourceHashes['scripts/astra-sandbox-probe.py'] === nativePins.scripts.probe)
  for (const pin of Object.values(nativePins.tools)) {
    const target = 'canonicalPath' in pin ? pin.canonicalPath : pin.path
    requireValid(await fs.realpath(pin.path) === target && await hashFile(target, 256 * 1024 * 1024) === pin.sha256)
  }
  for (const pin of Object.values(nativePins.libraries)) requireValid(await hashFile(pin.path, 256 * 1024 * 1024) === pin.sha256)
  for (const asset of Object.values(ASTRA_CATALOG.assets)) {
    for (const pin of [asset.footprint, ...asset.models]) requireValid(await hashFile(pin.path, 64 * 1024 * 1024) === pin.sha256)
  }
}
interface VerifiedState { bundleRoot: string; indexHash: string; qualifiedAt: string; expiresAt: string; warnings: number; root: string; home: string }
declare const verifiedBrand: unique symbol
export type VerifiedQualification = Readonly<{ [verifiedBrand]: true }>
const capabilities = new WeakMap<VerifiedQualification, VerifiedState>()
async function verify(bundleRoot: string): Promise<VerifiedState> {
  const { root, home } = astraWorkspace()
  const base = path.join(home, 'qualifications')
  requireValid(path.dirname(bundleRoot) === base && /^[a-z0-9][a-z0-9-]{7,63}$/.test(path.basename(bundleRoot)))
  await directory(home); await directory(base)
  const snapshot = await directory(bundleRoot)
  const indexBytes = await read(path.join(bundleRoot, 'qualification.json'), 256 * 1024), index = json(indexBytes)
  requireValid(index.version === 1 && index.qualificationScope === 'native-backend' && index.provenanceTrust === 'operator-assembled-local-evidence' && index.sourceHashesRole === 'current-verifier-baseline')
  const qualified = date(index.qualifiedAt), now = Date.now()
  requireValid(qualified <= now && now - qualified < TTL)
  const names = Object.keys(ASTRA_QUALIFICATION_FILES)
  requireValid(exactHashes(index.files, names))
  await currentPins(root, index.sourceHashes)
  const files: Record<string, Buffer> = {}
  for (const [name, limit] of Object.entries(ASTRA_QUALIFICATION_FILES)) {
    files[name] = await read(path.join(bundleRoot, name), limit)
    requireValid(sha(files[name]) === index.files[name])
  }
  for (const name of PROCESS_FILES) {
    const processResult = json(files[name])
    requireValid(processResult.code === 0 && typeof processResult.stdout === 'string' && typeof processResult.stderr === 'string'
      && (processResult.signal === undefined || processResult.signal === null) && (processResult.reason === undefined || processResult.reason === null)
      && Object.keys(processResult).every(key => ['code', 'stdout', 'stderr', 'signal', 'reason'].includes(key)))
  }
  historicalTools(json(files['native-tools.json']))
  historicalTools(json(files['continued-native-tools.json']))
  historicalTools(json(files['export-tools.json']))
  const provenance = json(files['native-test-provenance.json'])
  requireValid(provenance.sourceSha256 === nativePins.scripts.native && provenance.inputSha256 === sha(files['native-input.json']) && provenance.maximumRouteAttempts === 1)
  const sourceNames = ['final-board.kicad_pcb', 'final-board.kicad_pro', 'native-input.json', 'native-evidence.json', 'fill-evidence.json', 'fp-lib-table']
  const sourceHashes = Object.fromEntries(sourceNames.map(name => [name, sha(files[name])]))
  requireValid(canonical(json(files['export-source-provenance.json']).sourceSha256) === canonical(sourceHashes))
  for (const name of GUARD_FILES) {
    const guard = json(files[name])
    requireValid(guard.verified === true && canonical(guard.sourceSha256) === canonical(sourceHashes))
  }
  const inspection = json(files['export-inspection.json'])
  requireValid(inspection.schema === 'native-export-inspection/v1' && inspection.sourceBoardSha256 === sha(files['final-board.kicad_pcb']) && inspection.glbSha256 === sha(files['board.glb']))
  const input = json(files['native-input.json']), evidence = json(files['native-evidence.json'])
  requireValid(evidence.version === 1 && evidence.stage === 'finished' && evidence.routeAttempts === 1 && evidence.identityPreserved === true
    && evidence.inputSha256 === sha(files['native-input.json']) && evidence.boardSha256 === sha(files['final-board.kicad_pcb'])
    && evidence.projectSha256 === sha(files['final-board.kicad_pro']) && evidence.tableSha256 === sha(files['fp-lib-table'])
    && canonical(input.catalog) === canonical(ASTRA_CATALOG.assets) && object(evidence.connectivity) && evidence.connectivity.available === true && evidence.connectivity.unrouted === 0)
  historicalChain(files, evidence)
  requireValid(astraGroundConnected(evidence.groundConnectivity))
  validateAstraProjectPolicy(json(files['final-board.kicad_pro']))
  requireValid(files['fp-lib-table'].toString('utf8') === expectedAstraFootprintTable())
  const auth = json(files['linux-authorization.json']), receipt = json(files['linux-runtime-receipt.json'])
  requireValid(auth.schema === 'astra-linux-job/v1' && receipt.schema === 'astra-linux-job-runtime/v1' && receipt.jobId === auth.jobId
    && typeof auth.jobId === 'string' && /^astra-linux-job-[a-z0-9]{8,32}$/.test(auth.jobId)
    && auth.image === ASTRA_VALIDATOR_IMAGE && receipt.image === auth.image
    && receipt.authorizationSha256 === sha(files['linux-authorization.json']) && receipt.reportSha256 === sha(files['drc.json'])
    && object(index.sourceHashes) && receipt.controllerSha256 === index.sourceHashes['scripts/astra-linux-runtime.mjs'])
  for (const [field, name] of Object.entries({ boardSha256: 'final-board.kicad_pcb', nativeInputSha256: 'native-input.json', nativeEvidenceSha256: 'native-evidence.json' })) {
    requireValid(auth[field] === sha(files[name]) && receipt[field] === auth[field])
  }
  requireValid(auth.catalogSha256 === index.sourceHashes['lib/astra-catalog.json'] && receipt.catalogSha256 === auth.catalogSha256)
  requireValid(object(auth.inputHashes))
  for (const name of ['final-board.kicad_pcb', 'final-board.kicad_pro', 'fp-lib-table']) requireValid(auth.inputHashes[name] === sha(files[name]))
  requireValid(Object.keys(auth.inputHashes).length === 3)
  const expectedAssets = Object.fromEntries(Object.values(ASTRA_CATALOG.assets).flatMap(asset => [asset.footprint, ...asset.models]).map(pin => [path.relative('/Applications/KiCad/KiCad.app/Contents/SharedSupport', pin.path), pin.sha256]))
  requireValid(canonical(auth.assetHashes) === canonical(expectedAssets))
  requireValid(canonical(auth.policy) === canonical({ schematicParity: 'not-run', includedSeverities: ['error', 'warning', 'exclusion'], ignoredChecksAllowed: false, excludedAllowed: false }))
  const { parsed: drc } = validateAstraRuntimeEvidence(receipt, files['drc.json'].toString('utf8'), {
    board: files['final-board.kicad_pcb'], input: files['native-input.json'].toString('utf8'), evidence: files['native-evidence.json'],
  })
  requireValid(receipt.boardPassed === true && canonical(receipt.nativeConnectivity) === canonical(evidence.connectivity)
    && canonical(receipt.groundConnectivity) === canonical(evidence.groundConnectivity))
  const executedAt = date(receipt.finishedAt)
  requireValid(date(receipt.startedAt) <= executedAt && executedAt <= qualified && now - executedAt < TTL)
  requireValid(drc.passed && drc.checksComplete && drc.errors === 0 && drc.unrouted === 0 && canonical(receipt.findings) === canonical(drc))
  views(files)
  validateAstraGlb(files['board.glb'], { nativeEvidence: evidence, catalog: ASTRA_CATALOG, boardText: files['final-board.kicad_pcb'].toString('utf8'), engineVersion: '10.0.1' })
  // Recheck the complete snapshot after validators finish. A late mutation of
  // already-read evidence must not produce a capability for mixed generations.
  for (const [name, limit] of Object.entries(ASTRA_QUALIFICATION_FILES)) requireValid(await hashFile(path.join(bundleRoot, name), limit) === index.files[name])
  const after = await directory(bundleRoot)
  requireValid(after.dev === snapshot.dev && after.ino === snapshot.ino && sha(await read(path.join(bundleRoot, 'qualification.json'), 256 * 1024)) === sha(indexBytes))
  return { bundleRoot, indexHash: sha(indexBytes), qualifiedAt: new Date(qualified).toISOString(), expiresAt: new Date(executedAt + TTL).toISOString(), warnings: drc.warnings, root, home }
}
/** Explicit qualification action only. Verifies existing real outputs; never executes or manufactures them. */
export async function verifyAstraQualification(bundleRoot: string): Promise<VerifiedQualification> {
  const state = await verify(bundleRoot), capability = Object.freeze({}) as VerifiedQualification
  capabilities.set(capability, state)
  return capability
}
/** Only a single-use in-process verified capability may publish readiness. */
export async function publishAstraReadiness(capability: VerifiedQualification): Promise<void> {
  const saved = capabilities.get(capability)
  requireValid(saved)
  capabilities.delete(capability)
  const current = await verify(saved.bundleRoot)
  requireValid(canonical(current) === canonical(saved))
  const destination = path.join(saved.home, RECEIPT)
  let previousHash: string | undefined
  try {
    const previousBytes = await read(destination, 64 * 1024), previous = json(previousBytes)
    requireValid(previous.version === 1 && previous.qualificationScope === 'native-backend' && previous.sourceHashesRole === 'current-verifier-baseline'
      && previous.root === saved.root && previous.home === saved.home && typeof previous.bundleRoot === 'string'
      && path.dirname(previous.bundleRoot) === path.join(saved.home, 'qualifications') && digest(previous.indexHash))
    previousHash = sha(previousBytes)
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  const pending = path.join(saved.home, `.astra-readiness-${randomUUID()}.pending.json`)
  const homeSnapshot = await directory(saved.home)
  let created = false
  try {
    await fs.writeFile(pending, JSON.stringify({ version: 1, qualificationScope: 'native-backend', provenanceTrust: 'operator-assembled-local-evidence', sourceHashesRole: 'current-verifier-baseline', ...saved }), { flag: 'wx', mode: 0o600 })
    created = true
    const currentHome = await directory(saved.home)
    requireValid(currentHome.dev === homeSnapshot.dev && currentHome.ino === homeSnapshot.ino)
    if (previousHash !== undefined) {
      requireValid(sha(await read(destination, 64 * 1024)) === previousHash)
    } else {
      let absent = false
      try { await fs.lstat(destination) } catch (error) { absent = error instanceof Error && 'code' in error && error.code === 'ENOENT' }
      requireValid(absent)
    }
    await fs.rename(pending, destination)
    created = false
  } finally { if (created) await fs.rm(pending, { force: true }) }
}
export type AstraReadinessStatus = { ready: false; reason: string } | { ready: true; qualificationScope: 'native-backend'; applicationIntegrationVerified: false; qualifiedAt: string; expiresAt: string; warnings: number; physicalFunctionVerified: false }
/** Read-only status/preflight path. Hash drift, missing files, or expiry block readiness. */
export async function readAstraReadiness(): Promise<AstraReadinessStatus> {
  try {
    const { root, home } = astraWorkspace()
    await directory(home)
    const receipt = json(await read(path.join(home, RECEIPT), 64 * 1024))
    requireValid(receipt.version === 1 && receipt.root === root && receipt.home === home && typeof receipt.bundleRoot === 'string' && Date.now() < date(receipt.expiresAt))
    const current = await verify(receipt.bundleRoot)
    requireValid(canonical(receipt) === canonical({ version: 1, qualificationScope: 'native-backend', provenanceTrust: 'operator-assembled-local-evidence', sourceHashesRole: 'current-verifier-baseline', ...current }))
    return { ready: true, qualificationScope: 'native-backend', applicationIntegrationVerified: false, qualifiedAt: current.qualifiedAt, expiresAt: current.expiresAt, warnings: current.warnings, physicalFunctionVerified: false }
  } catch { return { ready: false, reason: 'Native qualification is unavailable, stale, changed, or incomplete. Run explicit qualification; no automatic native execution was started.' } }
}
