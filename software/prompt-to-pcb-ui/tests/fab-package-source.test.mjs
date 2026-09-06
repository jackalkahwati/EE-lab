// The fabrication package and FL-1 test plan must be cut from the SHIPPED
// chip-scale board (the one the Electronics verdict describes), never
// unconditionally from the intermediate variant board.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
const src = fs.readFileSync(new URL('../app/api/pipeline/run/route.ts', import.meta.url), 'utf8')
test('fab export and test plan take the shipped board when it exists', () => {
  assert.match(src, /const csPcb = path\.join\(runRoot, 'electronics', 'chipscale\.kicad_pcb'\)/)
  assert.match(src, /fabBoard = csPcb/)
  assert.match(src, /scripts\/export_fab\.py'\),\s*fabBoard,/)
  assert.match(src, /gen_testplan\.py'\), fabBoard, tpPath/)
  assert.doesNotMatch(src, /export_fab\.py'\),\s*variantBoard,/, 'the variant must not be the unconditional fab source')
})
test('the package waits for the early chip-scale build and says which board it used', () => {
  assert.match(src, /fab package will be cut from the intermediate board/)
  assert.match(src, /fabrication package from the \$\{fabBoardLabel\}/)
  assert.match(src, /chipscale-bom\.csv/)
})

test('plan mode cuts the package from the shipped board even when the intermediate variant is not DRC-clean, and the run status follows the shipped board', () => {
  assert.match(src, /if \(drcPass \|\| planMode\) \{/, 'the variant DRC must not gate the shipped-board package')
  assert.match(src, /shippedOk = csBoard\.ok === true/)
  assert.match(src, /planMode\s*\? \(shippedOk === false \? 'GATE FAILED' : 'PASSED'\)/, 'plan-mode status is the shipped board\'s')
  assert.match(src, /const fwSkipped = gen\.out\.match\(\/\^FIRMWARE: SKIPPED/, 'a generator refusal fails the firmware stage instead of building a template for another MCU')
})
