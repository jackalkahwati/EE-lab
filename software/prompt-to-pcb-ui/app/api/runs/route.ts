/**
 * Lists the real runs that exist on disk under public/runs/<id>, so the UI can
 * show every past board (each with its OWN id + artifacts) instead of only the
 * in-memory seed runs. Each entry is built from that run's own snapshot,
 * board.json (geometry/DRC) + last-run.json (prompt/status) + bom.json (line
 * count), so a run can only ever describe its own board.
 *
 * last-run.json is ~3 MB/run, so re-reading every run on every request cost
 * 5–8 s with 150+ runs. Each built Run is cached (lib/runs-cache) keyed by an
 * mtime signature of its data files, so unchanged runs are never re-read — the
 * scan drops to a stat per run. See lib/runs-cache for the persistence details.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Run, StageId, StageState, RunStatus } from '@/lib/firstlight'
import { getUser, sessionEmail } from '@/lib/auth'
import { cacheRun, cachedRun, persistRunsIndex, retainRuns } from '@/lib/runs-cache'

export const dynamic = 'force-dynamic'

// real runs report these five stages (matches lib/real-board buildRun)
const STAGE_IDS: StageId[] = ['design', 'placement', 'routing', 'validation', 'firmware']

// Bump when buildRun's output shape changes — it's baked into every cache key,
// so a bump invalidates all persisted entries and forces a clean rebuild.
const CACHE_VERSION = 'v1'

function readJson(p: string): Record<string, unknown> | unknown[] | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * On-disk signature for a run: mtimes of the files that feed its Run entry.
 * board.json is required (a dir without one never built a board). last-run.json
 * is written LAST in a build, so its mtime also covers board.json/bom.json
 * changes; name.txt covers a rename. A changed signature = cache miss = rebuild.
 * Returns null when there's no board.json (skip the dir entirely).
 */
function signatureFor(runsDir: string, id: string): string | null {
  const dir = path.join(runsDir, id)
  const dataDir = path.join(dir, 'data')
  let b = 0
  try {
    b = fs.statSync(path.join(dataDir, 'board.json')).mtimeMs
  } catch {
    return null
  }
  let l = 0
  try { l = fs.statSync(path.join(dataDir, 'last-run.json')).mtimeMs } catch { /* board-only run */ }
  let n = 0
  try { n = fs.statSync(path.join(dir, 'name.txt')).mtimeMs } catch { /* not renamed */ }
  return `${CACHE_VERSION}:${b}:${l}:${n}`
}

