import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Source-only contract checks: no renderer, dependencies, requests or output files.
const board = readFileSync(new URL('../components/board-3d.tsx', import.meta.url), 'utf8')
const chip = readFileSync(new URL('../components/chipscale-stage.tsx', import.meta.url), 'utf8')

test('Board3D terminal fallback is distinct from its loading indicator', () => {
  const terminal = board.slice(board.indexOf("{phase === 'error' && ("), board.indexOf("{phase === 'loading' && ("))
  assert.match(terminal, /role="alert"/)
  assert.match(terminal, /3D model unavailable/)
  assert.match(terminal, /\{fallback\}/)
  assert.doesNotMatch(terminal, /raytraced|animate-spin|building 3D/)
  const loading = board.slice(board.indexOf("{phase === 'loading' && ("), board.indexOf("{phase === 'ready' && ("))
  assert.match(loading, /animate-spin/)
  assert.doesNotMatch(loading, /\{fallback\}/)
})

test('chip-scale unavailable fallback offers existing Layout and Report, never permanent loading', () => {
  const fallback = chip.slice(chip.indexOf('<Board3D'), chip.indexOf('{/* Layout'))
  assert.match(fallback, /PCBA preview unavailable\. Inspect the saved layout or board report instead\./)
  assert.match(fallback, /onClick=\{\(\) => setView\('layout'\)\}/)
  assert.match(fallback, /onClick=\{\(\) => setView\('report'\)\}/)
  assert.match(fallback, />Open Layout<\/button>/)
  assert.match(fallback, />Open Report<\/button>/)
  assert.doesNotMatch(fallback, /rendering the PCBA|animate-spin|fetch\(|<img/)
})
