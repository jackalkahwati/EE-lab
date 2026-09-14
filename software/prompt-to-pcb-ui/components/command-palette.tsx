'use client'

/**
 * Global command palette (Cmd/Ctrl-K) — the AWS "Option+S" search analog.
 * Jumps to enterprise sections and to real entities (programs, boards,
 * members) from the store. Self-contained; opens on shortcut, filters live.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
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
  const resultsId = useId()
  const [isEnterprise, setIsEnterprise] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/auth/me').then((r) => r.json())
      .then((d) => { if (alive) setIsEnterprise(d?.user?.plan === 'enterprise') })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (pathname === '/login') return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pathname])

  useEffect(() => {
    if (open) { setQ(''); setSel(0) }
  }, [open])

  useEffect(() => {
    if (!open || !isEnterprise || db) return
    let alive = true
    fetch('/api/enterprise', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (alive && d && !d.error) setDb(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [open, isEnterprise, db])

  const items = useMemo(() => {
    // Presentation follows the header's plan check; server permissions remain authoritative.
    const list: Item[] = isEnterprise ? [...SECTIONS] : [
      { label: 'Compose', sub: 'design workspace', href: '/compose', kind: 'section' },
      { label: 'Plans', sub: 'available plans', href: '/pricing', kind: 'section' },
    ]
    if (isEnterprise && db) {
      for (const p of db.programs ?? [])
        list.push({ label: p.name, sub: 'program', href: '/enterprise', kind: 'program' })
      for (const b of db.boards ?? [])
        list.push({ label: b.name, sub: `board · ${b.readiness?.replace(/_/g, ' ')}`, href: '/enterprise', kind: 'board' })
      for (const m of db.members ?? [])
        list.push({ label: m.actor, sub: `user · ${m.role?.replace(/_/g, ' ')}`, href: '/enterprise/iam', kind: 'user' })
    }
    const ql = q.trim().toLowerCase()
    return (ql ? list.filter((i) => (i.label + ' ' + i.sub).toLowerCase().includes(ql)) : list).slice(0, 30)
  }, [db, q, isEnterprise])

  useEffect(() => {
    if (open) document.getElementById(`${resultsId}-${sel}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, resultsId, sel])

  const go = useCallback((it: Item) => { setOpen(false); router.push(it.href) }, [router])

  if (pathname === '/login') return null

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/40" />
        <Dialog.Popup
          initialFocus={inputRef}
          className="fixed left-1/2 top-[12vh] z-[61] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <Dialog.Title className="text-xs font-semibold">Search workspace</Dialog.Title>
          <Dialog.Close aria-label="Close search" className="rounded-sm p-1 text-muted-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-primary">
            <X className="size-4" />
          </Dialog.Close>
        </div>
        <Dialog.Description className="sr-only">Choose a destination with the arrow keys and Enter.</Dialog.Description>
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Search workspace"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={resultsId}
          aria-activedescendant={items[sel] ? `${resultsId}-${sel}` : undefined}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.max(0, Math.min(items.length - 1, s + 1))) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
            else if (e.key === 'Enter' && items[sel]) go(items[sel])
          }}
          placeholder={isEnterprise ? 'Search programs, boards, users, sections…' : 'Search workspace…'}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
        />
        {items.length === 0 && <p role="status" className="px-4 py-3 text-xs text-muted-foreground">No matches.</p>}
        <div id={resultsId} role="listbox" aria-label="Destinations" className="max-h-[min(20rem,50dvh)] overflow-y-auto py-1">
          {items.map((it, i) => (
            <div
              key={`${it.kind}-${it.label}-${i}`}
              id={`${resultsId}-${i}`}
              role="option"
              aria-selected={i === sel}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSel(i)}
              onClick={() => go(it)}
              className={cn('flex w-full items-center gap-3 px-4 py-1.5 text-left',
                i === sel ? 'bg-secondary' : 'hover:bg-secondary/50')}>
              <span className="w-16 shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{it.kind}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{it.label}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{it.sub}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-border px-4 py-1.5 font-mono text-[9px] text-muted-foreground">
          ↑↓ navigate · ↵ open · esc close · ⌘K toggle
        </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
