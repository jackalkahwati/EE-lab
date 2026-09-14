import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import {
  START_DRAFT_KEY, START_DRAFT_TTL_MS, START_PROMPT_MAX_LENGTH,
  START_SCRUB_SCRIPT, acknowledgeStartDraft, isStartPath, promptFromFragment,
  readStartDraft, safeLoginNext, saveStartDraft, sessionDraftStorage,
} from '../lib/start-draft.ts'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}
const draft = (overrides = {}) => ({ version: 1, id: 'draft-1', prompt: 'A solar sensor', createdAt: Date.now(), ...overrides })
const source = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')

test('fragment decoding preserves punctuation, Unicode and newlines without query fallback', () => {
  const prompt = 'USB-C + battery & LoRa?\n温度 <sensor> #1 / 5V'
  const fragment = '#' + new URLSearchParams({ prompt }).toString()
  assert.equal(promptFromFragment(fragment), prompt)
  assert.equal(promptFromFragment('?prompt=private'), null)
  assert.equal(promptFromFragment('#prompt=one&prompt=two'), null)
  assert.equal(promptFromFragment('#prompt=%20%20'), null)
  assert.equal(promptFromFragment('#other=one'), null)
  assert.equal(promptFromFragment('#prompt=%zz'), null)
  assert.equal(promptFromFragment('#prompt=%E0%A4%A'), null)
  assert.equal(promptFromFragment('#prompt=%ED%A0%80'), null)
  assert.equal(promptFromFragment('#prompt=' + 'a'.repeat(START_PROMPT_MAX_LENGTH)), 'a'.repeat(START_PROMPT_MAX_LENGTH))
  assert.equal(promptFromFragment('#prompt=' + 'a'.repeat(START_PROMPT_MAX_LENGTH + 1)), null)
})

test('draft is versioned, bounded, expiring and read without consuming', () => {
  const storage = memoryStorage()
  const d = draft()
  assert.equal(saveStartDraft(storage, d), true)
  assert.deepEqual(readStartDraft(storage, d.createdAt), d)
  assert.deepEqual(readStartDraft(storage, d.createdAt + START_DRAFT_TTL_MS - 1), d)
  assert.equal(readStartDraft(storage, d.createdAt + START_DRAFT_TTL_MS), null)
  assert.equal(storage.getItem(START_DRAFT_KEY), null)
  for (const invalid of [
    { version: 2 }, { createdAt: Date.now() + 60000 }, { createdAt: 'today' },
    { prompt: '' }, { prompt: 'x'.repeat(START_PROMPT_MAX_LENGTH + 1) }, { id: {} },
  ]) {
    storage.setItem(START_DRAFT_KEY, JSON.stringify(draft(invalid)))
    assert.equal(readStartDraft(storage), null)
    assert.equal(storage.getItem(START_DRAFT_KEY), null)
  }
  storage.setItem(START_DRAFT_KEY, '{bad json')
  assert.equal(readStartDraft(storage), null)
})

test('acknowledgement consumes once and never removes a newer draft', () => {
  const storage = memoryStorage()
  saveStartDraft(storage, draft())
  assert.equal(acknowledgeStartDraft(storage, 'wrong-id'), false)
  assert.ok(readStartDraft(storage))
  assert.equal(acknowledgeStartDraft(storage, 'draft-1'), true)
  assert.equal(acknowledgeStartDraft(storage, 'draft-1'), false)
  saveStartDraft(storage, draft({ id: 'draft-2' }))
  assert.equal(acknowledgeStartDraft(storage, 'draft-1'), false)
  assert.equal(readStartDraft(storage).id, 'draft-2')
})

test('unavailable or silently disabled storage fails without throwing', () => {
  const blocked = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  for (const storage of [null, blocked]) {
    assert.equal(saveStartDraft(storage, draft()), false)
    assert.equal(readStartDraft(storage), null)
    assert.equal(acknowledgeStartDraft(storage, 'draft-1'), false)
  }
  assert.equal(saveStartDraft({ ...memoryStorage(), setItem() {} }, draft()), false)
  assert.equal(sessionDraftStorage(), null)
})

