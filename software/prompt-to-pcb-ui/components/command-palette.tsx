'use client'

/**
 * Global command palette (Cmd/Ctrl-K) — the AWS "Option+S" search analog.
 * Jumps to enterprise sections and to real entities (programs, boards,
 * members) from the store. Self-contained; opens on shortcut, filters live.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

type Item = { label: string; sub: string; href: string; kind: string }

const SECTIONS: Item[] = [
  { label: 'Programs', sub: 'portfolio home', href: '/enterprise', kind: 'section' },
  { label: 'Approvals', sub: 'decisions queue', href: '/enterprise/approvals', kind: 'section' },
  { label: 'Quotes', sub: 'procurement', href: '/enterprise/quotes', kind: 'section' },
  { label: 'Validation', sub: 'FL-1 sessions', href: '/enterprise/validation', kind: 'section' },
  { label: 'Catalog', sub: 'templates + capability', href: '/enterprise/catalog', kind: 'section' },
  { label: 'Budgets', sub: 'credits + alerts', href: '/enterprise/budgets', kind: 'section' },
  { label: 'Activity', sub: 'event feed', href: '/enterprise/activity', kind: 'section' },
  { label: 'Audit', sub: 'tamper-evident log', href: '/enterprise/audit', kind: 'section' },
  { label: 'IAM', sub: 'users + roles', href: '/enterprise/iam', kind: 'section' },
  { label: 'Integrations', sub: 'EDA + API + SSO', href: '/enterprise/integrations', kind: 'section' },
  { label: 'Settings', sub: 'billing + security', href: '/enterprise/settings', kind: 'section' },
  { label: 'Compose', sub: 'design workspace', href: '/compose', kind: 'section' },
]

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [db, setDb] = useState<Record<string, any> | null>(null)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setOpen((v) => !v)
      } else if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) {
      setQ(''); setSel(0)
      setTimeout(() => inputRef.current?.focus(), 20)
      if (!db) fetch('/api/enterprise', { cache: 'no-store' })
        .then((r) => r.json()).then((d) => !d.error && setDb(d)).catch(() => {})
    }
  }, [open, db])

  const items = useMemo(() => {
    const list: Item[] = [...SECTIONS]
    if (db) {
      for (const p of db.programs ?? [])
        list.push({ label: p.name, sub: 'program', href: '/enterprise', kind: 'program' })
      for (const b of db.boards ?? [])
        list.push({ label: b.name, sub: `board · ${b.readiness?.replace(/_/g, ' ')}`, href: '/enterprise', kind: 'board' })
      for (const m of db.members ?? [])
        list.push({ label: m.actor, sub: `user · ${m.role?.replace(/_/g, ' ')}`, href: '/enterprise/iam', kind: 'user' })
    }
    const ql = q.trim().toLowerCase()
    return (ql ? list.filter((i) => (i.label + ' ' + i.sub).toLowerCase().includes(ql)) : list).slice(0, 30)
  }, [db, q])

  const go = useCallback((it: Item) => { setOpen(false); router.push(it.href) }, [router])

  if (pathname === '/login' || !open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh]"
      onClick={() => setOpen(false)}>
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
            else if (e.key === 'Enter' && items[sel]) go(items[sel])
          }}
          placeholder="Search programs, boards, users, sections…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {items.length === 0 && <p className="px-4 py-3 text-xs text-muted-foreground">No matches.</p>}
          {items.map((it, i) => (
            <button
              key={`${it.kind}-${it.label}-${i}`}
              type="button"
              onMouseEnter={() => setSel(i)}
              onClick={() => go(it)}
              className={cn('flex w-full items-center gap-3 px-4 py-1.5 text-left',
                i === sel ? 'bg-secondary' : 'hover:bg-secondary/50')}>
              <span className="w-16 shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{it.kind}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{it.label}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{it.sub}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-border px-4 py-1.5 font-mono text-[9px] text-muted-foreground">
          ↑↓ navigate · ↵ open · esc close · ⌘K toggle
        </div>
      </div>
    </div>
  )
}
