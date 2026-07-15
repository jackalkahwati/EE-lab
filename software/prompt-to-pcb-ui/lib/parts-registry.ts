/**
 * Node adapter for the shared part registry (tools/parts/registry.py) — the
 * MPN/LCSC-keyed SQLite store both board engines share. Spawned as a CLI the
 * same way the server spawns easyeda2kicad; no node sqlite dependency.
 *
 * All calls fail SOFT (null / false): the registry is a cache+catalog layer,
 * and a broken registry must degrade to the pre-registry behavior (live
 * fetch), never break a build.
 */
import path from 'node:path'
import { spawn } from 'node:child_process'

const REGISTRY = path.join(process.cwd(), '..', '..', 'tools', 'parts', 'registry.py')
const PY = process.env.FL_PYTHON || 'python3'

function run(args: string[], stdin?: string, timeoutMs = 15_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const py = spawn(PY, [REGISTRY, ...args], { timeout: timeoutMs })
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve({ code: -1, out: '' }))
    py.on('close', (code) => resolve({ code: code ?? -1, out }))
    if (stdin !== undefined) py.stdin.write(stdin)
    py.stdin.end()
  })
}

/** Cached .kicad_mod footprint text for an LCSC id, or null. */
export async function registryFootprint(lcsc: string): Promise<string | null> {
  const { code, out } = await run(['footprint', lcsc])
  return code === 0 && out.trim().startsWith('(') ? out : null
}

/** Persist a fetched footprint so later builds (and the other engine) skip
 *  the network. Fire-and-forget semantics; returns whether it saved. */
export async function registrySaveFootprint(lcsc: string, kicadMod: string): Promise<boolean> {
  const { code } = await run(['save-footprint', lcsc], kicadMod)
  return code === 0
}

/** Full registry entry by LCSC id or MPN, or null. */
export async function registryGet(key: string): Promise<Record<string, unknown> | null> {
  const { code, out } = await run(['get', key])
  if (code !== 0) return null
  try {
    const e = JSON.parse(out)
    return e && e.found !== false ? e : null
  } catch { return null }
}

/** Substring search over the catalog (mpn/description/category/package). */
export async function registrySearch(query: string, limit = 20): Promise<Record<string, unknown>[]> {
  const { code, out } = await run(['search', query, '-n', String(limit)])
  if (code !== 0) return []
  try {
    const r = JSON.parse(out)
    return Array.isArray(r) ? r : []
  } catch { return [] }
}
