import fs from 'node:fs/promises'
import path from 'node:path'
import { recordRun, isValidRunId } from './auth'
import { ASTRA_NOT_RUN, ASTRA_SCOPE, astraErrorResponse, astraWorkflow, astraWorkspace, inAstraWorkflow } from './astra-beta'
import { AstraError, assertAstraActive } from './astra-execution'
import { preflightAstraElectronics } from './astra-local-parts'
import { validateAstraSpecification } from './astra-design-contract'
import { ASTRA_MANIFEST, parseAstraManifest, readAstraManifest } from './astra-artifacts'

/** Electronics beta uses the real route and its persisted evidence, not the legacy planner. */
export async function astraPipeline(req: Request, electronics: (req: Request) => Promise<Response>) {
  try {
    const workflow = astraWorkflow(req)
    const { root, origin } = astraWorkspace()
    const runId = new URL(req.url).searchParams.get('runId') || ''
    if (!runId.startsWith('run-') || !isValidRunId(runId) || workflow.phase !== 'ready' || !workflow.spec || workflow.runId) {
      throw new AstraError('policy', 'Astra requires a fresh run and an accepted electronics specification.')
    }
    await preflightAstraElectronics()
    validateAstraSpecification(workflow.spec, workflow.templateId)
    const runRoot = path.join(root, 'public/runs', runId)
    const encoder = new TextEncoder()
    let observing = true
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: unknown) => { if (observing) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
        void inAstraWorkflow(req, 'building', async (active) => {
          assertAstraActive(active.execution)
          validateAstraSpecification(active.spec, active.templateId)
          const startedAt = new Date().toISOString()
          const timing = {
            runId, startedAt,
            stages: [
              { stage: 'electronics', startedAt, status: 'running', endedAt: undefined as string | undefined, detail: 'Astra beta electronics build' },
              ...ASTRA_NOT_RUN.map((stage) => ({ stage, startedAt, endedAt: startedAt, status: 'skipped', detail: 'Not run: unsupported in the electronics-only beta scope.' })),
            ],
            finishedAt: undefined as string | undefined,
          }
          const policy = {
            version: 1, transport: 'astra-beta', model: 'gpt-6-astra', scope: ASTRA_SCOPE,
            workflowId: active.execution.id, status: 'running',
            outcome: undefined as { status: string; category: string; detail: string } | undefined,
          }
          const persistPolicy = () => fs.writeFile(path.join(runRoot, 'astra-policy.json'), JSON.stringify(policy))
          let allocated = false
          try {
            // Exclusive allocation: never replace, remove or resume an existing directory.
            await fs.mkdir(runRoot)
            allocated = true
            // Ownership must survive cancellation racing the exclusive allocation.
            recordRun(active.execution.owner, runId)
            active.runId = runId
            assertAstraActive(active.execution)
            await persistPolicy()
            assertAstraActive(active.execution)
            await fs.writeFile(path.join(runRoot, 'product-spec.json'), JSON.stringify(active.spec))
            assertAstraActive(active.execution)
            await fs.writeFile(path.join(runRoot, 'timing.json'), JSON.stringify(timing))
            assertAstraActive(active.execution)
            emit({ type: 'stage', id: 'electronics', state: 'running' })
            const response = await electronics(new Request(`${origin}/api/electronics-cs`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', cookie: req.headers.get('cookie') || '', 'x-fl-astra-workflow': active.execution.id },
              body: JSON.stringify({ runId, spec: active.spec }),
            }))
            const result = await response.json()
            assertAstraActive(active.execution)
            if (!response.ok || result.error) throw new AstraError('process', 'Electronics generation failed. Inspect the saved run for diagnostics.')
            const manifest = await readAstraManifest(root, runId)
            assertAstraActive(active.execution)
            const passed = manifest.status === 'passed'
            timing.stages[0].status = passed ? 'passed' : 'failed'
            timing.stages[0].detail = passed
              ? 'Native DRC and connectivity passed; required native exports are available. Physical function is not verified.'
              : 'Native electronics checks or required exports did not pass. Inspect the saved evidence.'
            timing.stages[0].endedAt = new Date().toISOString()
            timing.finishedAt = timing.stages[0].endedAt
            assertAstraActive(active.execution)
            await fs.writeFile(path.join(runRoot, 'timing.json'), JSON.stringify(timing))
            assertAstraActive(active.execution)
            policy.status = passed ? 'passed' : 'failed'
            await persistPolicy()
            assertAstraActive(active.execution)
            emit({ type: 'stage', id: 'electronics', state: passed ? 'passed' : 'failed' })
            emit({ type: 'done', status: passed ? 'PASSED' : 'GATE FAILED', scope: ASTRA_SCOPE, runDir: `/runs/${runId}` })
          } catch (error) {
            timing.stages[0].status = 'failed'
            timing.stages[0].detail = error instanceof AstraError ? error.message : 'Electronics outcome unknown: allocation or persistence failed.'
            timing.stages[0].endedAt = new Date().toISOString()
            timing.finishedAt = timing.stages[0].endedAt
            // A cancelled run may retain partial artifacts, never a new success. Only
            // write a failure marker into a directory this invocation actually created.
            // Storage failure must not mask the original terminal error or delete a run.
            if (allocated) {
              const status = active.execution.signal.aborted ? 'cancelled' : 'failed'
              policy.status = status
              policy.outcome = {
                status, category: error instanceof AstraError ? error.category : 'process',
                detail: status === 'cancelled'
                  ? 'Execution cancelled before pipeline completion. Saved artifacts may be partial.'
                  : 'Pipeline did not complete successfully. Inspect saved evidence; physical function is not verified.',
              }
              // Native work can finish before pipeline timing or observation settles.
              // Downgrade its success marker too, keeping verified artifact entries.
              // A pre-native failure has no proposal digest: never invent a manifest.
              let pendingCreated = false
              let manifestRead = false
              const pending = path.join(runRoot, '.astra-pipeline-manifest.pending.json')
              try {
                const manifest = await readAstraManifest(root, runId)
                manifestRead = true
                manifest.status = status
                manifest.checks.exportsComplete = false
                parseAstraManifest(manifest, runId)
                await fs.writeFile(pending, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
                pendingCreated = true
                await fs.rename(pending, path.join(runRoot, ASTRA_MANIFEST))
                pendingCreated = false
              } catch (manifestError) {
                // Missing evidence is normal before native work. For any other
                // failure, best-effort removal prevents a stale success claim.
                if (manifestRead || !(manifestError instanceof Error && 'code' in manifestError && manifestError.code === 'ENOENT')) {
                  await fs.rm(path.join(runRoot, ASTRA_MANIFEST), { force: true }).catch(() => {})
                }
              } finally {
                if (pendingCreated) await fs.rm(pending, { force: true }).catch(() => {})
              }
              try { await persistPolicy() }
              catch { /* Still attempt independent timing persistence below. */ }
              try { await fs.writeFile(path.join(runRoot, 'timing.json'), JSON.stringify(timing)) }
              catch { /* Outcome remains unknown; the error stream reports failure. */ }
            }
            throw error
          }
        }).catch((error) => {
          const text = error instanceof AstraError ? error.message : 'Astra beta build failed; no automatic retry was submitted.'
          emit({ type: 'error', text, message: text })
        }).finally(() => { if (observing) controller.close() })
      },
      cancel() { observing = false }, // disconnecting observation does not cancel owned work
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  } catch (error) { return astraErrorResponse(error) }
}
