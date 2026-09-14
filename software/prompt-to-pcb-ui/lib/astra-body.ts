import { AstraError } from './astra-execution'

/** Bound streamed requests before parsing; Content-Length alone is not trustworthy. */
export async function readAstraBody(req: Request, maxBytes = 32 * 1024): Promise<unknown> {
  const reader = req.body?.getReader()
  if (!reader) throw new AstraError('policy', 'A JSON request body is required.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void reader.cancel().catch(() => {})
        reject(new AstraError('timeout', 'Astra request body timed out.'))
      }, 10_000)
    })
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        // An underlying stream cancel hook may never settle; rejection must not wait for it.
        void reader.cancel().catch(() => {})
        throw new AstraError('policy', 'Astra request body exceeds its size limit.')
      }
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new AstraError('policy', 'Invalid Astra JSON body.') }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}
