/**
 * Dynamic run-artifact server. `next start` only serves public/ paths that
 * existed AT BUILD TIME — every artifact a run writes after a deploy (renders,
 * boards, CAD, reports) 404'd in production until the next rebuild. The proxy
 * now REWRITES authorized /runs/* requests here, and this route streams the
 * file from disk at request time.
 *
 * Reached only via that internal rewrite: the proxy 404s direct external
 * requests to /api/run-file (rewrites don't re-enter the proxy), so the
 * session + run-ownership checks it performs are always upstream of this.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const dynamic = 'force-dynamic'

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.step': 'application/step',
  '.stl': 'model/stl',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

export async function GET(_req: Request, ctx: { params: Promise<{ p: string[] }> }) {
  const { p } = await ctx.params
  // Path shape: ['runs', '<runId>', ...artifact segments]. Segments arrive
  // URL-decoded from the router — reject anything that could escape the tree.
  if (!Array.isArray(p) || p.length < 2 || p[0] !== 'runs') {
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  const segs = p.slice(1)
  if (segs.some((s) => !s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))) {
    return Response.json({ error: 'invalid path' }, { status: 400 })
  }
  const base = path.resolve(process.cwd(), 'public', 'runs')
  const fp = path.resolve(base, ...segs)
  if (fp !== base && !fp.startsWith(base + path.sep)) {
    return Response.json({ error: 'invalid path' }, { status: 400 })
  }
  try {
    const st = await fs.stat(fp)
    if (!st.isFile()) return Response.json({ error: 'not found' }, { status: 404 })
    const buf = await fs.readFile(fp)
    const mime = MIME[path.extname(fp).toLowerCase()] ?? 'application/octet-stream'
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': mime,
        'content-length': String(buf.byteLength),
        // Artifacts get overwritten in place (renders regenerate, reports
        // update) and callers already cache-bust with ?t= — never cache stale.
        'cache-control': 'private, no-store',
      },
    })
  } catch {
    return Response.json({ error: 'not found' }, { status: 404 })
  }
}
