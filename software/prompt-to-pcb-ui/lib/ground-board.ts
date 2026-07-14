import { promises as fs } from 'node:fs'
import path from 'node:path'

export type GroundBoard = {
  wMm: number
  hMm: number
  layers?: number
  components?: number
  parts?: { name: string; footprint?: string; kind?: string; lcsc?: string | null }[]
  source: 'chipscale' | 'flroute'
  /** Honest board health: true only when real DRC ran clean AND no nets were
   *  left unrouted. Undefined when the source carries no DRC record (flroute). */
  ok?: boolean
  /** Real (KiCad) DRC state, so consumers can CARRY the board's DRC status into
   *  their artifacts instead of grounding on a dirty board as if it were clean. */
  drc?: { available: boolean; errors: number | null; unrouted?: number }
}

/**
 * Resolve the board a discipline should ground on. Prefers the bespoke CHIP-SCALE
 * board (electronics-cs) — the real product board for this design — over the
 * flroute reference board (data/board.json), which is a large placeholder spin.
 * Every downstream discipline (mechanical, simulation, manufacturing, supply
 * chain, validation) grounds on the SAME board this way, so the package is
 * coherent instead of half-referencing a 70x72mm dev board. Returns null if
 * neither board exists yet.
 */
export async function loadGroundBoard(runId: string): Promise<GroundBoard | null> {
  const base = path.join(process.cwd(), 'public', 'runs', runId)
  try {
    const cs = JSON.parse(await fs.readFile(path.join(base, 'electronics', 'chipscale-board.json'), 'utf8'))
    if (cs?.boardMm?.w && cs?.boardMm?.h) {
      // Prefer the explicit layer count run_board now records in drcRepair;
      // the winning-strategy-name regex ("... 4-layer ...") is only a fallback
      // for boards persisted before the field existed.
      const strat: string = cs?.drcRepair?.winningStrategy || ''
      const layers = typeof cs?.drcRepair?.layers === 'number'
        ? cs.drcRepair.layers
        : /4-layer/.test(strat) ? 4 : /2-layer/.test(strat) ? 2 : undefined
      // DRC state travels WITH the board so every consumer can carry it.
      const drcAvailable = cs?.drc?.available === true
      const drcErrors = typeof cs?.drc?.errors === 'number' ? cs.drc.errors : null
      const unrouted = typeof cs?.drcRepair?.unrouted === 'number' ? cs.drcRepair.unrouted : 0
      return {
        wMm: cs.boardMm.w,
        hMm: cs.boardMm.h,
        layers,
        components: cs.components,
        parts: Array.isArray(cs.parts) ? cs.parts : undefined,
        source: 'chipscale',
        ok: drcAvailable && drcErrors === 0 && unrouted === 0,
        drc: cs?.drc ? { available: drcAvailable, errors: drcErrors, unrouted } : undefined,
      }
    }
  } catch { /* no chip-scale board */ }
  try {
    const bj = JSON.parse(await fs.readFile(path.join(base, 'data', 'board.json'), 'utf8'))
    if (bj?.boardSize?.wMm && bj?.boardSize?.hMm) {
      return { wMm: bj.boardSize.wMm, hMm: bj.boardSize.hMm, layers: bj.layers, components: bj.components, source: 'flroute' }
    }
  } catch { /* none */ }
  return null
}
