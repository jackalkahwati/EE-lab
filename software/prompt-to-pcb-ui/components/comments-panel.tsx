'use client'

/**
 * Comment threads (Phase 5) — anchored to artifacts of the selected run's
 * product. Owner + shared members read and write; anchors keep a comment
 * attached to the thing it's about (a BOM ref, the fit check, a sim domain,
 * or the revision itself).
 */
import { useEffect, useState } from 'react'
import { MessageSquare, Send, X } from 'lucide-react'

type Comment = { id: string; runId: string; anchor: string; author: string; text: string; createdAt: string }

const ANCHORS = ['general', 'rev', 'bom', 'mech:fitCheck', 'sim:thermal', 'sim:structural', 'supply', 'validation']

export function CommentsPanel({ runId }: { runId?: string }) {
  const [productId, setProductId] = useState<string | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [text, setText] = useState('')
  const [anchor, setAnchor] = useState('general')
  const [busy, setBusy] = useState(false)
  const [me, setMe] = useState('')

  useEffect(() => {
    setProductId(null); setComments([])
    if (!runId) return
    let off = false
    fetch(`/api/products?run=${encodeURIComponent(runId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (off || !d?.product) return
        setProductId(d.product.productId)
        return fetch(`/api/products/comments?productId=${encodeURIComponent(d.product.productId)}&runId=${encodeURIComponent(runId)}`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((c) => { if (!off && c) setComments(c.comments ?? []) })
      })
      .catch(() => {})
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off && d?.user?.email) setMe(String(d.user.email).toLowerCase()) })
      .catch(() => {})
    return () => { off = true }
  }, [runId])

  if (!runId || !productId) return null

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const r = await fetch('/api/products/comments', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productId, ...body }),
      })
      if (r.ok) {
        const c = await fetch(`/api/products/comments?productId=${encodeURIComponent(productId!)}&runId=${encodeURIComponent(runId!)}`, { cache: 'no-store' }).then((x) => x.json())
        setComments(c.comments ?? [])
      }
    } catch { /* list simply doesn't change */ }
    setBusy(false)
  }

  return (
    <div className="border-t border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <MessageSquare className="size-3 text-muted-foreground" />
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          comments · {comments.length}
        </span>
      </div>
      <div className="max-h-48 space-y-1.5 overflow-y-auto">
        {comments.map((c) => (
          <div key={c.id} className="group rounded-sm border border-border bg-card/40 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[9px] text-primary">{c.anchor}</span>
              <span className="truncate font-mono text-[9px] text-muted-foreground">{c.author.split('@')[0]}</span>
              <span className="ml-auto shrink-0 font-mono text-[8px] text-muted-foreground/60">{c.createdAt.slice(5, 16).replace('T', ' ')}</span>
              {(c.author.toLowerCase() === me) && (
                <button type="button" onClick={() => void post({ deleteId: c.id })}
                  className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100">
                  <X className="size-3" />
                </button>
              )}
            </div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-foreground">{c.text}</div>
          </div>
        ))}
        {!comments.length && (
          <p className="px-1 text-[10.5px] text-muted-foreground">No comments on this revision yet.</p>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <select value={anchor} onChange={(e) => setAnchor(e.target.value)}
          className="shrink-0 rounded-sm border border-border bg-background px-1 py-0.5 font-mono text-[9px]">
          {ANCHORS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { void post({ runId, anchor: anchor === 'rev' ? `rev:${runId}` : anchor, text: text.trim() }); setText('') } }}
          placeholder="comment…"
          className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px] outline-none focus:border-primary/60" />
        <button type="button" disabled={busy || !text.trim()}
          onClick={() => { void post({ runId, anchor: anchor === 'rev' ? `rev:${runId}` : anchor, text: text.trim() }); setText('') }}
          className="shrink-0 rounded-sm border border-border p-1 text-muted-foreground hover:text-primary disabled:opacity-40">
          <Send className="size-3" />
        </button>
      </div>
    </div>
  )
}
