import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../components/compose-chat.tsx', import.meta.url), 'utf8')

// A build path that opens its stream without reporting the run leaves the page
// believing no run exists, so a FAILED build renders as a fresh install --
// "No run yet" over a design showing Electronics FAILED. That shipped once
// because two identical-looking call sites diverged and only one reported.
test('no build path opens an EventSource without reporting the run', () => {
  const direct = [...src.matchAll(/new EventSource\(/g)].length
  // exactly one: the single construction inside openBuildStream
  assert.equal(direct, 1, 'every build stream must be opened via openBuildStream')
  const helper = src.match(/function openBuildStream\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/)
  assert.ok(helper, 'openBuildStream must exist')
  assert.match(helper[1], /onRunStart\?\.\(/, 'openBuildStream must report the run before opening the stream')
})

test('both build paths go through the helper', () => {
  const uses = [...src.matchAll(/openBuildStream\(url, id\)/g)].length
  assert.equal(uses, 2, `expected both build paths to use openBuildStream, found ${uses}`)
})

test('a failed build reports why', () => {
  assert.ok(src.includes('onRunFailed?.('), 'the chat must tell the page why a run failed')
})
