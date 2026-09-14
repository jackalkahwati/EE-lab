import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { AstraError, assertAstraActive, type AstraExecution } from './astra-execution'
import { astraWorkspace, blockAstraForUnconfirmedCleanup } from './astra-beta'
import { astraGroundConnected } from './astra-ground-evidence'
import { AstraValidatorError, validateAstraNativeJob } from './astra-validator-client'
import { validateAstraValidatorEvidence } from './astra-validator-evidence'
import { validateAstraGlb } from './astra-export-evidence'
export { astraGroundConnected } from './astra-ground-evidence'
import { expectedAstraFootprintTable, validateAstraProjectPolicy } from './astra-project-policy'
import { ASTRA_CATALOG, type AstraValidatedNetlist } from './astra-local-parts'
import { ASTRA_MANIFEST, ASTRA_OUTPUTS, parseAstraManifest, type AstraManifest, type AstraArtifactName } from './astra-artifacts'
import { astraNativeToolManifest, createAstraNativeTools, inspectAstraNativeReadiness, runAstraNativeTool, type AstraNativeTools } from './astra-native-tools'

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const probes = ['containment', 'kicad-version', 'python-version', 'pcbnew', 'router-help', 'render-help', 'glb-help', 'svg-help', 'drc-help'] as const
const files: Record<AstraArtifactName, string> = {
  'electronics/chipscale-board.json': 'chipscale-board.json',
  'electronics/chipscale.kicad_pcb': 'final-board.kicad_pcb',
  'electronics/netlist.json': 'proposal.json',
  'electronics/native-evidence.json': 'native-evidence.json',
  'electronics/drc.json': 'drc.json',
  'electronics/chipscale.svg': 'top.svg',
  'electronics/layer-top.svg': 'top.svg',
  'electronics/layer-bottom.svg': 'bottom.svg',
  'board/render-top.png': 'top.png',
  'board/render-bottom.png': 'bottom.png',
  'board/chipscale.glb': 'board.glb',
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

async function jobFile(job: string, name: string, maxBytes: number): Promise<Buffer> {
  const file = path.join(job, name)
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > maxBytes) throw new AstraError('output', 'Native output size is invalid.')
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await handle.stat()
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new AstraError('output', 'Native output changed during validation.')
    return buffer.subarray(0, length)
  } finally { await handle.close() }
}

async function verifyProjectAfterExit(job: string, projectName: string, evidenceName: string, hashField: string) {
  const evidence: unknown = JSON.parse((await jobFile(job, evidenceName, 2 * 1024 * 1024)).toString('utf8'))
  const project = await jobFile(job, projectName, 1024 * 1024)
  const table = await jobFile(job, 'fp-lib-table', 64 * 1024)
  validateAstraProjectPolicy(JSON.parse(project.toString('utf8')))
  if (!record(evidence) || evidence[hashField] !== sha256(project) || evidence.tableSha256 !== sha256(table)
    || table.toString('utf8') !== expectedAstraFootprintTable()) throw new AstraError('output', 'Native project or library table changed after process exit.')
  return { project, table }
}

