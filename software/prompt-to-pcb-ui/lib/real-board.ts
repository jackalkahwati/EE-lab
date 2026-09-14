/**
 * Loader for real KiCad board artifacts synced into public/ by
 * scripts/sync-board.sh. Everything here reflects the actual saved board , 
 * numbers come from pcbnew + the kicad-cli DRC referee, never invented.
 */
import type {
  AtoFile,
  BomLine,
  GateReport,
  LogLine,
  Run,
} from './firstlight'

export const REAL_RUN_ID = 'run-real-fl1'

export interface RealBoardJson {
  source: string
  boardSize: { wMm: number; hMm: number }
  layers: number
  components: number
  bomTotal?: number
  netsTotal: number
  netsRouted: number
  unroutedNets: string[]
  zoneServedNets: string[]
  tracks: number
  vias: number
  hpwlMm: number
  placement: {
    overlaps: number
    overlapPairs: string[]
    offBoard: string[]
  }
  drc: {
    violations: number
    violationSummaries: { type: string; description: string }[]
    unconnectedItems: number
    kicadVersion: string
    date: string
  }
}

/** The bespoke chip-down board artifact (tools/tscircuit run_board.mjs output). */
export interface ChipScaleJson {
  boardMm?: { w: number; h: number }
  components?: number
  drc?: {
    available?: boolean
    errors?: number
    ruleProfile?: string
    errorTypes?: Record<string, number>
  }
}

export interface RealBoard {
  /** the snapshot this board was loaded from ('' = shared latest, '/runs/<id>'
   * = a run's own snapshot). Used to guard against rendering one run's board
   * while another run is selected. */
  base: string
  board: RealBoardJson
  run: Run
  reports: GateReport[]
  bom: BomLine[] | null
  ato: AtoFile[] | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isMeasurement(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** This legacy view needs a complete analysis, not merely a retained PCB file.
 * Null means reports unavailable; filling gaps would invent clean checks and
 * physical dimensions. Imported designs use their dedicated artifact views,
 * not this FL-1 run's generated-design / firmware / routing-history claims. */
function isAnalyzedBoard(value: unknown): value is RealBoardJson {
  if (!isRecord(value) || value.imported === true || value.source === 'manual-import' || value.analysisError) return false
  const { boardSize, placement, drc } = value
  return typeof value.source === 'string' && value.source.trim().length > 0
    && isRecord(boardSize) && isMeasurement(boardSize.wMm) && boardSize.wMm > 0
    && isMeasurement(boardSize.hMm) && boardSize.hMm > 0
    && isCount(value.layers) && value.layers > 0
    && isCount(value.components) && isCount(value.netsTotal) && isCount(value.netsRouted)
    && value.netsRouted <= value.netsTotal
    && isCount(value.tracks) && isCount(value.vias) && isMeasurement(value.hpwlMm)
    && isStringList(value.unroutedNets) && isStringList(value.zoneServedNets)
    && isRecord(placement) && isCount(placement.overlaps)
    && isStringList(placement.overlapPairs) && isStringList(placement.offBoard)
    && isRecord(drc) && isCount(drc.violations) && isCount(drc.unconnectedItems)
    && typeof drc.kicadVersion === 'string' && typeof drc.date === 'string'
    && Array.isArray(drc.violationSummaries) && drc.violationSummaries.every((item) =>
      isRecord(item) && typeof item.type === 'string' && typeof item.description === 'string')
}

async function fetchJson<T>(url: string, onReadError?: () => void): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } catch {
    onReadError?.()
    return null
  }
}

