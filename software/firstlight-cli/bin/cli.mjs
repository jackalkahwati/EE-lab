#!/usr/bin/env node
/**
 * firstlight — FirstLight Compose from the terminal.
 *
 *   firstlight build "<prompt>" [--wait] [--json]
 *   firstlight status <runId> [--watch] [--json]
 *   firstlight artifacts <runId> [--json]
 *   firstlight get <runId> <kind> [-o <file>]
 *   firstlight boards [--json]
 *
 * Env: FIRSTLIGHT_API_KEY (required), FIRSTLIGHT_URL (default app.firstlight.build)
 */
import { FirstlightClient } from '../lib/client.mjs'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const pos = args.filter((a) => !a.startsWith('--') && !a.startsWith('-o'))
const cmd = pos[0]
const json = flags.has('--json')

function out(v) { console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)) }
function die(msg) { console.error(`error: ${msg}`); process.exit(1) }

function stageLine(s) {
  const order = ['electronics', 'mechanical', 'simulation', 'firmware', 'manufacturing', 'supplyChain', 'validation']
  const glyph = { passed: '✓', failed: '✗', blocked: '⊘', skipped: '·', running: '…', pending: ' ' }
  return order
    .filter((k) => s.stages?.[k])
    .map((k) => `${glyph[s.stages[k].status] ?? '?'} ${k}`)
    .join('  ')
}

function printStatus(s) {
  if (json) return out(s)
  out(`${s.runId}  ${s.status}${s.phase ? ` (${s.phase})` : ''}`)
  const line = stageLine(s)
  if (line) out(`  ${line}`)
  if (s.electronics) out(`  electronics: ${s.electronics.detail}`)
  if (s.error) out(`  error: ${s.error}`)
}

async function main() {
  const c = new FirstlightClient({})
  if (cmd === 'build') {
    const prompt = pos[1]
    if (!prompt) die('usage: firstlight build "<prompt>" [--wait]')
    const r = await c.createBoard(prompt)
    if (json && !flags.has('--wait')) return out(r)
    out(`run ${r.runId} queued (position ${r.queuePosition}) — ${r.note}`)
    if (!flags.has('--wait')) return out(`  firstlight status ${r.runId} --watch`)
    let lastLine = ''
    const final = await c.waitForRun(r.runId, {
      onTick: (s) => {
        const line = `${s.status}${s.phase ? ` (${s.phase})` : ''}  ${stageLine(s)}`
        if (line !== lastLine) { out(`  ${line}`); lastLine = line }
      },
    })
    printStatus(final)
    process.exit(final.status === 'complete' ? 0 : 2)
  } else if (cmd === 'status') {
    const runId = pos[1] || die('usage: firstlight status <runId> [--watch]')
    if (flags.has('--watch')) {
      let lastLine = ''
      const final = await c.waitForRun(runId, {
        onTick: (s) => {
          const line = `${s.status}${s.phase ? ` (${s.phase})` : ''}  ${stageLine(s)}`
          if (line !== lastLine) { out(line); lastLine = line }
        },
      })
      printStatus(final)
      process.exit(final.status === 'complete' ? 0 : 2)
    }
    printStatus(await c.runStatus(runId))
  } else if (cmd === 'artifacts') {
    const runId = pos[1] || die('usage: firstlight artifacts <runId>')
    const r = await c.listArtifacts(runId)
    if (json) return out(r)
    for (const a of r.artifacts) out(`${a.kind.padEnd(16)} ${String(a.bytes).padStart(10)} B  ${a.mime}`)
    if (!r.artifacts.length) out('(no artifacts yet)')
  } else if (cmd === 'get') {
    const runId = pos[1], kind = pos[2]
    if (!runId || !kind) die('usage: firstlight get <runId> <kind> [-o <file>]')
    const oIdx = args.indexOf('-o')
    const outPath = oIdx >= 0 ? args[oIdx + 1] : `${runId}-${kind}${kind.includes('.') ? '' : ''}`
    const r = await c.downloadArtifact(runId, kind, outPath)
    out(`wrote ${r.outPath} (${r.bytes} B, ${r.mime})`)
  } else if (cmd === 'boards') {
    const r = await c.listBoards()
    if (json) return out(r)
    for (const b of r.boards) out(`${b.board_id}  ${b.name}  ${b.readiness ?? ''}`)
  } else {
    out(`firstlight — prompt-to-product from the terminal

  firstlight build "<prompt>" [--wait]     build a product (PCBA + enclosure + docs)
  firstlight status <runId> [--watch]      run status / stage progress
  firstlight artifacts <runId>             list produced artifacts
  firstlight get <runId> <kind> [-o file]  download an artifact (step, glb, fab-package, …)
  firstlight boards                        list enterprise boards
  add --json to any command for machine output

env: FIRSTLIGHT_API_KEY (required) · FIRSTLIGHT_URL (default https://app.firstlight.build)`)
  }
}

main().catch((e) => die(e.message ?? String(e)))
