// Pure test: the dsn-converter image signature (FL patch) must separate parts whose
// pads sit at the same positions with different pin numbers (a 0402 and its
// 180-degree twin). Without this, freerouting connects nets to the wrong end.
import assert from 'node:assert/strict'
import fs from 'node:fs'
const src = fs.readFileSync(new URL('./node_modules/dsn-converter/dist/index.js', import.meta.url), 'utf8')
const start = src.indexOf('function flGeomSig('); const end = src.indexOf('\n}\n', start) + 3
assert.ok(start > 0, 'flGeomSig must be present (patches/apply.mjs applies it after install)')
const ns = {}; new Function('exports', src.slice(start, end) + 'exports.flGeomSig=flGeomSig;')(ns)
const pad = (pin, x, y) => ({ port_hints: [String(pin), pin === 1 ? 'left' : 'right'], x, y })
const r0 = [pad(1, -0.51, 0), pad(2, 0.51, 0)]
const r180 = [pad(1, 0.51, 0), pad(2, -0.51, 0)]
const r90 = [pad(1, 0, -0.51), pad(2, 0, 0.51)]
const r270 = [pad(1, 0, 0.51), pad(2, 0, -0.51)]
let pass = 0; const t = (n, f) => { f(); pass++; console.log('  ok  ' + n) }
t('same positions, swapped pins -> different images', () => { assert.notEqual(ns.flGeomSig(r0, 0, 0), ns.flGeomSig(r180, 0, 0)); assert.notEqual(ns.flGeomSig(r90, 0, 0), ns.flGeomSig(r270, 0, 0)) })
t('identical parts -> the same image (pad order irrelevant)', () => { assert.equal(ns.flGeomSig(r0, 0, 0), ns.flGeomSig([r0[1], r0[0]], 0, 0)) })
t('rotated 90 vs 0 -> different images (positions differ)', () => assert.notEqual(ns.flGeomSig(r0, 0, 0), ns.flGeomSig(r90, 0, 0)))
t('the installed converter matches the tracked v2 patch', () => {
  const patched = fs.readFileSync(new URL('./patches/dsn-converter-index.PATCHED.js', import.meta.url), 'utf8')
  assert.ok(src.includes('FL PATCH v2'), 'installed converter must carry the v2 patch')
  assert.equal(src, patched, 'postinstall must install the complete tracked patch')
})
console.log(`${pass} passed`)
