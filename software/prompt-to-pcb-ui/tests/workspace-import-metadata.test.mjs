import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { workspaceImportedMetadata } from '../lib/workspace-state.ts'

// Match the actual import writer's retained-file metadata, not a fabricated
// ProductSpec. Source-only verification never invokes the writer or run store.
const writer = readFileSync(new URL('../lib/import-design.ts', import.meta.url), 'utf8')
test('actual sparse import metadata is readable but is not a generation spec', () => {
  assert.match(writer, /JSON.stringify\(\{ product: name, source: 'import', imported: true, createdAt: new Date\(\).toISOString\(\) \}/)
  const saved = { product: 'Retained assembly', source: 'import', imported: true, createdAt: '2026-09-13T12:00:00Z' }
  assert.equal(workspaceImportedMetadata(saved), true)
  assert.equal(saved.disciplines, undefined)
  assert.equal(saved.budgets, undefined)
})
test('invalid metadata cannot acquire a retained-import identity or legacy fallback', () => {
  for (const value of [null, [], {}, { product: 'A' }, { product: 'A', imported: true, source: 'wrong', createdAt: '2026-01-01' }, { product: 'A', imported: false, source: 'import', createdAt: '2026-01-01' }, { product: '', imported: true, source: 'import', createdAt: '2026-01-01' }, { product: 'A', imported: true, source: 'import', createdAt: 'invalid' }]) {
    assert.equal(workspaceImportedMetadata(value), false)
  }
})
