import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateAstraGlb, deriveAstraModelBaseMm } from '../lib/astra-export-evidence.ts';

// Synthetic binary unit fixture only, never represented as a native export.
// Tests use reviewed source catalog but never read runtime artifacts or invoke tools.
const catalog = JSON.parse(fs.readFileSync(new URL('../lib/astra-catalog.json', import.meta.url), 'utf8'));
const boardText = '(kicad_pcb (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user)) (setup))';
function fixture() {
  const refs = Object.keys(catalog.parts).sort();
  const footprints = refs.map((ref, i) => { const asset = catalog.assets[catalog.parts[ref].catalogId]; return { ref, layer: 0, footprintId: `${asset.footprint.libraryPath.split('/').at(-1).replace(/\.pretty$/, '')}:${asset.footprint.name}`, positionNm: [10000000 + i * 1000000, 12000000], rotationDeg: ref.startsWith('C') ? -90 : 0, models: [{ ...structuredClone(asset.models[0]), show: true, opacity: 1 }] }; });
  const scene = { asset: { version: '2.0', extras: { generator: 'KiCad 10.0.1' } }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ children: [] }], meshes: [], materials: [{}], buffers: [{ byteLength: 80 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, byteStride: 12 }, { buffer: 0, byteOffset: 36, byteLength: 36, byteStride: 12 }, { buffer: 0, byteOffset: 72, byteLength: 6 }], accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }, { bufferView: 1, componentType: 5126, type: 'VEC3', count: 3 }, { bufferView: 2, componentType: 5123, type: 'SCALAR', count: 3 }] };
  const primitive = () => ({ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 });
  for (const fp of footprints) {
    const model = fp.models[0], a = fp.rotationDeg * Math.PI / 180, [ox, oy, oz] = model.offsetMm;
    scene.nodes[0].children.push(scene.nodes.length);
    scene.nodes.push({ name: fp.ref, mesh: scene.meshes.length, translation: [fp.positionNm[0] / 1e9 + (Math.cos(a) * ox - Math.sin(a) * oy) / 1000, (1.595 + oz) / 1000, fp.positionNm[1] / 1e9 - (Math.sin(a) * ox + Math.cos(a) * oy) / 1000], rotation: [0, Math.sin(a / 2), 0, Math.cos(a / 2)] });
    scene.meshes.push({ name: model.path.split('/').at(-1).replace(/\.step$/, ''), primitives: [primitive()] });
  }
  scene.nodes[0].children.push(scene.nodes.length); scene.nodes.push({ name: '=>[0:1:1:6]', mesh: scene.meshes.length }); scene.meshes.push({ name: 'final-board_PCB', primitives: [primitive()] });
  const bin = Buffer.alloc(80); [[0, 0, 0], [0.001, 0, 0], [0, 0.001, 0]].flat().forEach((v, i) => bin.writeFloatLE(v, i * 4));
  for (let i = 0; i < 3; i++) bin.writeFloatLE(1, 36 + i * 12 + 8);
  [0, 1, 2].forEach((v, i) => bin.writeUInt16LE(v, 72 + i * 2));
  const context = { engineVersion: '10.0.1', boardText, catalog, nativeEvidence: { version: 1, stage: 'finished', identityPreserved: true, routeAttempts: 1, identity: { layers: 2, footprints } } };
  const bytes = () => { let text = JSON.stringify(scene); text += ' '.repeat((4 - Buffer.byteLength(text) % 4) % 4); const json = Buffer.from(text), result = Buffer.alloc(28 + json.length + bin.length); result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8); result.writeUInt32LE(json.length, 12); result.writeUInt32LE(0x4e4f534a, 16); json.copy(result, 20); result.writeUInt32LE(bin.length, 20 + json.length); result.writeUInt32LE(0x004e4942, 24 + json.length); bin.copy(result, 28 + json.length); return result; };
  return { scene, bin, context, bytes, validate: () => validateAstraGlb(bytes(), context) };
}

test('independent native thickness/default-stackup derives component height, not GLB golden', () => {
  assert.equal(deriveAstraModelBaseMm(boardText), 1.595);
  for (const text of [boardText.replace('(thickness 1.6)', '(thickness 1.6)(thickness 2)'), boardText.replace('(setup)', '(setup (stackup))'), boardText.replace('(2 "B.Cu" signal)', '(2 "B.Cu" signal)(4 "In1.Cu" signal)'), boardText.replace('(3 "B.Mask" user)', ''), boardText + 'junk']) assert.throws(() => deriveAstraModelBaseMm(text));
});

