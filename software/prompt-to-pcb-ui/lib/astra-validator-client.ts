import http from 'node:http'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const RESPONSE_LIMIT = 5 * 1024 * 1024
const VALIDATE_MS = 240_000
const CANCEL_MS = 90_000
const SHA = /^[a-f0-9]{64}$/
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export interface AstraValidatorResult {
  schema: 'astra-validator-result/v1'
  jobId: string
  workflowId: string
  boardSha256: string
  receipt: Record<string, unknown>
  /** Exact report text; independently hash/parse it before native publication. */
  rawDrc: string | null
  accounting: {
    requestedAt: string
    finishedAt: string
    stageMs: number
    runtimeMs: number
    totalMs: number
    cancelled: boolean
    cleanupConfirmed: boolean
  }
}

/** Safe fixed messages only. No request secrets, paths, or runtime diagnostics. */
export class AstraValidatorError extends Error {
  readonly category: 'configuration' | 'transport' | 'cancelled' | 'validation' | 'cleanup'
  readonly cleanupConfirmed: boolean
  constructor(category: AstraValidatorError['category'], cleanupConfirmed: boolean) {
    super(category === 'cleanup' ? 'Astra validator cleanup is unconfirmed.' : category === 'cancelled' ? 'Astra native validation was cancelled.' : 'Astra native validation is unavailable.')
    this.name = 'AstraValidatorError'
    this.category = category
    this.cleanupConfirmed = cleanupConfirmed
  }
}

async function credentials() {
  const socketPath = process.env.ASTRA_VALIDATOR_SOCKET
  const authSecret = process.env.ASTRA_VALIDATOR_SECRET
  if (!socketPath || !/^\/private\/tmp\/astra-v-[A-Za-z0-9]{6}\/control\.sock$/.test(socketPath) || !authSecret || !SHA.test(authSecret)) throw new AstraValidatorError('configuration', true)
  try {
    const root = path.dirname(socketPath), dir = await fs.lstat(root), socket = await fs.lstat(socketPath)
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid!() || (dir.mode & 0o777) !== 0o700 || await fs.realpath(root) !== root
      || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid!() || (socket.mode & 0o777) !== 0o600) throw Error('Invalid private endpoint')
  } catch { throw new AstraValidatorError('configuration', true) }
  return { socketPath, authSecret }
}

function request(config: { socketPath: string; authSecret: string }, operation: '/validate' | '/cancel', value: unknown, jobToken: string, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; value: unknown }> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length > 4096) { reject(new AstraValidatorError('validation', true)); return }
    let settled = false
    const req = http.request({ socketPath: config.socketPath, path: operation, method: 'POST', agent: false,
      maxHeaderSize: 4096,
      headers: { Authorization: `Bearer ${config.authSecret}`, 'X-Astra-Job-Token': jobToken, 'Content-Type': 'application/json', 'Content-Length': bytes.length, Connection: 'close' } })
    const finish = (error?: Error, result?: { status: number; value: unknown }) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) { req.destroy(); reject(error) } else resolve(result!)
    }
    const abort = () => finish(new AstraValidatorError('cancelled', false))
    const timer = setTimeout(() => finish(new AstraValidatorError('transport', false)), timeoutMs)
    req.on('error', () => finish(new AstraValidatorError('transport', false)))
    req.on('response', res => {
      const declared = res.headers['content-length']
      if (res.headers['content-type'] !== 'application/json' || res.headers['content-encoding'] || (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > RESPONSE_LIMIT))) {
        res.destroy(); finish(new AstraValidatorError('transport', false)); return
      }
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > RESPONSE_LIMIT) { res.destroy(); finish(new AstraValidatorError('transport', false)) } else chunks.push(chunk)
      })
      res.on('aborted', () => finish(new AstraValidatorError('transport', false)))
      res.on('error', () => finish(new AstraValidatorError('transport', false)))
      res.on('end', () => {
        if (!res.complete) { finish(new AstraValidatorError('transport', false)); return }
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
          finish(undefined, { status: res.statusCode ?? 0, value: JSON.parse(text) })
        } catch { finish(new AstraValidatorError('transport', false)) }
      })
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    if (!settled) req.end(bytes)
  })
}

/** The app registry authorizes the caller/workflow before invoking this method.
 * This module has no runtime/stager/Docker import and never selects a native root.
 * On EVERY uncertain termination it sends the known token over a fresh bounded
 * request and waits for confirmed cleanup before returning cancellation/failure.
 */
export async function validateAstraNativeJob(options: { jobId: string; boardSha256: string; workflowId: string; signal: AbortSignal }): Promise<AstraValidatorResult> {
  const { jobId, boardSha256, workflowId, signal } = options
  if (typeof jobId !== 'string' || !/^job-[A-Za-z0-9]{6}$/.test(jobId) || typeof boardSha256 !== 'string' || !SHA.test(boardSha256)
    || typeof workflowId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workflowId)) throw new AstraValidatorError('validation', true)
  if (signal.aborted) throw new AstraValidatorError('cancelled', true)
  const config = await credentials()
  if (signal.aborted) throw new AstraValidatorError('cancelled', true)
  const jobToken = randomBytes(32).toString('hex')
  try {
    const response = await request(config, '/validate', { jobId, boardSha256, workflowId }, jobToken, VALIDATE_MS, signal)
    const value = response.value
    if (response.status !== 200 || !record(value) || value.schema !== 'astra-validator-result/v1' || value.jobId !== jobId || value.workflowId !== workflowId || value.boardSha256 !== boardSha256
      || !record(value.receipt) || !(value.rawDrc === null || typeof value.rawDrc === 'string') || (typeof value.rawDrc === 'string' && Buffer.byteLength(value.rawDrc) > 4 * 1024 * 1024)
      || !record(value.accounting) || value.accounting.cleanupConfirmed !== true || value.error !== undefined
      || ['stageMs', 'runtimeMs', 'totalMs'].some(key => !Number.isSafeInteger(value.accounting && (value.accounting as Record<string, unknown>)[key]) || ((value.accounting as Record<string, number>)[key] < 0))
      || typeof value.accounting.requestedAt !== 'string' || typeof value.accounting.finishedAt !== 'string' || typeof value.accounting.cancelled !== 'boolean') throw new AstraValidatorError('validation', false)
    if (signal.aborted || value.accounting.cancelled) throw new AstraValidatorError('cancelled', false)
    return value as unknown as AstraValidatorResult
  } catch (error) {
    // Never pass the already-aborted workflow signal to the cleanup handshake.
    try {
      const response = await request(config, '/cancel', { jobId, workflowId, jobToken }, jobToken, CANCEL_MS)
      if (response.status !== 200 || !record(response.value) || response.value.schema !== 'astra-validator-cancel/v1'
        || response.value.jobId !== jobId || response.value.workflowId !== workflowId || response.value.cleanupConfirmed !== true) throw Error('Cleanup unconfirmed')
    } catch { throw new AstraValidatorError('cleanup', false) }
    throw new AstraValidatorError(signal.aborted || (error instanceof AstraValidatorError && error.category === 'cancelled') ? 'cancelled' : 'validation', true)
  }
}
