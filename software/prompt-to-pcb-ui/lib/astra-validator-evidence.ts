import { createHash } from 'node:crypto'
import { AstraError } from './astra-execution'
import { parseAstraDrcReport } from './astra-drc'
import { validateAstraValidatorContainment } from './astra-validator-containment'
import type { AstraValidatorResult } from './astra-validator-client'

export const ASTRA_VALIDATOR_IMAGE = 'kicad/kicad@sha256:fdcfa0e8d41f640d16edfb28e027fe8862ab31af9e45dcacbc662cec5c916e4c'
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const deny = (): never => { throw new AstraError('output', 'Linux native validation evidence is incomplete or mismatched.') }
type ExpectedEvidence = { board: Buffer; input: string; evidence: Buffer }

/** Validate raw native evidence, without manufacturing a transport envelope. */
export function validateAstraRuntimeEvidence(receipt: unknown, rawDrc: unknown, expected: ExpectedEvidence) {
  if (typeof rawDrc !== 'string' || Buffer.byteLength(rawDrc) > 4 * 1024 * 1024) return deny()
  if (!object(receipt) || receipt.schema !== 'astra-linux-job-runtime/v1' || receipt.image !== ASTRA_VALIDATOR_IMAGE
    || receipt.boardSha256 !== hash(expected.board) || receipt.nativeInputSha256 !== hash(expected.input)
    || receipt.nativeEvidenceSha256 !== hash(expected.evidence) || receipt.reportSha256 !== hash(rawDrc)
    || receipt.executionComplete !== true || receipt.inputsUnchanged !== true || receipt.schematicParity !== 'not-run'
    || receipt.failure !== undefined || receipt.cleanupFailure !== undefined || receipt.integrityFailure !== undefined
    || receipt.storageFailure !== undefined || receipt.cancelled === true
    || !object(receipt.cleanup) || receipt.cleanup.confirmedAbsent !== true
    || !object(receipt.process) || receipt.process.code !== 0 || receipt.process.reason != null || receipt.process.signal != null
    || !object(receipt.finalState) || receipt.finalState.Running !== false || receipt.finalState.OOMKilled !== false || receipt.finalState.ExitCode !== 0) return deny()
  try {
    validateAstraValidatorContainment(receipt)
    const parsed = parseAstraDrcReport(JSON.parse(rawDrc), { engineVersion: '10.0.5', source: 'final-board.kicad_pcb', schematicParity: 'not-run' })
    if (receipt.checksComplete !== parsed.checksComplete) return deny()
    return { bytes: Buffer.from(rawDrc, 'utf8'), parsed }
  } catch { return deny() }
}

/** The socket response is transport data, not proof of a clean board. */
export function validateAstraValidatorEvidence(result: AstraValidatorResult, expected: ExpectedEvidence & { jobId: string; workflowId: string }) {
  if (result.schema !== 'astra-validator-result/v1' || result.jobId !== expected.jobId || result.workflowId !== expected.workflowId
    || result.boardSha256 !== hash(expected.board) || !result.accounting || result.accounting.cancelled !== false
    || result.accounting.cleanupConfirmed !== true) return deny()
  return validateAstraRuntimeEvidence(result.receipt, result.rawDrc, expected)
}