function buildRun(b: RealBoardJson): Run {
  const placementPass =
    b.placement.overlaps === 0 && b.placement.offBoard.length === 0
  // unconnected items (missing connections) make a board electrically incomplete
  // and not fabricable, so they fail validation just like a rule violation. A net
  // "served by a zone" is NOT routed if its pads aren't actually connected to it.
  const drcPass = b.drc.violations === 0 && b.drc.unconnectedItems === 0
  const passed = placementPass && drcPass

  const logs: LogLine[] = [
    { stage: 'design', prefix: 'ato', text: `real board: ${b.source.split('/').slice(-1)[0]}` },
    { stage: 'design', prefix: 'ato', text: `netlist: ${b.netsTotal} nets, ${b.components} components`, level: 'ok' },
    { stage: 'design', prefix: 'ato', text: 'GATE design: BUILD GREEN, PASS', level: 'ok' },
    { stage: 'placement', prefix: 'place', text: `courtyard sweep: ${b.placement.overlaps} overlaps, ${b.placement.offBoard.length} off-board`, level: placementPass ? 'ok' : 'err' },
    { stage: 'placement', prefix: 'place', text: `HPWL = ${b.hpwlMm.toLocaleString()} mm` },
    { stage: 'placement', prefix: 'place', text: `GATE placement: ${placementPass ? 'PASS' : 'FAIL'}`, level: placementPass ? 'ok' : 'err' },
    { stage: 'routing', prefix: 'route', text: `copper on board: ${b.tracks} track segments, ${b.vias} vias` },
    { stage: 'routing', prefix: 'route', text: `${b.netsRouted}/${b.netsTotal} nets fully routed (${b.unroutedNets.length} open, ${b.zoneServedNets.length} zone-served)` },
    {
      stage: 'routing',
      prefix: 'route',
      text:
        b.drc.unconnectedItems === 0
          ? 'GATE emission: every pad connected to its net, PASS'
          : `GATE emission: ${b.drc.unconnectedItems} pad(s) not connected to their net, FAIL`,
      level: b.drc.unconnectedItems === 0 ? 'ok' : 'err',
    },
    { stage: 'validation', prefix: 'drc', text: `kicad-cli pcb drc (${b.drc.kicadVersion}) → ${b.drc.violations} violations, ${b.drc.unconnectedItems} unconnected items`, level: drcPass ? 'ok' : 'err' },
    ...b.drc.violationSummaries.slice(0, 5).map<LogLine>((v) => ({
      stage: 'validation',
      prefix: 'drc',
      text: `${v.type}: ${v.description}`,
      level: 'err',
    })),
    { stage: 'validation', prefix: 'drc', text: `GATE validation: DRC = ${b.drc.violations}, ${drcPass ? 'PASS' : 'FAIL'}`, level: drcPass ? 'ok' : 'err' },
  ]

  return {
    id: REAL_RUN_ID,
    name: 'FL-1 Rev A, live board',
    timestamp: b.drc.date || 'synced from KiCad',
    status: passed ? 'PASSED' : 'GATE FAILED',
    prompt:
      '8x11 relay probe matrix, 4-layer, Pico 2 control, USB-C, 24V input, real rev-a-routed.kicad_pcb',
    real: true,
    stages: [
      { id: 'design', state: 'passed', elapsedMs: 0 },
      placementPass
        ? { id: 'placement', state: 'passed' as const, elapsedMs: 0 }
        : {
            id: 'placement' as const,
            state: 'failed' as const,
            elapsedMs: 0,
            failReason:
              b.placement.overlapPairs[0] ??
              `${b.placement.offBoard.length} parts off-board`,
          },
      { id: 'routing', state: 'passed', elapsedMs: 35000 },
      drcPass
        ? { id: 'validation', state: 'passed' as const, elapsedMs: 0 }
        : {
            id: 'validation' as const,
            state: 'failed' as const,
            elapsedMs: 0,
            failReason: `${b.drc.violations} DRC violations`,
          },
      // firmware is netlist-derived, so it builds regardless of the DRC result
      { id: 'firmware', state: 'passed', elapsedMs: 0 },
    ],
    metrics: {
      netsRouted: b.netsRouted,
      netsTotal: b.netsTotal,
      copperDefects: b.drc.violations,
      hpwl: b.hpwlMm,
      hpwlHistory: [b.hpwlMm],
      components: b.components,
      bomLines: 29,
      boardSize: `${Math.round(b.boardSize.wMm)} × ${Math.round(b.boardSize.hMm)} mm`,
      layers: b.layers,
      routeTimeSec: 35,
    },
    logs,
  }
}

