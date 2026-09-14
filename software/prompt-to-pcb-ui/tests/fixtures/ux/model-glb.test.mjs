import assert from 'node:assert/strict'
import test from 'node:test'
import { Box3, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createModelGlb, MODEL_GLB_VARIANTS, MODEL_GLB_CONTENT_TYPE } from './model-glb.mjs'

function unpack(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(0, true), 0x46546c67)
  assert.equal(view.getUint32(4, true), 2)
  assert.equal(view.getUint32(8, true), bytes.byteLength)
  const jsonLength = view.getUint32(12, true)
  assert.equal(jsonLength % 4, 0)
  assert.equal(view.getUint32(16, true), 0x4e4f534a)
  const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)))
  const binLength = view.getUint32(20 + jsonLength, true)
  assert.equal(view.getUint32(24 + jsonLength, true), 0x004e4942)
  assert.equal(28 + jsonLength + binLength, bytes.byteLength)
  assert.equal(binLength % 4, 0)
  return { doc, binary: new DataView(bytes.buffer, bytes.byteOffset + 28 + jsonLength, binLength) }
}

for (const variant of MODEL_GLB_VARIANTS) {
  test(`GLB ${variant}: bounded deterministic embedded binary, valid accessors and outward triangles`, () => {
    const bytes = createModelGlb(variant)
    assert.ok(bytes.length < 5000)
    assert.deepEqual(bytes, createModelGlb(variant))
    const { doc, binary } = unpack(bytes)
    assert.equal(doc.extras.synthetic, true)
    assert.equal(doc.extras.variant, variant)
    assert.equal(doc.buffers.length, 1)
    assert.equal(doc.buffers[0].byteLength, binary.byteLength)
    assert.equal(doc.buffers[0].uri, undefined)
    for (const key of ['images', 'textures', 'extensionsRequired', 'extensionsUsed']) assert.equal(doc[key], undefined)
    assert.equal(doc.nodes.length, 3)
    for (const view of doc.bufferViews) {
      assert.equal(view.byteOffset % 4, 0)
      assert.ok(view.byteOffset + view.byteLength <= binary.byteLength)
    }
    const vec = (accessor, index) => new Vector3(...[0, 1, 2].map((axis) => binary.getFloat32(doc.bufferViews[accessor].byteOffset + index * 12 + axis * 4, true)))
    for (let i = 0; i < 36; i += 3) {
      const indices = [0, 1, 2].map((j) => binary.getUint16(doc.bufferViews[2].byteOffset + (i + j) * 2, true))
      assert.ok(indices.every((index) => index < 24))
      const [a, b, c] = indices.map((index) => vec(0, index))
      const normal = b.sub(a).cross(c.sub(a)).normalize()
      assert.ok(normal.dot(vec(1, indices[0])) > 0.99)
    }
  })

  test(`GLB ${variant}: actual installed GLTFLoader parses board, raised component and underside without network`, async () => {
    const manager = new (await import('three')).LoadingManager()
    manager.setURLModifier((url) => { throw new Error(`Fixture attempted external resource: ${url}`) })
    const bytes = createModelGlb(variant)
    const gltf = await new GLTFLoader(manager).parseAsync(bytes.buffer, '')
    assert.equal(gltf.scene.children.length, 3)
    const [board, component, underside] = ['board', 'component', 'underside-marker'].map((name) => gltf.scene.getObjectByName(`fixture-${variant}-${name}`))
    assert.ok([board, component, underside].every((mesh) => mesh?.isMesh))
    const bounds = (object) => new Box3().setFromObject(object)
    assert.ok(bounds(component).min.y >= bounds(board).max.y - 1e-9)
    assert.ok(bounds(underside).max.y <= bounds(board).min.y + 1e-9)
    assert.notEqual(component.position.x, 0)
    assert.ok(bounds(board).getSize(new Vector3()).x < 0.1)
    assert.notDeepEqual(component.material.color, board.material.color)
    const resources = new Set()
    gltf.scene.traverse((object) => {
      if (object.geometry) resources.add(object.geometry)
      if (object.material) resources.add(object.material)
    })
    resources.forEach((resource) => resource.dispose())
  })
}

test('fixture interface returns independent A/B bytes and rejects unreviewed variants', () => {
  assert.equal(MODEL_GLB_CONTENT_TYPE, 'model/gltf-binary')
  const a = createModelGlb('A')
  const b = createModelGlb('B')
  assert.notDeepEqual(a, b)
  a.fill(0)
  assert.equal(unpack(createModelGlb()).doc.extras.variant, 'A')
  for (const variant of ['C', 'a', '', null, '/runs/private']) assert.throws(() => createModelGlb(variant), RangeError)
})
