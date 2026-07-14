/**
 * Programs portfolio loader — derives product programs from the REAL run
 * artifacts persisted under public/runs/. Server-side only (fs reads).
 *
 * A "program" is a product line: runs are grouped by the product name found
 * in their own artifacts (product-spec.json `product`, else the ID brief's
 * `product`, else the run's saved name from data/runs-index.json). Every
 * status shown is read verbatim from an artifact — nothing is inferred.
 * Missing artifact -> "not built", never a guess.
 */
import fs from 'node:fs'
import path from 'node:path'

// ---------- public types ------------------------------------------------------

export interface RunDrc {
  /** no_board: no chip-scale board artifact · not_run: board exists, DRC unavailable */
  state: 'clean' | 'errors' | 'not_run' | 'no_board'
  errors?: number
  warnings?: number
}

export interface RunSummary {
  dir: string
  shortId: string
  /** epoch ms best-effort: timing.json -> runs-index timestamp -> dir mtime */
  dateMs: number
  dateLabel: string
  productName: string
  description: string | null
  thumbnail: string | null
  boardDims: string | null
  drc: RunDrc
  /** discipline artifact basenames actually present under disciplines/ */
  disciplines: string[]
  totalMs: number | null
  links: { label: string; href: string }[]
}

export interface Program {
  slug: string
  name: string
  runs: RunSummary[] // newest first
  latest: RunSummary
}

// ---------- helpers -----------------------------------------------------------

const RUNS_ROOT = path.join(process.cwd(), 'public', 'runs')
const INDEX_PATH = path.join(process.cwd(), 'data', 'runs-index.json')
const MAX_RUNS = 100

function readJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed'
}

/** "Simple ADC Data Logger v1" -> "Simple ADC Data Logger" (grouping only) */
function stripVersion(name: string): string {
  return name.replace(/[\s-]+v?\d+$/i, '').trim() || name
}

/**
 * Some saved run names are the full design prompt, not a product name.
 * Clip those to a stable, readable title (grouping stays deterministic:
 * identical prompt -> identical clipped name -> identical slug).
 */
