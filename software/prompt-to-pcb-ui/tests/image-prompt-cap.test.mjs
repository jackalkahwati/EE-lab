// The image provider's prompt limit is enforced at the provider boundary, not
// only on the id-render retry path (run d5f4f6c2's first render failed with
// "Length of '/prompt' must be <= 2048").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
test('cloudflareImage clamps every prompt to the provider limit before the fetch', () => {
  const src = fs.readFileSync(path.join(here, '../lib/image-gen.ts'), 'utf8')
  assert.match(src, /const CF_PROMPT_MAX = 2048/)
  const fn = src.slice(src.indexOf('async function cloudflareImage'), src.indexOf('body: JSON.stringify({ prompt'))
  assert.match(fn, /promptIn\.length > CF_PROMPT_MAX \? promptIn\.slice\(0, CF_PROMPT_MAX - 8\)/)
})
