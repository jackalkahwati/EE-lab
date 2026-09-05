/**
 * The board verdict. One function, one answer, every surface.
 *
 * Four places used to decide independently whether a board was good:
 * electronicsVerdict in run-pipeline.ts, the Overview panel, /api/runs' row
 * builder, and checkpoint-seal. They read different artifacts and disagreed in
 * public — the Overview said "DRC failed, 3 errors" from the shipped chip-down
 * board while the Review panel one click away said "drc.json PASS, 0
 * violations" from a vestigial reference variant, with nothing on screen saying
 * they described different boards. Labelling the two panels was a patch. This
 * is the fix: nothing else computes a verdict.
 *
 * THE RULES, in order. They encode what the pipeline already did honestly, plus
 * the one state it was missing.
 *
 *   not_built   no board artifact at all.
 *   unverified  a board exists but KiCad DRC did not run. Not a pass and not a
 *               failure — we cannot claim clean unchecked. This state is the
 *               reason the module exists: every caller previously had to
 *               remember to distinguish "0 errors" from "nobody looked", and
 *               the ones that forgot reported a green check.
 *   failed      the runner said not-ok, or the referee found DRC errors, or
 *               nets are unrouted, or a pinned part was violated.
 *   passed      a real DRC ran on the shipped board and found nothing.
 *
 * `unrouted` counts stranded GROUND pads as the open nets they are (see
 * run_board.mjs), so a board whose pour could not reach a pad fails here too.
 */

export type BoardVerdictState = 'passed' | 'failed' | 'unverified' | 'not_built'

/** The raw shape run_board.mjs emits and electronics-cs persists. */
export interface BoardFacts {
  ok?: boolean | null
  components?: number | null
  boardMm?: { w: number; h: number } | null
  drc?: {
    available?: boolean
    errors?: number | null
    errorTypes?: Record<string, number> | null
    ruleProfile?: string | null
  } | null
  drcRepair?: {
    unrouted?: number | null
    unroutedSignal?: number | null
    converged?: boolean | null
    groundPlane?: { available?: boolean; unconnected?: number | null; errors?: number | null } | null
  } | null
  pinViolations?: string[] | null
}

export interface BoardVerdict {
  state: BoardVerdictState
  /** The same word every surface shows. */
  headline: string
  /** The measurement behind it — never empty, never a claim. */
  detail: string
  /** null means "not measured", which is not the same as 0. */
  drcErrors: number | null
  unrouted: number | null
  /** shorts + crossings + open nets: the faults that decide if a board works. */
  electrical: number | null
  /** every reason the verdict is not `passed`, in the order they were found. */
  reasons: string[]
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function boardVerdict(board: BoardFacts | null | undefined): BoardVerdict {
  if (!board || (board.components == null && board.drc == null && board.ok == null)) {
    return {
      state: 'not_built',
      headline: 'not built',
      detail: 'no board artifact for this run',
      drcErrors: null, unrouted: null, electrical: null, reasons: [],
    }
  }

  const drc = board.drc ?? null
  const rep = board.drcRepair ?? null
  const errors = n(drc?.errors)
  const unrouted = n(rep?.unrouted)
  const types = drc?.errorTypes ?? {}
  const electrical = drc?.available === true
    ? (n(types.shorting_items) ?? 0) + (n(types.tracks_crossing) ?? 0) + Math.max(n(types.unconnected_items) ?? 0, unrouted ?? 0)
    : null
  const pins = (board.pinViolations ?? []).filter(Boolean)

  // A board nobody checked cannot be called clean. This is checked BEFORE the
  // failure rules so "unchecked" never masquerades as either outcome.
  if (drc?.available !== true) {
    return {
      state: 'unverified',
      headline: 'unverified',
      detail: 'no KiCad DRC result — the board was never checked, which is not the same as clean',
      drcErrors: null, unrouted, electrical: null,
      reasons: ['DRC did not run'],
    }
  }

  const reasons: string[] = []
  if (board.ok === false) reasons.push('the runner reported not ok')
  if ((errors ?? 0) > 0) {
    const top = Object.entries(types).sort((a, b) => b[1] - a[1])[0]?.[0]
    reasons.push(`${errors} DRC error(s)${top ? ` (${top.replace(/_/g, ' ')})` : ''}`)
  }
  if ((unrouted ?? 0) > 0) reasons.push(`${unrouted} net(s) unrouted`)
  const gp = rep?.groundPlane
  if (gp && gp.available === false) reasons.push('the ground plane pass did not run')
  for (const v of pins) reasons.push(String(v))

  if (reasons.length) {
    return {
      state: 'failed',
      headline: 'failed',
      detail: reasons.join(', '),
      drcErrors: errors, unrouted, electrical, reasons,
    }
  }

  const size = board.boardMm ? `${Math.round(board.boardMm.w)}×${Math.round(board.boardMm.h)}mm ` : ''
  return {
    state: 'passed',
    headline: 'passed',
    detail: `${size}routed clean, 0 DRC errors under ${drc?.ruleProfile || 'the fab profile'}`.trim(),
    drcErrors: errors ?? 0, unrouted: unrouted ?? 0, electrical: electrical ?? 0,
    reasons: [],
  }
}

/** True only for a board that was really checked and really passed. */
export function isClean(board: BoardFacts | null | undefined): boolean {
  return boardVerdict(board).state === 'passed'
}

/**
 * The run-list row status. Only three values exist in that type, so
 * `unverified` and `not_built` both land on GATE FAILED rather than inventing a
 * green check for a board nobody measured.
 */
export function runStatusFor(board: BoardFacts | null | undefined): 'PASSED' | 'GATE FAILED' {
  return boardVerdict(board).state === 'passed' ? 'PASSED' : 'GATE FAILED'
}