test('login next accepts local paths and rejects origin and backslash attacks', () => {
  for (const next of [null, '', '//evil.test', '/\\evil.test', '\\evil.test',
    'https://evil.test', 'javascript:alert(1)', '/%5cevil.test', '/%2fevil.test',
    '/\n/evil.test', '/%09/evil.test', '/%zz', '/a/..//evil.test', '/a/%2e%2e//evil.test']) {
    assert.equal(safeLoginNext(next, false), '/')
    assert.equal(safeLoginNext(next, true), '/compose')
  }
  assert.equal(safeLoginNext('/compose?run=run-one', true), '/compose?run=run-one')
  assert.equal(safeLoginNext('/enterprise', false), '/enterprise')
  assert.equal(safeLoginNext('/docs/api#examples', false), '/docs/api#examples')
  assert.equal(safeLoginNext(null, !!readStartDraft(memoryStorage())), '/')
})

test('early scrub retains text only in memory and writes a clean history URL', () => {
  for (const pathname of ['/start', '/start/']) {
    const writes = []
    const context = { location: { pathname, hash: '#prompt=private', search: '?junk=1' }, window: {},
      history: { state: { key: 1 }, replaceState: (...args) => writes.push(args) } }
    vm.runInNewContext(START_SCRUB_SCRIPT, context)
    assert.equal(context.window.__firstlightStartFragment, '#prompt=private')
    assert.deepEqual(writes, [[context.history.state, '', '/start']])
  }
  const context = { location: { pathname: '/compose', hash: '#keep' }, window: {} }
  vm.runInNewContext(START_SCRUB_SCRIPT, context)
  assert.equal(context.window.__firstlightStartFragment, undefined)
  assert.equal(isStartPath('/start'), true)
  assert.equal(isStartPath('/start/private'), false)
})

test('website fallback has no successful text control and submits only a fragment when hydrated', () => {
  const website = source('../../firstlight-website/app/try-compose.tsx')
  assert.match(website, /import \{ COMPOSE_URL \} from "\.\.\/lib\/public-config"/)
  assert.doesNotMatch(website, /\bname=["']prompt["']/)
  assert.doesNotMatch(website, /searchParams\.set/)
  assert.match(website, /destination\.hash = new URLSearchParams/)
  assert.match(website, /<noscript>/)
  assert.match(website, /new URL\("\/start", COMPOSE_URL\)/)
})

test('capture has visible storage recovery and composer uses acknowledged prefill, not auto-submit', () => {
  const capture = source('../app/start/page.tsx')
  assert.match(capture, /<textarea id="draft-recovery" readOnly value=\{recovery\}/)
  assert.match(capture, /if \(initialized\.current\) return/)
  assert.match(capture, /delete capture\.__firstlightStartFragment/)
  assert.doesNotMatch(capture, /fetch\(|searchParams/)
  const compose = source('../app/compose/page.tsx')
  // A single workspace shell keeps the same chat mounted before and after a run.
  // Both privacy props must still reach that sole instance; do not remove the handshake.
  assert.equal((compose.match(/<ComposeChat\b/g) ?? []).length, 1)
  assert.equal((compose.match(/onPrefillConsumed=\{onPrefillConsumed\}/g) ?? []).length, 1)
  assert.equal((compose.match(/revisePrefill=\{revisePrefill\}/g) ?? []).length, 1)
  assert.match(compose, /if \(!handoffIdRef\.current && want/)
  const handoff = compose.slice(compose.indexOf('const draft = readStartDraft'), compose.indexOf('// load real runs from disk'))
  assert.match(handoff, /setNewDesign\(true\)/)
  assert.match(handoff, /productSpecRef\.current = null/)
  assert.doesNotMatch(handoff, /acknowledgeStartDraft|runPipeline\(|fetch\(/)
  const chat = source('../components/compose-chat.tsx')
  assert.match(chat, /setTyped\(revisePrefill\)\s+taRef\.current\?\.focus\(\)\s+onPrefillConsumed\?\.\(\)/)
})