function validateView(name: string, bytes: Buffer) {
  if (name.endsWith('.png') && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new AstraError('output', 'Native render is not a PNG.')
  if (name.endsWith('.svg')) {
    const text = bytes.toString('utf8')
    if (!/<svg[\s>]/i.test(text) || /<\s*(script|foreignObject|iframe|image|use)\b|\bon\w+\s*=|\b(?:href|src)\s*=|<!ENTITY|url\s*\(/i.test(text)) throw new AstraError('output', 'Native SVG contains unsupported active or external content.')
  }
  if (name.endsWith('.glb')) {
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length
      || bytes.readUInt32LE(16) !== 0x4e4f534a || bytes.readUInt32LE(12) > bytes.length - 20) throw new AstraError('output', 'Native GLB is invalid.')
    const scene: unknown = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'))
    if (!record(scene) || !Array.isArray(scene.meshes) || !scene.meshes.length) throw new AstraError('output', 'Native GLB has no geometry.')
    for (const field of ['buffers', 'images']) {
      if (scene[field] !== undefined && !Array.isArray(scene[field])) throw new AstraError('output', 'Native GLB resource table is invalid.')
      for (const resource of (scene[field] as unknown[] | undefined) ?? []) if (!record(resource) || resource.uri !== undefined) throw new AstraError('output', 'Native GLB must contain only embedded binary resources.')
    }
  }
}

export async function prepareAstraNativeJob(ctx: AstraExecution): Promise<AstraNativeTools> {
  assertAstraActive(ctx)
  const { root, home } = astraWorkspace()
  const jobs = path.join(home, 'native-jobs')
  await fs.mkdir(jobs, { mode: 0o700, recursive: true })
  if ((await fs.lstat(jobs)).isSymbolicLink() || await fs.realpath(jobs) !== jobs) throw new AstraError('policy', 'Native job storage is not isolated.')
  const job = await fs.mkdtemp(path.join(jobs, 'job-'))
  assertAstraActive(ctx)
  const tools = createAstraNativeTools({ jobRoot: job, scriptRoot: path.join(root, 'scripts') })
  for (const capability of probes) {
    await runAstraNativeTool(ctx, tools, { operation: 'probe', capability }, { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 })
    assertAstraActive(ctx)
  }
  if (!inspectAstraNativeReadiness(tools).ready) throw new AstraError('policy', 'Native capability checks did not pass.')
  return tools
}

/** Receives a validated model proposal, never manufactures a replacement netlist. */
export async function buildAstraNative(ctx: AstraExecution, runId: string, proposal: AstraValidatedNetlist, tools: AstraNativeTools) {
  assertAstraActive(ctx)
  const { root } = astraWorkspace()
  const runRoot = path.join(root, 'public/runs', runId)
  if (!/^run-[A-Za-z0-9._-]{1,123}$/.test(runId) || await fs.realpath(runRoot) !== runRoot) throw new AstraError('policy', 'Native run destination is invalid.')
  const proposalJson = JSON.stringify(proposal)
  const manifest: AstraManifest = {
    version: 1, runId, scope: 'electronics-only', status: 'unknown', native: true, routeAttempts: 0,
    createdAt: new Date().toISOString(), proposalSha256: sha256(proposalJson), tools: {},
    checks: { drcAvailable: false, drcErrors: null, unrouted: null, identityPreserved: false, exportsComplete: false }, artifacts: [],
  }
  const nativeTools = astraNativeToolManifest(tools)
  manifest.tools = Object.fromEntries(Object.entries(nativeTools.tools).map(([key, value]) => [key, value.sha256]))
  const job = tools.jobRoot
  const input = {
    version: 1,
    parts: proposal.parts.map(part => ({ ref: part.name, catalogId: part.catalogId, value: part.value })),
    catalog: ASTRA_CATALOG.assets,
    assetRoots: nativeTools.assetRoots,
    nets: proposal.canonicalNets.map(net => ({ name: net.name, pins: net.pins.map(pin => { const [ref, pad] = pin.split('.'); return { ref, pad } }) })),
    board: { widthMm: 24, heightMm: 18, layers: 2 },
  }
  const inputJson = JSON.stringify(input)
  const publishManifest = async () => {
    parseAstraManifest(manifest, runId)
    const pending = path.join(runRoot, '.astra-manifest.pending.json')
    await fs.writeFile(pending, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
    try { await fs.rename(pending, path.join(runRoot, ASTRA_MANIFEST)) }
    catch (error) { await fs.rm(pending, { force: true }); throw error }
  }
  try {
    await fs.writeFile(path.join(job, 'native-input.json'), inputJson, { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(job, 'proposal.json'), proposalJson, { flag: 'wx', mode: 0o600 })
    assertAstraActive(ctx)
    await runAstraNativeTool(ctx, tools, { operation: 'prepare' })
    await verifyProjectAfterExit(job, 'board.kicad_pro', 'prepared-evidence.json', 'projectSha256')
    manifest.routeAttempts = 1
    await runAstraNativeTool(ctx, tools, { operation: 'route' })
    await verifyProjectAfterExit(job, 'board.kicad_pro', 'prepared-evidence.json', 'projectSha256')
    await runAstraNativeTool(ctx, tools, { operation: 'import' })
    await verifyProjectAfterExit(job, 'imported-board.kicad_pro', 'import-evidence.json', 'importedProjectSha256')
    await runAstraNativeTool(ctx, tools, { operation: 'finish' })
    const policy = await verifyProjectAfterExit(job, 'final-board.kicad_pro', 'fill-evidence.json', 'projectSha256')
    await runAstraNativeTool(ctx, tools, { operation: 'inspect' })
    const inspectedPolicy = await verifyProjectAfterExit(job, 'final-board.kicad_pro', 'native-evidence.json', 'projectSha256')
    if (!policy.project.equals(inspectedPolicy.project) || !policy.table.equals(inspectedPolicy.table)) throw new AstraError('output', 'Native inspection changed project policy.')
    const board = await jobFile(job, 'final-board.kicad_pcb', ASTRA_OUTPUTS['electronics/chipscale.kicad_pcb'])
    const nativeBytes = await jobFile(job, 'native-evidence.json', 2 * 1024 * 1024)
    const native: unknown = JSON.parse(nativeBytes.toString('utf8'))
    if (!record(native) || native.version !== 1 || native.stage !== 'finished' || native.routeAttempts !== 1 || native.identityPreserved !== true
      || native.boardSha256 !== sha256(board) || native.inputSha256 !== sha256(inputJson)
      || !record(native.connectivity) || native.connectivity.available !== true || !count(native.connectivity.unrouted)) {
      throw new AstraError('output', 'Final native board identity or connectivity could not be verified.')
    }
    const groundConnected = astraGroundConnected(native.groundConnectivity)
    manifest.checks.identityPreserved = true
    manifest.checks.unrouted = native.connectivity.unrouted
    const validated = await validateAstraNativeJob({ jobId: path.basename(job), boardSha256: sha256(board), workflowId: ctx.id, signal: ctx.signal })
    assertAstraActive(ctx)
    const { bytes: drcBytes, parsed: drc } = validateAstraValidatorEvidence(validated, { jobId: path.basename(job), workflowId: ctx.id, board, input: inputJson, evidence: nativeBytes })
    await fs.writeFile(path.join(job, 'drc.json'), drcBytes, { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(job, 'validator-receipt.json'), JSON.stringify(validated.receipt), { flag: 'wx', mode: 0o600 })
    const checkedPolicy = await verifyProjectAfterExit(job, 'final-board.kicad_pro', 'native-evidence.json', 'projectSha256')
    if (!policy.project.equals(checkedPolicy.project) || !policy.table.equals(checkedPolicy.table)) throw new AstraError('output', 'Native DRC changed project policy.')
    manifest.checks.drcAvailable = true
    manifest.checks.drcErrors = drc.errors
    manifest.checks.unrouted = Math.max(drc.unrouted, native.connectivity.unrouted)
    for (const operation of [{ operation: 'render', side: 'top' }, { operation: 'render', side: 'bottom' }, { operation: 'svg', side: 'top' }, { operation: 'svg', side: 'bottom' }, { operation: 'glb' }] as const) {
      await runAstraNativeTool(ctx, tools, operation)
      assertAstraActive(ctx)
    }
    const result = { ok: drc.passed && manifest.checks.unrouted === 0 && groundConnected, groundConnected, components: proposal.parts.length,
      boardMm: { w: 24, h: 18 }, layers: 2, layersRequested: 2, drc,
      drcRepair: { unrouted: manifest.checks.unrouted, layers: 2 }, native: true, boardSource: 'astra-native',
      routedTraces: count(native.trackSegments) ? native.trackSegments : null, parts: proposal.parts.map(({ name, kind, mpn, value, footprint }) => ({ name, kind, mpn, value, footprint })) }
    await fs.writeFile(path.join(job, 'chipscale-board.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 })
    for (const directory of ['electronics', 'board']) await fs.mkdir(path.join(runRoot, directory), { mode: 0o700 })
    for (const [relative, source] of Object.entries(files) as [AstraArtifactName, string][]) {
      assertAstraActive(ctx)
      const bytes = await jobFile(job, source, ASTRA_OUTPUTS[relative])
      const validated = source === 'final-board.kicad_pcb' ? board : source === 'native-evidence.json' ? nativeBytes : source === 'proposal.json' ? Buffer.from(proposalJson) : source === 'drc.json' ? drcBytes : null
      if (validated && !bytes.equals(validated)) throw new AstraError('output', 'Native identity evidence changed before publication.')
      validateView(relative, bytes)
      if (relative === 'board/chipscale.glb') validateAstraGlb(bytes, { nativeEvidence: native, catalog: ASTRA_CATALOG, boardText: board.toString('utf8'), engineVersion: '10.0.1' })
      const destination = path.join(runRoot, relative)
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
      manifest.artifacts.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) })
    }
    const finalPolicy = await verifyProjectAfterExit(job, 'final-board.kicad_pro', 'native-evidence.json', 'projectSha256')
    if (!policy.project.equals(finalPolicy.project) || !policy.table.equals(finalPolicy.table)) throw new AstraError('output', 'Native export changed project policy.')
    manifest.checks.exportsComplete = true
    manifest.status = result.ok ? 'passed' : 'failed'
    assertAstraActive(ctx)
    await publishManifest()
    assertAstraActive(ctx)
    return result
  } catch (error) {
    if (error instanceof AstraValidatorError && !error.cleanupConfirmed) blockAstraForUnconfirmedCleanup(ctx)
    manifest.status = ctx.signal.aborted ? 'cancelled' : 'failed'
    // Do not leave a success marker when cancellation races final publication.
    manifest.checks.exportsComplete = false
    // Preserve already validated, hash-addressed partial outputs. Their presence
    // never overrides this failed/cancelled manifest or incomplete export gate.
    await fs.rm(path.join(runRoot, ASTRA_MANIFEST), { force: true }).catch(() => {})
    await publishManifest().catch(() => {})
    if (error instanceof AstraValidatorError && !error.cleanupConfirmed) throw new AstraError('policy', 'Native validator cleanup is unconfirmed. Further workflows are blocked until launcher teardown verifies the owned container state.')
    if (error instanceof AstraError) throw error
    throw new AstraError('process', 'Native board processing failed. No automatic retry was submitted.')
  }
}
