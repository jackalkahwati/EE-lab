#!/usr/bin/env node
// Mint a programmatic API key in THIS checkout's enterprise store (run it from
// the checkout that serves production, e.g. ~/firstlight-prod). The plaintext is
// printed ONCE on stdout and never stored; revoke from /enterprise/integrations.
//
//   node tools/cli/fl-key.mjs --owner you@example.com [--name cli] [--scope read_write]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []).filter((x) => x.length))
const owner = args.owner; if (!owner) { console.error('usage: fl-key.mjs --owner <email> [--name cli] [--scope read_write]'); process.exit(2) }
// FL_APP_DIR: the app checkout whose store to mint into (default: this checkout's)
const app = process.env.FL_APP_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../software/prompt-to-pcb-ui')
const store = await import(path.join(app, 'lib/enterprise/store.mjs'))
const integ = await import(path.join(app, 'lib/enterprise/integrations.mjs'))
const rec = await store.withStore((db) => integ.createApiKey(db, { name: args.name || 'cli', scope: args.scope || 'read_write', actor: owner }))
if (rec?.error) { console.error('mint failed:', rec.error); process.exit(1) }
console.error(`minted ${rec.id} (${rec.masked}) scope=${rec.scope} owner=${owner}`)
console.log(rec.plaintext)
