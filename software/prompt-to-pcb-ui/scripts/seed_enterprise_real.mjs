/**
 * Real enterprise store populator — NO synthetic data. Builds the org, members,
 * programs and boards from what actually exists on disk:
 *   - members: the real accounts in data/users.json
 *   - boards: real Compose runs in public/runs/<dir> (readiness/route/DRC
 *     derived by attachRun from each run's real last-run.json / drc.json)
 *   - usage: credits computed from each board's real net + component count
 *   - integrations: honest states (KiCad native; others planned; no API keys,
 *     no webhooks, SSO not configured)
 * Approvals / quotes / validation sessions start EMPTY — nothing has been
 * acted on for real yet; they populate when a human acts (wired actions).
 *
 *   node scripts/seed_enterprise_real.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ent = await import('../lib/enterprise/store.mjs')
const cr = await import('../lib/enterprise/credits.mjs')
const rbac = await import('../lib/enterprise/rbac.mjs')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.join(HERE, '..')
const actor = 'system'

// ---- real members from the auth store ----------------------------------------
let users = {}
try { users = JSON.parse(fs.readFileSync(path.join(APP, 'data', 'users.json'), 'utf8')) }
catch { users = {} }
const emails = Object.keys(users).filter((e) => !e.includes('other.test'))
const ROLE_FOR = (email) =>
  email.startsWith('ci@') ? 'viewer'
    : email.includes('lattis') || email.includes('firstlight') ? 'org_admin'
      : 'program_manager'

// ---- curated real boards (latest coherent revision per family) ----------------
// program -> [ [board name, run_dir], ... ]  (run_dir must exist in public/runs)
const PROGRAMS = {
  'FL-1 Instrument Family': [
    ['FL-1 Calibration Board', 'fl1-cal-board-v4'],
    ['FL-1 Core Controller', 'fl1-core-controller-v21'],
    ['FL-1 Core Digital', 'fl1-core-digital-v21'],
    ['FL-1 Core Relay', 'fl1-core-relay-v2'],
    ['FL-1 Backplane', 'fl1-backplane-v1'],
    ['FL-1 Core-6 Bare-RP2040', 'fl1-core6-bare-rp2040-combination-v1'],
  ],
  'Bare-MCU / RP2040': [
    ['QFN-56 Core Sandbox', 'bare-mcu-qfn56-core-sandbox-v1'],
    ['RP2040 Pico Replacement', 'bare-rp2040-pico-replacement-v1'],
    ['QFN-56 2-Layer Feasibility', 'bare-mcu-qfn56-2l-feasibility'],
  ],
  'Chip-Down Components': [
    ['PCF8574 I2C Expander', 'chipdown-pcf8574-v1'],
    ['24LC02 EEPROM', 'chipdown-24lc02-v1'],
    ['74HC595 Shift Register', 'chipdown-74hc595-v1'],
    ['ADS1115 ADC', 'chipdown-ads1115-v1'],
    ['TXB0102 Level Shifter', 'chipdown-txb0102-v1'],
    ['DS3231M RTC', 'chipdown-ds3231m-v1'],
  ],
  'Sensor & Environmental': [
    ['BME280 Breakout', 'bme280-sandbox-v1'],
    ['BME280 Breakout (2-layer)', 'bme280-sandbox-2l'],
    ['Environmental Sensor v2', 'env-sensor-benchmark-v2'],
    ['Current/Voltage Monitor', 'cv-monitor-nonfl1-v1'],
  ],
  'Power & Interface': [
    ['Power Entry Header', 'power-entry-header-v1'],
    ['Power Entry Header (2-layer)', 'power-entry-header-2l'],
    ['USB-C 5V Power Entry', 'usbc-power-entry-v1'],
    ['Connector Breakout', 'connector-breakout-v1'],
    ['Debug/Programming Adapter', 'debug-prog-adapter-v1'],
  ],
}

const readBoardJson = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(APP, 'public', 'runs', dir, 'data', 'board.json'), 'utf8')) }
  catch { return null }
}
const dirExists = (dir) => fs.existsSync(path.join(APP, 'public', 'runs', dir, 'data', 'last-run.json'))

const db = ent.resetDb()
const org = ent.createOrganization(db, {
  name: 'FirstLight', plan: 'enterprise_fl1_bundle', actor })
org.credit_allocation = 1000
org.usage_limits.monthly_runs = 500
org.integrations = {
  eda_connectors: [
    { name: 'KiCad', kind: 'native', status: 'native', io: 'design · route · DRC · fab package' },
    { name: 'Altium Designer', kind: 'connector', status: 'planned', io: 'import schematic/PCB, export fab' },
    { name: 'Autodesk Eagle / Fusion Electronics', kind: 'connector', status: 'planned', io: 'import .sch/.brd' },
    { name: 'Cadence OrCAD / Allegro', kind: 'connector', status: 'evaluating', io: 'import netlist' },
    { name: 'Specctra DSN / SES', kind: 'format', status: 'supported', io: 'router interchange (flroute)' },
    { name: 'IPC-2581 / ODB++', kind: 'format', status: 'planned', io: 'fab handoff' },
  ],
  sso: { status: 'not_configured', protocols: ['SAML 2.0', 'OIDC'], scim: false,
    note: 'available on Enterprise / Defense; contact to enable' },
  api_keys: [],
  webhooks: [],
}
const ws = ent.createWorkspace(db, { org_id: org.org_id,
  name: 'Hardware Programs', description: 'FirstLight board programs', actor })

// real members
for (const email of emails) rbac.setMemberRole(db, { actor_name: email, role: ROLE_FOR(email), actor })

const primaryUser = emails.find((e) => e.includes('lattis')) || emails[0] || 'system'
let boardCount = 0

for (const [progName, boards] of Object.entries(PROGRAMS)) {
  const present = boards.filter(([, dir]) => dirExists(dir))
  if (!present.length) continue
  const p = ent.createProgram(db, { workspace_id: ws.workspace_id, name: progName,
    owner: primaryUser, objective: `${progName} — real Compose runs`,
    budget_credits: present.length * 40, actor })
  for (const [name, dir] of present) {
    const bj = readBoardJson(dir)
    const layers = bj?.layers ?? null
    const b = ent.createBoard(db, { program_id: p.program_id, name,
      board_class: layers ? `${layers}-layer` : '', actor })
    // derive tags from real geometry
    b.tags = []
    if (layers) b.tags.push(`${layers}-layer`)
    if (/fl1|fl-1/i.test(dir)) b.tags.push('fl1')
    if (/chipdown/i.test(dir)) b.tags.push('chip-down')
    if (/bme280|env-sensor|cv-monitor/i.test(dir)) b.tags.push('sensor')
    if (/rp2040|qfn56/i.test(dir)) b.tags.push('mcu')
    // real readiness/route/DRC from disk
    ent.attachRun(db, { board_id: b.board_id, run_dir: dir, created_by: primaryUser, actor })
    // real usage: credits from actual board complexity
    const credits = bj ? Math.max(2, Math.round(((bj.netsTotal || 0) + (bj.components || 0)) / 12)) : 3
    cr.recordUsage(db, { org_id: org.org_id, program_id: p.program_id, board_id: b.board_id,
      usage_type: 'board_synthesis_run', credits, user: primaryUser,
      notes: `real run: ${dir}`, actor })
    boardCount++
  }
}

ent.saveDb(db)
const chain = ent.verifyAuditChain(db)
console.log('REAL enterprise store:',
  emails.length, 'members |', db.programs.length, 'programs |', boardCount, 'boards |',
  db.runs.length, 'runs |', db.usage.length, 'usage entries | audit chain ok:', chain.ok)
console.log('members:', emails.join(', '))