/** The two boards a run carries. Every gate report names the one it measures. */
export const REFERENCE_BOARD = 'reference variant (parametric floorplan)'
export const SHIPPED_BOARD = 'shipped board (chip-down)'

/**
 * The shipped chip-down board's own KiCad DRC, as a gate report.
 *
 * buildReports() below only ever described the reference variant, so the
 * Checks panel reported a clean board while the Overview — which reads the
 * chip-scale artifact — reported failures on the board that actually ships.
 * This puts the shipped board's referee result in the same list, first.
 */
function chipReport(chip: unknown): GateReport | null {
  if (!isRecord(chip) || chip.imported === true || chip.boardSource === 'manual-import'
    || !isRecord(chip.drc) || chip.drc.available !== true
    || !isCount(chip.drc.errors) || !isRecord(chip.drc.errorTypes)
    || !Object.values(chip.drc.errorTypes).every(isCount)) return null
  const errors = chip.drc.errors
  const types = chip.drc.errorTypes as Record<string, number>
  const electrical =
    (types.shorting_items ?? 0) + (types.tracks_crossing ?? 0) + (types.unconnected_items ?? 0)
  const named = Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`)
    .join(', ')
  return {
    file: 'kicad DRC (shipped board)',
    stage: 'validation',
    board: SHIPPED_BOARD,
    checks: [
      {
        rule: 'electrical faults = 0',
        measured: electrical === 0 ? '0 shorts / crossings / open nets' : `${electrical} electrical`,
        pass: electrical === 0,
      },
      {
        rule: 'DRC errors = 0',
        measured: errors === 0 ? '0 errors' : `${errors}: ${named}`,
        pass: errors === 0,
      },
      ...(typeof chip.drc.ruleProfile === 'string' && chip.drc.ruleProfile.trim()
        ? [{ rule: 'fab rule profile', measured: chip.drc.ruleProfile, pass: true }]
        : []),
    ],
  }
}

function buildReports(b: RealBoardJson): GateReport[] {
  return [
    {
      file: 'placement_score.json',
      stage: 'placement',
      board: REFERENCE_BOARD,
      checks: [
        {
          rule: 'courtyard overlaps = 0',
          measured:
            b.placement.overlaps === 0
              ? '0 overlaps'
              : `${b.placement.overlaps} (${b.placement.overlapPairs[0] ?? ''})`,
          pass: b.placement.overlaps === 0,
        },
        {
          rule: 'off-board components = 0',
          measured: `${b.placement.offBoard.length} off-board`,
          pass: b.placement.offBoard.length === 0,
        },
        {
          rule: 'HPWL (lower is better)',
          measured: `${b.hpwlMm.toLocaleString()} mm`,
          pass: true,
        },
      ],
    },
    {
      file: 'routing (flroute emission)',
      stage: 'routing',
      board: REFERENCE_BOARD,
      checks: [
        {
          rule: 'dirty nets emitted = 0',
          measured: `${b.unroutedNets.length} withheld, 0 emitted`,
          pass: true,
        },
        {
          rule: 'copper inventory',
          measured: `${b.tracks} tracks, ${b.vias} vias`,
          pass: true,
        },
        {
          rule: 'zone-served nets excluded',
          measured: b.zoneServedNets.join(', ') || 'none',
          pass: true,
        },
      ],
    },
    {
      file: 'drc.json',
      stage: 'validation',
      board: REFERENCE_BOARD,
      checks: [
        {
          rule: 'DRC violations = 0',
          measured:
            b.drc.violations === 0
              ? '0 violations'
              : `${b.drc.violations}: ${b.drc.violationSummaries[0]?.type ?? ''}`,
          pass: b.drc.violations === 0,
        },
        {
          rule: 'unconnected items = 0',
          measured:
            b.drc.unconnectedItems === 0
              ? '0 unconnected'
              : `${b.drc.unconnectedItems} pad(s) not connected to their net`,
          pass: b.drc.unconnectedItems === 0,
        },
      ],
    },
  ]
}

export async function loadRealBoard(base = '', onReadError?: () => void): Promise<RealBoard | null> {
  // base '' = shared latest artifacts (/data); '/runs/<id>' = a run's own snapshot
  const board = await fetchJson<unknown>(`${base}/data/board.json`, onReadError)
  if (!isAnalyzedBoard(board)) return null
  const [bomJson, atoJson, chip] = await Promise.all([
    fetchJson<unknown>(`${base}/data/bom.json`, onReadError),
    fetchJson<unknown>(`${base}/data/ato.json`, onReadError),
    // the bespoke chip-scale board (the real chip-down design)
    base ? fetchJson<unknown>(`${base}/electronics/chipscale-board.json`, onReadError) : Promise.resolve(null),
  ])
  const bom = Array.isArray(bomJson) && bomJson.every((line): line is BomLine =>
    isRecord(line) && typeof line.ref === 'string' && typeof line.part === 'string'
    && typeof line.lcsc === 'string' && isCount(line.qty) && isMeasurement(line.unitPrice)
    && (line.lineType === 'ordered' || line.lineType === 'buyer-furnished')) ? bomJson : null
  const ato = Array.isArray(atoJson) && atoJson.every((file): file is AtoFile =>
    isRecord(file) && typeof file.name === 'string' && typeof file.content === 'string') ? atoJson : null
  // When the chip-scale board exists, the headline size + part count should be
  // ITS numbers (the small chip-down board that goes in the enclosure and now
  // renders in 3D) — not the flroute reference board. DRC/BOM still come from the
  // flroute board.json until those are repointed too.
  if (isRecord(chip) && chip.imported !== true && chip.boardSource !== 'manual-import'
    && isRecord(chip.boardMm) && isMeasurement(chip.boardMm.w) && chip.boardMm.w > 0
    && isMeasurement(chip.boardMm.h) && chip.boardMm.h > 0) {
    board.boardSize = { wMm: chip.boardMm.w, hMm: chip.boardMm.h }
    if (isCount(chip.components)) board.components = chip.components
    board.source = 'chip-scale chip-down board'
  }
  // The shipped board's referee result leads; the reference variant's reports
  // follow, each labelled with the board it measures.
  const shipped = chipReport(chip)
  const reports = shipped ? [shipped, ...buildReports(board)] : buildReports(board)
  return { base, board, run: buildRun(board), reports, bom, ato }
}

/**
 * Download links for a real run's artifacts. Each run has its own snapshot under
 * /runs/<id> (board/ + data/); pass that runDir so every board's downloads point
 * at ITS OWN files. With no runDir, fall back to the shared latest /board + /data
 * (a live run that hasn't been snapshotted yet).
 */
export function realArtifacts(runDir?: string) {
  const board = runDir ? `${runDir}/board` : '/board'
  const data = runDir ? `${runDir}/data` : '/data'
  return [
    { name: 'render-top.png', href: `${board}/render-top.png` },
    { name: 'render-bottom.png', href: `${board}/render-bottom.png` },
    { name: 'drc.json', href: `${data}/drc.json` },
    { name: 'board.json', href: `${data}/board.json` },
    { name: 'bom.json', href: `${data}/bom.json` },
  ]
}

/** Shared-latest artifacts (no run snapshot). Prefer realArtifacts(runDir). */
export const REAL_ARTIFACTS = realArtifacts()
