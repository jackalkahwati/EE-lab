/** Hand-authored, Y-up, metre-scale test geometry. No exports, assets or network IO. */
export const MODEL_GLB_VARIANTS = Object.freeze(['A', 'B'])
export const MODEL_GLB_CONTENT_TYPE = 'model/gltf-binary'

/** Return a fresh Uint8Array containing one embedded-buffer GLB 2.0 model. */
export function createModelGlb(variant = 'A') {
  if (!MODEL_GLB_VARIANTS.includes(variant)) throw new RangeError('Synthetic model variant must be A or B')
  // Six separate cube faces preserve hard normals. CCW winding faces outward.
  const faces = [
    { n: [1, 0, 0], p: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
    { n: [-1, 0, 0], p: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
    { n: [0, 1, 0], p: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
    { n: [0, -1, 0], p: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
    { n: [0, 0, 1], p: [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]] },
    { n: [0, 0, -1], p: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
  ]
  const positions = faces.flatMap((face) => face.p.flat())
  const normals = faces.flatMap((face) => face.p.flatMap(() => face.n))
  const indices = faces.flatMap((_, i) => [0, 1, 2, 0, 2, 3].map((j) => i * 4 + j))
  const positionBytes = positions.length * 4
  const normalBytes = normals.length * 4
  const binary = new Uint8Array(positionBytes + normalBytes + indices.length * 2)
  const data = new DataView(binary.buffer)
  positions.forEach((v, i) => data.setFloat32(i * 4, v, true))
  normals.forEach((v, i) => data.setFloat32(positionBytes + i * 4, v, true))
  indices.forEach((v, i) => data.setUint16(positionBytes + normalBytes + i * 2, v, true))
  const isA = variant === 'A'
  const document = {
    asset: { version: '2.0', generator: 'FirstLight hand-authored synthetic viewer fixture' },
    scene: 0,
    scenes: [{ name: `Synthetic board ${variant}`, nodes: [0, 1, 2] }],
    nodes: [
      { name: `fixture-${variant}-board`, mesh: 0, scale: [isA ? 0.02 : 0.025, 0.0008, 0.015] },
      { name: `fixture-${variant}-component`, mesh: 1, translation: [isA ? 0.009 : -0.013, 0.0038, -0.005], scale: [0.004, 0.003, isA ? 0.004 : 0.007] },
      { name: `fixture-${variant}-underside-marker`, mesh: 2, translation: [isA ? -0.01 : 0.014, -0.0013, 0.007], scale: [0.0035, 0.0005, 0.002] },
    ],
    meshes: ['board', 'component', 'underside-marker'].map((name, material) => ({
      name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material, mode: 4 }],
    })),
    materials: [
      { name: 'soldermask', pbrMetallicRoughness: { baseColorFactor: isA ? [0.035, 0.32, 0.1, 1] : [0.035, 0.12, 0.65, 1], metallicFactor: 0, roughnessFactor: 0.65 } },
      { name: 'contrasting-component', pbrMetallicRoughness: { baseColorFactor: isA ? [1, 0.55, 0.04, 1] : [0.95, 0.18, 0.45, 1], metallicFactor: 0.1, roughnessFactor: 0.4 } },
      { name: 'underside-marker', pbrMetallicRoughness: { baseColorFactor: [0.95, 0.95, 0.92, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes, target: 34962 },
      { buffer: 0, byteOffset: positionBytes, byteLength: normalBytes, target: 34962 },
      { buffer: 0, byteOffset: positionBytes + normalBytes, byteLength: indices.length * 2, target: 34963 },
    ],
    buffers: [{ byteLength: binary.byteLength }],
    extras: { synthetic: true, variant, units: 'metres', up: 'Y' },
  }
  const json = new TextEncoder().encode(JSON.stringify(document))
  const jsonLength = (json.byteLength + 3) & ~3
  const binLength = (binary.byteLength + 3) & ~3
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binLength)
  const header = new DataView(bytes.buffer)
  header.setUint32(0, 0x46546c67, true)
  header.setUint32(4, 2, true)
  header.setUint32(8, bytes.byteLength, true)
  header.setUint32(12, jsonLength, true)
  header.setUint32(16, 0x4e4f534a, true)
  bytes.fill(0x20, 20, 20 + jsonLength)
  bytes.set(json, 20)
  header.setUint32(20 + jsonLength, binLength, true)
  header.setUint32(24 + jsonLength, 0x004e4942, true)
  bytes.set(binary, 28 + jsonLength)
  return bytes
}
