/**
 * Run forking (Phase 2) — start a revision WARM by copying the parent run's
 * artifacts into a new run dir, so a targeted edit only rebuilds what its
 * change invalidates (stage-hashes travel with the copy; the dirtyOnly
 * pipeline then proves per-stage currency server-side).
 *
 * The fork writes its own data/last-run.json lineage fields, so Phase-1
 * tracking groups it under the parent's product exactly like a pipeline-born
 * revision.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const RUNS = path.join(process.cwd(), 'public', 'runs')

/** Artifact trees worth carrying into a revision. v1-job/timing stay behind —
 *  they describe the PARENT's build, not the fork's. */
const COPY = [
  'product-spec.json',
  'stage-hashes.json',
  'data',
  'electronics',
  'board',
  'mechanical',
  'disciplines',
  'firmware',
  'fab',
  'id',
]

export async function forkRun(parentRunId: string, note: string): Promise<string> {
  const src = path.join(RUNS, parentRunId)
  await fs.access(src)
  const runId = `run-${randomUUID()}`
  const dst = path.join(RUNS, runId)
  await fs.mkdir(dst, { recursive: true })
  for (const rel of COPY) {
    try {
      await fs.cp(path.join(src, rel), path.join(dst, rel), { recursive: true })
    } catch { /* absent artifact — fine, the fork is as complete as the parent */ }
  }
  // lineage: rewrite the run report's identity fields for the fork
  const reportPath = path.join(dst, 'data', 'last-run.json')
  let report: Record<string, unknown> = {}
  try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')) } catch { /* fresh */ }
  report.parentId = parentRunId
  report.revNote = note.slice(0, 200)
  report.forkedAt = new Date().toISOString()
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  return runId
}
