/**
 * GET /api/runs/files?run=<id> — the run's REAL file tree (recursive), like an
 * IDE explorer: every file the run generated, not a hand-maintained catalog.
 * Names, sizes, mtimes only — content is served by the existing /runs/<id>/…
 * live-file route. Read-only; path-confined to the run dir.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { astraConfigured, astraErrorResponse } from '@/lib/astra-beta'
import { ASTRA_MANIFEST, authorizeAstraRun, publishedAstraFile, readAstraManifest } from '@/lib/astra-artifacts'

export const dynamic = 'force-dynamic'

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface FileNode {
  name: string
  /** run-relative path, '/'-separated — usable directly as /runs/<id>/<path> */
  path: string
  dir: boolean
  size?: number
  mtime?: string
  children?: FileNode[]
}

async function walk(abs: string, rel: string, depth: number): Promise<FileNode[]> {
  if (depth > 8) return [] // runs are shallow; a cycle or junk dir stops here
  let entries
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const out: FileNode[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const childAbs = path.join(abs, e.name)
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isSymbolicLink()) continue // stay confined to the run dir
    if (e.isDirectory()) {
      out.push({ name: e.name, path: childRel, dir: true, children: await walk(childAbs, childRel, depth + 1) })
    } else if (e.isFile()) {
      try {
        const st = await fs.stat(childAbs)
        out.push({ name: e.name, path: childRel, dir: false, size: st.size, mtime: st.mtime.toISOString() })
      } catch { /* raced deletion — skip honestly */ }
    }
  }
  // dirs first, then files, both alphabetical — IDE convention
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return out
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const runId = url.searchParams.get('run') ?? ''
  if (!RUN_ID.test(runId)) return Response.json({ error: 'bad run id' }, { status: 400 })
  if (astraConfigured()) {
    try {
      const root = authorizeAstraRun(req, runId)
      const names = ['astra-policy.json', 'product-spec.json', 'timing.json']
      try {
        const manifest = await readAstraManifest(root, runId)
        names.push(ASTRA_MANIFEST, ...manifest.artifacts.map(item => item.path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const tree: FileNode[] = []
      let files = 0
      for (const relative of names) {
        let buffer: Buffer
        try { buffer = await publishedAstraFile(req, runId, relative) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !relative.includes('/')) continue
          throw error
        }
        const segments = relative.split('/')
        let children = tree
        for (const segment of segments.slice(0, -1)) {
          let dir = children.find(node => node.name === segment && node.dir)
          if (!dir) { dir = { name: segment, path: segment, dir: true, children: [] }; children.push(dir) }
          children = dir.children!
        }
        children.push({ name: segments[segments.length - 1], path: relative, dir: false, size: buffer.length })
        files++
      }
      return Response.json({ runId, files, tree }, { headers: { 'cache-control': 'private, no-store' } })
    } catch (error) { return astraErrorResponse(error) }
  }
  const root = path.join(process.cwd(), 'public', 'runs', runId)
  try {
    const st = await fs.stat(root)
    if (!st.isDirectory()) throw new Error('not a dir')
  } catch {
    return Response.json({ error: 'unknown run' }, { status: 404 })
  }
  const tree = await walk(root, '', 0)
  const count = (ns: FileNode[]): number => ns.reduce((a, n) => a + (n.dir ? count(n.children ?? []) : 1), 0)
  return Response.json({ runId, files: count(tree), tree })
}