/** Build one run's Run entry from its own data files. null if it never built. */
function buildRun(runsDir: string, id: string): Run | null {
  const dataDir = path.join(runsDir, id, 'data')
  const board = readJson(path.join(dataDir, 'board.json')) as Record<string, any> | null
  // a run that never produced a board.json never built a board, skip it rather
  // than show a phantom entry with no board behind it.
  if (!board) return null
  const lr = (readJson(path.join(dataDir, 'last-run.json')) as Record<string, any>) ?? {}
  const bom = readJson(path.join(dataDir, 'bom.json'))
  const bomLines = Array.isArray(bom) ? bom.length : 0

  const drcPass = (board.drc?.violations ?? 0) === 0
  // unconnected pads (missing connections) make a board not fabricable, they
  // fail the gate even when a zone "serves" the net (see extract_stats.py).
  const connected = (board.drc?.unconnectedItems ?? 0) === 0
  const placePass =
    (board.placement?.overlaps ?? 0) === 0 &&
    (board.placement?.offBoard?.length ?? 0) === 0
  const status: RunStatus =
    lr.status === 'GATE FAILED' || !drcPass || !connected || !placePass
      ? 'GATE FAILED'
      : 'PASSED'

  const reportStages = (lr.stages ?? {}) as Record<string, { state?: string }>
  const stages = STAGE_IDS.map((sid) => {
    const fallback: StageState =
      sid === 'validation'
        ? drcPass
          ? 'passed'
          : 'failed'
        : sid === 'placement'
          ? placePass
            ? 'passed'
            : 'failed'
          : 'passed'
    return {
      id: sid,
      state: (reportStages[sid]?.state as StageState) ?? fallback,
      elapsedMs: 0,
    }
  })

  // Identity comes from the AUTHORITATIVE board.json, never from last-run.json
  // alone: a synced/showcase board can carry a leftover report from a different
  // run (shared-data race), which would mislabel it. Trust last-run's prompt
  // only when its stamped runId matches this dir (i.e. it really is this run).
  const src = String(board.source || '')
  const lrRunId = String(lr.runId || '')
  const lrIsThisRun = !lrRunId || lrRunId === id
  // a user-set name (public/runs/<id>/name.txt) always wins — the board was
  // explicitly renamed. Otherwise fall back to the derived identity.
  let customName = ''
  try { customName = fs.readFileSync(path.join(runsDir, id, 'name.txt'), 'utf8').trim() } catch { /* none */ }
  let name: string
  if (customName) name = customName
  else if (src.includes('dut-power')) name = 'FL-1 DUT Power + Fast-Trip, Rev A'
  else if (src.includes('rev-a-routed')) name = 'FL-1 Rev A, live board'
  else if (lrIsThisRun) name = String(lr.composeSpec?.boardClass || lr.prompt || id)
  else name = id // report belongs to another run, don't borrow its name
  const prompt = lrIsThisRun ? String(lr.prompt || name) : name
  return {
    id,
    name,
    timestamp: String((lrIsThisRun && lr.finishedAt) || board.drc?.date || '')
      .replace('T', ' ')
      .slice(0, 16),
    status,
    prompt,
    real: true,
    runDir: `/runs/${id}`,
    parentId: (lrIsThisRun && lr.parentId) ? String(lr.parentId) : undefined,
    revNote: (lrIsThisRun && lr.revNote) ? String(lr.revNote) : undefined,
    stages,
    metrics: {
      netsRouted: board.netsRouted ?? 0,
      netsTotal: board.netsTotal ?? 0,
      copperDefects: board.drc?.violations ?? 0,
      hpwl: board.hpwlMm ?? 0,
      hpwlHistory: [board.hpwlMm ?? 0],
      components: board.components ?? 0,
      bomLines,
      boardSize: board.boardSize
        ? `${Math.round(board.boardSize.wMm)} × ${Math.round(board.boardSize.hMm)} mm`
        : ', ',
      layers: board.layers ?? 0,
      routeTimeSec: 0,
    },
    logs: [],
  }
}

export async function GET(req: Request) {
  // per-account history: a signed-in user sees their own runs plus the
  // unowned demo/showcase runs; runs owned by OTHER accounts stay private.
  const email = sessionEmail(req)
  const mine = new Set(email ? (getUser(email)?.runIds ?? []) : [])
  const owned = new Set<string>()
  try {
    const store = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'data/users.json'), 'utf8'),
    ) as Record<string, { runIds?: string[] }>
    for (const u of Object.values(store)) for (const r of u.runIds ?? []) owned.add(r)
  } catch {
    /* no accounts yet, everything is demo */
  }
  const runsDir = path.join(process.cwd(), 'public/runs')
  let ids: string[] = []
  try {
    ids = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return Response.json({ runs: [] })
  }

  // Build every run's entry (viewer-independent), reusing the cache for any run
  // whose files haven't changed. Ownership filtering happens per request below.
  const all: Run[] = []
  let changed = false
  for (const id of ids) {
    const key = signatureFor(runsDir, id)
    if (!key) continue // no board.json → never built a board
    let run = cachedRun(id, key)
    if (!run) {
      run = buildRun(runsDir, id)
      if (!run) continue
      cacheRun(id, key, run)
      changed = true
    }
    all.push(run)
  }
  retainRuns(new Set(ids))
  if (changed) persistRunsIndex()

  // visibility: unowned dirs are shared demos; owned dirs only for the owner
  const runs = all.filter((r) => !(owned.has(r.id) && !mine.has(r.id)))

  // newest first by real timestamp (YYYY-MM-DD HH:MM sorts lexically); named
  // runs (fl1-*) would otherwise always lose a reverse id-string sort to run-*.
  runs.sort((a, b) => {
    const t = String(b.timestamp).localeCompare(String(a.timestamp))
    return t !== 0 ? t : a.id < b.id ? 1 : -1
  })
  return Response.json({ runs })
}
