import { promises as fs } from 'node:fs'
import path from 'node:path'

export type GroundBoard = {
  wMm: number
  hMm: number
  layers?: number
  components?: number
  parts?: { name: string; footprint?: string; kind?: string; lcsc?: string | null }[]
  source: 'chipscale' | 'flroute'
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
      // layer count lives in the winning strategy name ("... 4-layer ...")
      const strat: string = cs?.drcRepair?.winningStrategy || ''
      const layers = /4-layer/.test(strat) ? 4 : /2-layer/.test(strat) ? 2 : undefined
      return {
        wMm: cs.boardMm.w,
        hMm: cs.boardMm.h,
        layers,
        components: cs.components,
        parts: Array.isArray(cs.parts) ? cs.parts : undefined,
        source: 'chipscale',
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
