/**
 * Dynamic run-artifact server for /runs/<runId>/<path>.
 *
 * `next start` only serves public/ paths that existed when the server booted,
 * so every artifact a run writes afterwards (renders, boards, CAD, reports)
 * 404'd in production until the next restart. This catch-all route sits at the
 * real /runs URL and streams the file from disk at request time.
 *
 * It is a ROUTE, not a middleware rewrite, on purpose. The rewrite this
 * replaced built its target from `req.nextUrl`, whose origin behind the
 * Cloudflare tunnel (https://localhost) never matched the origin the server
 * knows itself by (http://127.0.0.1). Next treats an origin-mismatched rewrite
 * as an EXTERNAL proxy, so every run artifact was fetched over TLS from a
 * plain-HTTP port and 500'd (EPROTO) — the whole dashboard read "not
 * generated" in production from 2026-07-14 until this. A route has no origin
 * to compare, so there is nothing left for a proxy header to break.
 *
 * proxy.ts still runs FIRST on this path (its matcher covers /runs/*): the
 * session check, the run-id shape check and the run-ownership check are all
 * upstream of this handler, exactly as before.
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
  const { p: segs } = await ctx.params
  // Path shape: ['<runId>', ...artifact segments]. Segments arrive URL-decoded
  // from the router — reject anything that could escape the tree.
  if (!Array.isArray(segs) || segs.length < 1) {
    return Response.json({ error: 'not found' }, { status: 404 })
  }
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
