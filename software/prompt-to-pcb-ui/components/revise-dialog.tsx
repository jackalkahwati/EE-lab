'use client'

/**
 * Spec-level revise: describe a change, see the block-list diff the architect
 * model proposes, then launch the Rev pipeline with parent lineage.
 */

import { useEffect, useState } from 'react'
import { GitBranch, Loader2, X, ArrowRight } from 'lucide-react'
import { llmHeaders } from '@/components/llm-settings'

interface Revision {
  parentId: string
  blocks: string[]
  boardClass: string
  note: string
  changed: boolean
  prompt: string
  error?: string
}

export function ReviseDialog({
  runId,
  runName,
  currentBlocks,
  initialRequest,
  onLaunch,
  onClose,
}: {
  runId: string
  runName: string
  currentBlocks: string[] | null
  initialRequest?: string
  onLaunch: (
    prompt: string,
    compose: { blocks: string[]; boardClass: string },
    rev: { parentId: string; revNote: string },
  ) => void
  onClose: () => void
}) {
  const [request, setRequest] = useState(initialRequest ?? '')
  const [rev, setRev] = useState<Revision | null>(null)
  const [busy, setBusy] = useState(false)
  const [parentBlocks, setParentBlocks] = useState<string[] | null>(currentBlocks)

  // parent's block list for the visual diff (from its persisted run report)
  useEffect(() => {
    if (parentBlocks) return
    fetch(`/runs/${runId}/data/last-run.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const b = d?.composeSpec?.blocks
        if (Array.isArray(b)) setParentBlocks(b)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  async function propose() {
    if (!request.trim()) return
    setBusy(true)
    setRev(null)
    try {
      const r = await fetch('/api/revise', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ runId, request }),
      })
      setRev((await r.json()) as Revision)
    } catch (e) {
      setRev({ error: String(e) } as Revision)
    } finally {
      setBusy(false)
    }
  }

  const removed = (parentBlocks ?? []).filter((b) => !(rev?.blocks ?? []).includes(b))
  const added = (rev?.blocks ?? []).filter((b) => !(parentBlocks ?? []).includes(b))

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-md border border-border bg-card p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Revise board</span>
            <span className="font-mono text-[10px] text-muted-foreground">{runName}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          rows={2}
          autoFocus
          placeholder="What should change? e.g. add a pressure sensor · drop the GNSS · swap LoRa for cellular"
          className="mb-3 w-full resize-none rounded-sm border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />

        {!rev && (
          <button
            type="button"
            onClick={propose}
            disabled={busy || !request.trim()}
            className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
            {busy ? 'Proposing…' : 'Propose revision'}
          </button>
        )}

        {rev?.error && (
          <p className="rounded-sm border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {rev.error}
          </p>
        )}

        {rev && !rev.error && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{rev.note}</p>
            <div className="flex flex-wrap gap-1.5">
              {(rev.blocks ?? []).map((b) => (
                <span
                  key={b}
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                    added.includes(b)
                      ? 'border-success/50 bg-success/10 text-success'
                      : 'border-border text-muted-foreground'
                  }`}
                >
                  {added.includes(b) ? '+ ' : ''}
                  {b}
                </span>
              ))}
              {removed.map((b) => (
                <span
                  key={b}
                  className="rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 font-mono text-[10px] text-destructive line-through"
                >
                  {b}
                </span>
              ))}
            </div>
            {!rev.changed && (
              <p className="text-[11px] text-muted-foreground">
                The architect model reports no block-level change is needed for this request.
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  onLaunch(
                    rev.prompt,
                    { blocks: rev.blocks, boardClass: rev.boardClass },
                    { parentId: rev.parentId, revNote: rev.note },
                  )
                }
                className="rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                Generate revision
              </button>
              <button
                type="button"
                onClick={() => setRev(null)}
                className="rounded-sm border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Edit request
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
