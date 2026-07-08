/**
 * E3 — evidence pack export endpoint.
 * GET /api/enterprise/evidence-pack?run_dir=...&board_id=...&format=json|md
 * Builds the pack live from real run artifacts + store state (reproducible).
 */
// @ts-ignore - plain ESM shared with node tests
import { buildEvidencePack, packToMarkdown } from '@/lib/enterprise/evidencepack.mjs'
// @ts-ignore
import { loadDb } from '@/lib/enterprise/store.mjs'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const run_dir = url.searchParams.get('run_dir')
  const board_id = url.searchParams.get('board_id')
  const format = url.searchParams.get('format') ?? 'json'
  if (!run_dir && !board_id) {
    return Response.json({ error: 'run_dir or board_id required' },
                         { status: 400 })
  }
  // path safety: run_dir must be a bare directory name
  if (run_dir && !/^[A-Za-z0-9._-]+$/.test(run_dir)) {
    return Response.json({ error: 'invalid run_dir' }, { status: 400 })
  }
  const db = loadDb()
  let effRunDir = run_dir
  if (!effRunDir && board_id) {
    const b = db.boards.find((x: any) => x.board_id === board_id)
    const run = db.runs.find((r: any) => r.run_id === b?.latest_run_id)
    effRunDir = run?.source_run_dir ?? null
  }
  const pack = buildEvidencePack({
    type: board_id ? 'board' : 'run',
    run_dir: effRunDir, db, board_id,
  })
  if (format === 'md') {
    return new Response(packToMarkdown(pack), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    })
  }
  return Response.json(pack)
}
