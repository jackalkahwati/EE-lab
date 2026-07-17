/**
 * Thin HTTP client for the FirstLight Compose v1 API. Shared by the CLI and
 * the MCP server. Auth: FIRSTLIGHT_API_KEY (flk_live_…, minted in the
 * Integrations console); host: FIRSTLIGHT_URL (default app.firstlight.build).
 */
import { writeFile, readFile } from 'node:fs/promises'
import { basename } from 'node:path'

export class FirstlightClient {
  constructor({ baseUrl, apiKey } = {}) {
    this.baseUrl = (baseUrl || process.env.FIRSTLIGHT_URL || 'https://app.firstlight.build').replace(/\/$/, '')
    this.apiKey = apiKey || process.env.FIRSTLIGHT_API_KEY || ''
    if (!this.apiKey) throw new Error('FIRSTLIGHT_API_KEY is not set (mint one in Compose → Integrations)')
  }

  async #json(method, path, body) {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    let d
    try { d = await r.json() } catch { throw new Error(`${method} ${path} → HTTP ${r.status} (non-JSON body)`) }
    if (!r.ok) throw new Error(d?.error ? String(d.error) : `${method} ${path} → HTTP ${r.status}`)
    return d
  }

  /**
   * Start a product from an EXISTING design instead of a prompt: a PCBA
   * (.kicad_pcb) and/or a CAD assembly (.step). The board is verified with real
   * KiCad DRC on ingest; the assembly lands as geometry with its fit check
   * nulled. Returns the new run/product ids + the board's honest stats.
   */
  async importDesign({ pcbPath, stepPath, name } = {}) {
    if (!pcbPath && !stepPath) throw new Error('provide a .kicad_pcb (--pcb) and/or a .step (--step)')
    const fd = new FormData()
    if (pcbPath) fd.append('pcb', new Blob([await readFile(pcbPath)]), basename(pcbPath))
    if (stepPath) fd.append('step', new Blob([await readFile(stepPath)]), basename(stepPath))
    if (name) fd.append('name', name)
    const r = await fetch(`${this.baseUrl}/api/v1/imports`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: fd,
    })
    let d
    try { d = await r.json() } catch { throw new Error(`POST /api/v1/imports → HTTP ${r.status} (non-JSON body)`) }
    if (!r.ok) throw new Error(d?.error ? String(d.error) : `POST /api/v1/imports → HTTP ${r.status}`)
    return d
  }

  createBoard(prompt) { return this.#json('POST', '/api/v1/boards', { prompt }) }
  rebuildRun(runId) { return this.#json('POST', '/api/v1/boards', { rebuildRunId: runId }) }
  runStatus(runId) { return this.#json('GET', `/api/v1/runs/${encodeURIComponent(runId)}`) }
  listArtifacts(runId) { return this.#json('GET', `/api/v1/runs/${encodeURIComponent(runId)}/artifacts`) }
  listBoards() { return this.#json('GET', '/api/v1/boards') }

  async downloadArtifact(runId, kind, outPath) {
    const r = await fetch(`${this.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(kind)}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    })
    if (!r.ok) {
      const d = await r.json().catch(() => null)
      throw new Error(d?.error ? String(d.error) : `download ${kind} → HTTP ${r.status}`)
    }
    const buf = Buffer.from(await r.arrayBuffer())
    await writeFile(outPath, buf)
    return { outPath, bytes: buf.byteLength, mime: r.headers.get('content-type') ?? '' }
  }

  /** Poll a run until it leaves queued/running. onTick gets each status snapshot. */
  async waitForRun(runId, { intervalMs = 10_000, timeoutMs = 30 * 60_000, onTick } = {}) {
    const t0 = Date.now()
    for (;;) {
      const s = await this.runStatus(runId)
      onTick?.(s)
      if (s.status !== 'queued' && s.status !== 'running') return s
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${Math.round(timeoutMs / 60000)} min (run still ${s.status})`)
      await new Promise((res) => setTimeout(res, intervalMs))
    }
  }
}