function clipName(name: string): string {
  if (name.length <= 70) return name
  const head = name.slice(0, 64)
  const cut = Math.max(head.lastIndexOf(','), head.lastIndexOf(':'), head.lastIndexOf(' '))
  return `${head.slice(0, cut > 24 ? cut : 64).trim()}…`
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

// ---------- per-run summary ---------------------------------------------------

interface IndexEntry {
  name?: string
  timestamp?: string
  prompt?: string
  metrics?: { boardSize?: string }
}

function summarizeRun(dir: string, mtimeMs: number, idx: IndexEntry | null): RunSummary | null {
  const root = path.join(RUNS_ROOT, dir)
  try {
    const spec = readJson(path.join(root, 'product-spec.json'))
    const idBrief = readJson(path.join(root, 'disciplines', 'id-brief.json'))
    const board = readJson(path.join(root, 'electronics', 'chipscale-board.json'))
    const timing = readJson(path.join(root, 'timing.json'))

    // product name: own artifacts first, saved run name as fallback
    const m = dir.match(/^run-([0-9a-f]{8})/i)
    const shortId = m ? m[1] : dir.slice(0, 14)
    const rawName =
      (typeof spec?.product === 'string' && spec.product) ||
      (typeof idBrief?.product === 'string' && idBrief.product) ||
      (typeof idx?.name === 'string' && stripVersion(idx.name)) ||
      (dir.startsWith('run-') ? `run ${shortId}` : stripVersion(dir))
    const productName = clipName(rawName)

    // date: timing.json -> runs-index timestamp -> dir mtime
    let dateMs = mtimeMs
    const t = Date.parse(timing?.finishedAt ?? timing?.startedAt ?? '')
    if (!Number.isNaN(t)) dateMs = t
    else if (idx?.timestamp) {
      const ti = Date.parse(idx.timestamp.replace(' ', 'T'))
      if (!Number.isNaN(ti)) dateMs = ti
    }

    // DRC — read verbatim from the chip-scale board artifact
    let drc: RunDrc = { state: 'no_board' }
    if (board) {
      const d = board.drc
      if (board.ok === true) drc = { state: 'clean', errors: 0 }
      else if (d?.available && typeof d.errors === 'number') {
        drc = d.errors > 0
          ? { state: 'errors', errors: d.errors, warnings: d.warnings }
          : { state: 'clean', errors: 0, warnings: d.warnings }
      } else drc = { state: 'not_run' }
    }

    // board dims: artifact first, saved metrics as fallback
    let boardDims: string | null = null
    if (typeof board?.boardMm?.w === 'number' && typeof board?.boardMm?.h === 'number') {
      boardDims = `${Math.round(board.boardMm.w)} × ${Math.round(board.boardMm.h)} mm`
    } else if (idx?.metrics?.boardSize) boardDims = idx.metrics.boardSize

    // disciplines actually built (json artifacts on disk)
    let disciplines: string[] = []
    try {
      disciplines = fs
        .readdirSync(path.join(root, 'disciplines'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort()
    } catch {
      /* no disciplines dir */
    }

    // thumbnail: first real visual artifact present
    const thumbCandidates = [
      'electronics/chipscale.svg',
      'mechanical/enclosure.png',
      'board/render-top.png',
      'board/F.Cu.svg',
    ]
    let thumbnail: string | null = null
    for (const c of thumbCandidates) {
      if (exists(path.join(root, c))) {
        thumbnail = `/runs/${dir}/${c}`
        break
      }
    }

    // direct artifact links (only what exists)
    const linkCandidates: [string, string][] = [
      ['board svg', 'electronics/chipscale.svg'],
      ['schematic', 'electronics/chipscale-schematic.svg'],
      ['STEP', 'mechanical/enclosure.step'],
      ['enclosure', 'mechanical/enclosure.png'],
      ['timing', 'timing.json'],
    ]
    const links = linkCandidates
      .filter(([, rel]) => exists(path.join(root, rel)))
      .map(([label, rel]) => ({ label, href: `/runs/${dir}/${rel}` }))

    return {
      dir,
      shortId,
      dateMs,
      dateLabel: fmtDate(dateMs),
      productName,
      description:
        (typeof spec?.description === 'string' && spec.description) ||
        (typeof idx?.prompt === 'string' && idx.prompt) ||
        null,
      thumbnail,
      boardDims,
      drc,
      disciplines,
      totalMs: typeof timing?.totalMs === 'number' ? timing.totalMs : null,
      links,
    }
  } catch {
    return null // malformed run dir — skip, never crash the page
  }
}

// ---------- portfolio ---------------------------------------------------------

export function loadPrograms(): Program[] {
  let dirents: fs.Dirent[] = []
  try {
    dirents = fs.readdirSync(RUNS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return []
  }

  const index: Record<string, any> = readJson(INDEX_PATH) ?? {}

  const withTimes = dirents
    .map((d) => {
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(path.join(RUNS_ROOT, d.name)).mtimeMs
      } catch {
        /* keep 0 */
      }
      return { dir: d.name, mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_RUNS)

  const runs: RunSummary[] = []
  for (const { dir, mtimeMs } of withTimes) {
    const entry = index[dir]?.run ?? null
    const s = summarizeRun(dir, mtimeMs, entry)
    if (s) runs.push(s)
  }

  const bySlug = new Map<string, Program>()
  for (const run of runs) {
    const slug = slugify(run.productName)
    const existing = bySlug.get(slug)
    if (existing) existing.runs.push(run)
    else bySlug.set(slug, { slug, name: run.productName, runs: [run], latest: run })
  }

  const programs = [...bySlug.values()]
  for (const p of programs) {
    p.runs.sort((a, b) => b.dateMs - a.dateMs)
    p.latest = p.runs[0]
  }
  programs.sort((a, b) => b.latest.dateMs - a.latest.dateMs)
  return programs
}

export function loadProgram(slug: string): Program | null {
  return loadPrograms().find((p) => p.slug === slug) ?? null
}