test('all six native component instances and model names validate with real indexed geometry', () => {
  const result = fixture().validate();
  assert.deepEqual(result.componentRefs, ['C1', 'C2', 'J1', 'R1', 'R2', 'U1']);
  assert.equal(result.componentCount, 6); assert.equal(result.triangleCount, 7); assert.equal(result.modelBaseMm, 1.595);
});

test('missing extra duplicate and board-only geometry are rejected', () => {
  for (const mutate of [f => { f.scene.nodes[1].name = 'UNKNOWN'; }, f => { f.scene.nodes[2].name = f.scene.nodes[1].name; }, f => { f.scene.meshes[0].name = 'final-board_copper'; }, f => { f.scene.nodes[0].children.pop(); }, f => { f.scene.nodes.push({ name: 'U1', mesh: 0 }); f.scene.nodes[0].children.push(f.scene.nodes.length - 1); }, f => { f.scene.meshes[0].primitives = []; }]) {
    const f = fixture(); mutate(f); assert.throws(f.validate);
  }
});

test('world transforms reject XY, vertical, quaternion, scale, parent-offset and catalog-offset errors', () => {
  for (const mutate of [f => { f.scene.nodes[1].translation[0] += 0.001; }, f => { f.scene.nodes[1].translation[1] += 0.0001; }, f => { f.scene.nodes[1].translation[2] *= -1; }, f => { f.scene.nodes[1].rotation = [0, 0, 0, 1]; }, f => { f.scene.nodes[1].scale = [2, 1, 1]; }, f => { f.scene.nodes[0].translation = [0.001, 0, 0]; }, f => { f.context.nativeEvidence.identity.footprints[0].models[0].offsetMm = [1, 0, 0]; }, f => { f.context.boardText = boardText.replace('1.6', '1.7'); }]) {
    const f = fixture(); mutate(f); assert.throws(f.validate);
  }
});

test('equivalent affine matrix/quaternion sign validates, matrix plus TRS does not', () => {
  const f = fixture(), node = f.scene.nodes.find(n => n.name === 'J1'), t = node.translation;
  delete node.translation; delete node.rotation; node.matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...t, 1];
  f.scene.nodes[1].rotation = f.scene.nodes[1].rotation.map(v => -v);
  assert.equal(f.validate().identityPreserved, true);
  node.translation = t; assert.throws(f.validate);
});

test('cycle repeated reference unreachable nodes and malformed node indices fail closed', () => {
  for (const mutate of [f => { f.scene.nodes[1].children = [0]; }, f => { f.scene.nodes[0].children.push(1); }, f => { f.scene.nodes.push({}); }, f => { f.scene.nodes[1].mesh = 1000; }, f => { f.scene.nodes[0].children = [-1]; }]) { const f = fixture(); mutate(f); assert.throws(f.validate); }
});

test('binary length/chunks bounds, accessor shape and triangle indices are checked', () => {
  const f = fixture(); const b = f.bytes(); b.writeUInt32LE(b.length + 4, 8); assert.throws(() => validateAstraGlb(b, f.context));
  for (const mutate of [f => { f.scene.buffers[0].byteLength = 1000; }, f => { f.scene.bufferViews[0].byteLength = 1000; }, f => { f.scene.accessors[0].count = 1000; }, f => { f.scene.accessors[2].count = 2; }, f => { f.bin.writeUInt16LE(3, 72); }, f => { f.bin.fill(0, 72, 78); }, f => { f.bin.writeFloatLE(NaN, 0); }, f => { f.scene.accessors[0].sparse = {}; }, f => { f.scene.nodes[1].rotation = [0, 0, 0, 2]; }]) { const f = fixture(); mutate(f); assert.throws(f.validate); }
});

test('external resource URIs, extensions and foreign engine metadata are rejected', () => {
  for (const mutate of [f => { f.scene.buffers[0].uri = 'file:///private'; }, f => { f.scene.images = [{ uri: 'https://example.test/model' }]; }, f => { f.scene.extensionsUsed = ['KHR_draco_mesh_compression']; }, f => { f.scene.materials[0].normalTexture = { index: 0 }; }, f => { f.scene.asset.extras.generator = 'KiCad 10.0.5'; }]) { const f = fixture(); mutate(f); assert.throws(f.validate); }
});
