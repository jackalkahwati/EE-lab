/**
 * Pure, bounded validation of the qualified KiCad 10.0.1 / OCCT GLB exporter.
 * Not a general glTF loader or STEP-geometry equivalence proof. The caller must
 * hash-bind boardText/nativeEvidence/catalog assets to the reviewed invocation.
 * Independent coordinate/datum sources, pinned to the generating engine:
 * https://github.com/KiCad/kicad-source-mirror/blob/10.0.1/pcbnew/exporters/step/step_pcb_model.cpp
 * https://github.com/KiCad/kicad-source-mirror/blob/10.0.1/pcbnew/board_stackup_manager/board_stackup.cpp
 * getModelLocation: native XY -> glTF X/Z, +Z model height -> glTF +Y;
 * BOARD_OFFSET=.05mm. Default 2-Cu stackup subtracts 2*.035 Cu + 2*.01 mask
 * from board thickness; component elevation adds top Cu .035 and offset .05.
 */
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)
function requireExport(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Native GLB evidence invalid: ${reason}`) }
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const vector = (x: unknown, n: number): x is number[] => Array.isArray(x) && x.length === n && x.every(finite)
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const matrixIdentity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function multiply(a: number[], b: number[]) {
  return Array.from({ length: 16 }, (_, i) => { const r = i % 4, c = Math.floor(i / 4); let v = 0; for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k]; return v })
}
function transform(node: Record<string, any>): number[] {
  if (node.matrix !== undefined) {
    requireExport(node.translation === undefined && node.rotation === undefined && node.scale === undefined && vector(node.matrix, 16), 'matrix and TRS are exclusive')
    requireExport(node.matrix[3] === 0 && node.matrix[7] === 0 && node.matrix[11] === 0 && node.matrix[15] === 1, 'non-affine transform')
    return node.matrix
  }
  const t = node.translation ?? [0, 0, 0], q = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1]
  requireExport(vector(t, 3) && vector(q, 4) && vector(s, 3) && s.every(v => v > 0) && Math.abs(q.reduce((a, v) => a + v * v, 0) - 1) < 1e-8, 'invalid finite normalized TRS')
  const [x, y, z, w] = q
  return [(1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0, ...t, 1]
}

/** Strict S-expression header reader: never derive stackup height from the GLB. */
export function deriveAstraModelBaseMm(boardText: string): number {
  requireExport(typeof boardText === 'string' && boardText.length > 0 && boardText.length <= 16 * 1024 * 1024, 'bounded board text required')
  const tokens = boardText.match(/"(?:\\.|[^"\\])*"|\(|\)|[^\s()]+/g) ?? []
  let at = 0
  const read = (depth: number): any => {
    requireExport(depth <= 64 && at < tokens.length, 'board syntax depth/truncation')
    const token = tokens[at++]
    if (token !== '(') { requireExport(token !== ')', 'unexpected closing token'); return token.startsWith('"') ? JSON.parse(token) : token }
    const result = []
    while (at < tokens.length && tokens[at] !== ')') result.push(read(depth + 1))
    requireExport(tokens[at++] === ')', 'unclosed board expression')
    return result
  }
  const root = read(0)
  requireExport(at === tokens.length && Array.isArray(root) && root[0] === 'kicad_pcb', 'native board root')
  const one = (node: any[], key: string) => { const hits = node.filter(x => Array.isArray(x) && x[0] === key); requireExport(hits.length === 1, `exact board ${key} required`); return hits[0] }
  const thickness = Number(one(one(root, 'general'), 'thickness')[1]), layers = one(root, 'layers'), setup = one(root, 'setup')
  requireExport(Number.isFinite(thickness) && thickness >= 0.4 && thickness <= 3.2, 'qualified board thickness')
  requireExport(!setup.some((x: any) => Array.isArray(x) && x[0] === 'stackup'), 'explicit stackup is not qualified')
  const names = layers.slice(1).map((x: any) => x[1])
  requireExport(equal(names.filter((x: string) => typeof x === 'string' && /\.Cu$/.test(x)).sort(), ['B.Cu', 'F.Cu']) && names.includes('F.Mask') && names.includes('B.Mask'), 'default two-copper/two-mask stackup required')
  return thickness - 2 * 0.035 - 2 * 0.01 + 0.035 + 0.05
}

export interface AstraGlbEvidence {
  version: 1; engineVersion: '10.0.1'; componentCount: 6; componentRefs: string[];
  meshCount: number; triangleCount: number; modelBaseMm: number; identityPreserved: true
}
export function validateAstraGlb(bytes: Uint8Array, context: { nativeEvidence: unknown; catalog: unknown; boardText: string; engineVersion: '10.0.1' }): AstraGlbEvidence {
  requireExport(context.engineVersion === '10.0.1' && bytes instanceof Uint8Array && bytes.byteLength >= 28 && bytes.byteLength <= 64 * 1024 * 1024, 'qualified engine/bounded GLB required')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  requireExport(view.getUint32(0, true) === 0x46546c67 && view.getUint32(4, true) === 2 && view.getUint32(8, true) === bytes.byteLength, 'GLB header')
  const jsonLength = view.getUint32(12, true), binHeader = 20 + jsonLength
  requireExport(jsonLength > 0 && jsonLength % 4 === 0 && binHeader + 8 <= bytes.byteLength && view.getUint32(16, true) === 0x4e4f534a, 'JSON chunk')
  const binLength = view.getUint32(binHeader, true), binStart = binHeader + 8
  requireExport(view.getUint32(binHeader + 4, true) === 0x004e4942 && binLength > 0 && binLength % 4 === 0 && binStart + binLength === bytes.byteLength, 'single exact BIN chunk')
  const scene = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, binHeader)))
  requireExport(object(scene) && object(scene.asset) && scene.asset.version === '2.0' && scene.asset.extras?.generator === 'KiCad 10.0.1', 'export engine identity')
  requireExport(scene.extensions === undefined && scene.extensionsUsed === undefined && scene.extensionsRequired === undefined && scene.animations === undefined && scene.skins === undefined && scene.images === undefined && scene.textures === undefined, 'unsupported extensions/external resources')
  requireExport(Array.isArray(scene.buffers) && scene.buffers.length === 1 && object(scene.buffers[0]) && scene.buffers[0].uri === undefined && integer(scene.buffers[0].byteLength) && scene.buffers[0].byteLength > 0 && scene.buffers[0].byteLength <= binLength && binLength - scene.buffers[0].byteLength <= 3, 'embedded binary bounds')
  const bound = (name: string, max: number) => { requireExport(Array.isArray(scene[name]) && scene[name].length > 0 && scene[name].length <= max, `${name} bound`); return scene[name] as Record<string, any>[] }
  const views = bound('bufferViews', 10000), accessors = bound('accessors', 20000), meshes = bound('meshes', 256), nodes = bound('nodes', 256), materials = bound('materials', 256)
  for (const item of views) requireExport(object(item) && item.buffer === 0 && integer(item.byteOffset ?? 0) && integer(item.byteLength) && item.byteLength > 0 && (item.byteOffset ?? 0) + item.byteLength <= scene.buffers[0].byteLength && (item.byteStride === undefined || integer(item.byteStride) && item.byteStride >= 4 && item.byteStride <= 252 && item.byteStride % 4 === 0), 'bufferView bounds')
  for (const material of materials) {
    requireExport(object(material) && material.extensions === undefined, 'material extensions')
    const check = (x: unknown, depth = 0) => { requireExport(depth < 10, 'material depth'); if (object(x)) for (const [key, value] of Object.entries(x)) { requireExport(!/uri|texture/i.test(key), 'external material resource'); check(value, depth + 1) } else if (Array.isArray(x)) x.forEach(v => check(v, depth + 1)); else if (typeof x === 'number') requireExport(finite(x), 'nonfinite material') }
    check(material)
  }
  let decodedValues = 0
  const decoded = accessors.map(item => {
    requireExport(object(item) && integer(item.bufferView) && item.bufferView < views.length && integer(item.byteOffset ?? 0) && integer(item.count) && item.count > 0 && item.count <= 1000000 && item.sparse === undefined && item.normalized === undefined && item.extensions === undefined, 'accessor definition')
    const isVector = item.componentType === 5126 && item.type === 'VEC3', isIndex = item.componentType === 5123 && item.type === 'SCALAR'
    requireExport(isVector || isIndex, 'qualified accessor component/type')
    const size = isVector ? 12 : 2, alignment = isVector ? 4 : 2, bv = views[item.bufferView], stride = bv.byteStride ?? size, start = (bv.byteOffset ?? 0) + (item.byteOffset ?? 0)
    requireExport(stride >= size && start % alignment === 0 && (item.byteOffset ?? 0) + (item.count - 1) * stride + size <= bv.byteLength, 'accessor binary bounds')
    if (item.min !== undefined || item.max !== undefined) requireExport(vector(item.min, isVector ? 3 : 1) && vector(item.max, isVector ? 3 : 1) && item.min.every((v: number, i: number) => v <= item.max[i]), 'accessor extrema')
    decodedValues += item.count * (isVector ? 3 : 1)
    requireExport(decodedValues <= 2000000, 'aggregate decoded geometry bound')
    const values: number[][] = []
    for (let i = 0; i < item.count; i++) {
      const p = binStart + start + i * stride
      const tuple = isVector ? [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)] : [view.getUint16(p, true)]
      requireExport(tuple.every(finite), 'nonfinite binary geometry'); values.push(tuple)
    }
    return { values, isVector }
  })
  let triangleCount = 0
  const referencedAccessors = new Set<number>()
  for (const mesh of meshes) {
    requireExport(object(mesh) && typeof mesh.name === 'string' && Array.isArray(mesh.primitives) && mesh.primitives.length > 0 && mesh.primitives.length <= 10000 && mesh.weights === undefined && mesh.extensions === undefined, 'mesh geometry required')
    for (const primitive of mesh.primitives) {
      requireExport(object(primitive) && primitive.mode === 4 && object(primitive.attributes) && equal(Object.keys(primitive.attributes).sort(), ['NORMAL', 'POSITION']) && primitive.targets === undefined && primitive.extensions === undefined && integer(primitive.material) && primitive.material < materials.length, 'qualified triangle primitive')
      const ids = [primitive.attributes.POSITION, primitive.attributes.NORMAL, primitive.indices]
      requireExport(ids.every(id => integer(id) && id < accessors.length), 'primitive accessor reference')
      ids.forEach(id => referencedAccessors.add(id))
      const [positions, normals, indices] = ids.map(id => decoded[id])
      requireExport(positions.isVector && normals.isVector && !indices.isVector && positions.values.length === normals.values.length && indices.values.length % 3 === 0 && indices.values.every(index => index[0] < positions.values.length), 'indexed triangles bounds')
      let nondegenerate = false
      for (let i = 0; i < indices.values.length; i += 3) {
        const [a, b, c] = indices.values.slice(i, i + 3).map(index => positions.values[index[0]])
        const u = b.map((v, j) => v - a[j]), v = c.map((value, j) => value - a[j])
        const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        if (cross.some(value => value !== 0)) nondegenerate = true
      }
      requireExport(nondegenerate, 'primitive has no nondegenerate triangle')
      triangleCount += indices.values.length / 3
      requireExport(triangleCount <= 1000000, 'aggregate triangle bound')
    }
  }
  requireExport(referencedAccessors.size === accessors.length && triangleCount > 0, 'unreferenced accessor or empty triangles')
  requireExport(Array.isArray(scene.scenes) && scene.scenes.length === 1 && scene.scene === 0 && object(scene.scenes[0]) && Array.isArray(scene.scenes[0].nodes) && scene.scenes[0].nodes.length === 1, 'one selected scene root')
  const world = new Map<number, number[]>(), usedMeshes = new Set<number>()
  const visit = (id: number, parent: number[], depth: number) => {
    requireExport(integer(id) && id < nodes.length && !world.has(id) && depth < 32, 'node cycle/duplicate/unbounded graph')
    const node = nodes[id]; requireExport(object(node) && node.skin === undefined && node.camera === undefined && node.weights === undefined && node.extensions === undefined, 'unsupported node')
    const matrix = multiply(parent, transform(node)); requireExport(matrix.every(finite), 'nonfinite world transform'); world.set(id, matrix)
    if (node.mesh !== undefined) { requireExport(integer(node.mesh) && node.mesh < meshes.length, 'node mesh reference'); usedMeshes.add(node.mesh) }
    if (node.children !== undefined) { requireExport(Array.isArray(node.children), 'node children'); node.children.forEach(child => visit(child, matrix, depth + 1)) }
  }
  visit(scene.scenes[0].nodes[0], matrixIdentity(), 0)
  requireExport(world.size === nodes.length && usedMeshes.size === meshes.length, 'unreachable node/mesh')
  const catalog = context.catalog, native = context.nativeEvidence
  requireExport(object(catalog) && object(catalog.assets) && object(catalog.parts) && object(native) && native.version === 1 && native.stage === 'finished' && native.identityPreserved === true && native.routeAttempts === 1 && object(native.identity) && native.identity.layers === 2 && Array.isArray(native.identity.footprints), 'independent native evidence required')
  const refs = Object.keys(catalog.parts).sort()
  requireExport(equal(refs, ['C1', 'C2', 'J1', 'R1', 'R2', 'U1']) && native.identity.footprints.length === 6, 'exact six independent references')
  const nativeRefs = native.identity.footprints.map((fp: any) => fp.ref).sort(); requireExport(equal(nativeRefs, refs), 'duplicate/missing native reference')
  const base = deriveAstraModelBaseMm(context.boardText), found = new Set<string>()
  for (const [id, matrix] of world) {
    const node = nodes[id]
    if (node.mesh === undefined) { requireExport(node.name === undefined, 'unexpected named group'); continue }
    const mesh = meshes[node.mesh]
    if (!refs.includes(node.name)) {
      requireExport(typeof node.name === 'string' && /^=>\[0:1:1:\d+\]$/.test(node.name) && /^final-board_(?:copper|pad|via|silkscreen|soldermask|PCB)$/.test(mesh.name) && matrix.every((v, i) => Math.abs(v - matrixIdentity()[i]) < 1e-9), 'unknown component or moved board mesh')
      continue
    }
    requireExport(!found.has(node.name), 'duplicate component instance'); found.add(node.name)
    const fp = native.identity.footprints.find((item: any) => item.ref === node.name), asset = catalog.assets[catalog.parts[node.name].catalogId]
    requireExport(object(fp) && object(asset) && Array.isArray(asset.models) && asset.models.length === 1 && Array.isArray(fp.models) && fp.models.length === 1 && fp.layer === 0 && vector(fp.positionNm, 2) && finite(fp.rotationDeg), 'qualified front footprint/model required')
    const model = fp.models[0], pinned = asset.models[0]
    requireExport(object(model) && object(pinned) && model.path === pinned.path && vector(model.offsetMm, 3) && vector(pinned.offsetMm, 3) && model.offsetMm.every((v: number, i: number) => Math.abs(v - pinned.offsetMm[i]) <= 1e-8) && equal(model.scale, pinned.scale) && equal(model.rotationDeg, pinned.rotationDeg) && equal(model.scale, [1, 1, 1]) && equal(model.rotationDeg, [0, 0, 0]) && vector(model.offsetMm, 3) && model.show === true && model.opacity === 1, 'reviewed model identity/transform')
    requireExport(fp.footprintId === asset.footprint.libraryPath.split('/').at(-1).replace(/\.pretty$/, '') + ':' + asset.footprint.name && mesh.name === pinned.path.split('/').at(-1).replace(/\.step$/i, ''), 'catalog mesh/footprint name')
    const angle = fp.rotationDeg * Math.PI / 180, [ox, oy, oz] = model.offsetMm
    const expected = transform({ translation: [fp.positionNm[0] / 1e9 + (Math.cos(angle) * ox - Math.sin(angle) * oy) / 1000, (base + oz) / 1000, fp.positionNm[1] / 1e9 - (Math.sin(angle) * ox + Math.cos(angle) * oy) / 1000], rotation: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)] })
    requireExport(matrix.every((v, i) => Math.abs(v - expected[i]) <= (i >= 12 && i <= 14 ? 1e-8 : 1e-7)), `component ${node.name} world transform differs from native board`)
  }
  requireExport(found.size === 6 && meshes.some(mesh => mesh.name === 'final-board_PCB'), 'missing component or board geometry')
  return { version: 1, engineVersion: '10.0.1', componentCount: 6, componentRefs: [...found].sort(), meshCount: meshes.length, triangleCount, modelBaseMm: base, identityPreserved: true }
}
