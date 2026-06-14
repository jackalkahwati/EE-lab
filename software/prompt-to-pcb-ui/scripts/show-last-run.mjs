#!/usr/bin/env node
/**
 * Print the last pipeline run's full report to the terminal — stages, board
 * stats, DRC violations, netlist, fab/firmware outputs, and the complete log.
 * No screenshots needed: every run writes public/data/last-run.{json,md}.
 *
 *   node scripts/show-last-run.mjs           # human digest (last-run.md)
 *   node scripts/show-last-run.mjs --json     # raw machine record
 *   node scripts/show-last-run.mjs --log      # just the log lines
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(here, '..', 'public', 'data')
const arg = process.argv[2]

const read = (f) => {
  const p = path.join(dataDir, f)
  if (!fs.existsSync(p)) {
    console.error(`no ${f} yet — run a pipeline iteration first`)
    process.exit(1)
  }
  return fs.readFileSync(p, 'utf8')
}

if (arg === '--json') {
  process.stdout.write(read('last-run.json'))
} else if (arg === '--log') {
  const r = JSON.parse(read('last-run.json'))
  for (const l of r.logs ?? [])
    console.log(`${l.stage.padEnd(11)} ${l.level !== 'info' ? `[${l.level}] ` : ''}${l.text}`)
} else {
  process.stdout.write(read('last-run.md'))
}
