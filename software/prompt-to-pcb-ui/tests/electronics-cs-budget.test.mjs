// The first chip-scale build must get a wall long enough for the FULL strategy
// ladder (runner ladder = wall − 150s; a full ladder takes ~200–220s on a quiet
// machine), and the re-plan rungs must stay bounded so the route fits its 600s.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
const src = fs.readFileSync(new URL('../app/api/electronics-cs/route.ts', import.meta.url), 'utf8')
test('first build wall is >= 450s and is what both first-build paths use', () => {
  const m = src.match(/const FIRST_BUILD_WALL_MS = (\d[\d_]*)/); assert.ok(m, 'FIRST_BUILD_WALL_MS declared')
  assert.ok(Number(m[1].replace(/_/g, '')) >= 600_000, 'the first build wall must leave the ladder AND the post-pour repairs room (measured: 450s starved them)')
  assert.match(src, /path\.join\(dir, 'chipscale\.svg'\), FIRST_BUILD_WALL_MS, req\.signal/)
  assert.match(src, /buildCandidate\(baseMsg, req, dir, 'chipscale\.svg', FIRST_BUILD_WALL_MS/)
})
test('re-plan rungs stay bounded inside the route envelope', () => {
  assert.match(src, /Math\.min\(FIRST_BUILD_WALL_MS, ROUTE_ENVELOPE_MS - elapsed\)/, 'grow rungs get the first-build wall inside the route envelope')
  assert.match(src, /const ROUTE_ENVELOPE_MS = 1_200_000/)
  assert.match(src, /if \(budget < 120_000\)/)
  assert.match(src, /export const maxDuration = 600/)
})
