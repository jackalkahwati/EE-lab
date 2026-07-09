'use client'

/**
 * Global product nav. Frames Compose as an enterprise board-program platform:
 * Programs (the portfolio front door) is primary; Compose is the design tool.
 * Self-hides on /login so the auth screen stays chromeless.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const LINKS: { href: string; label: string; hint: string }[] = [
  { href: '/', label: 'Programs', hint: 'board-program portfolio' },
  { href: '/compose', label: 'Compose', hint: 'design tool' },
  { href: '/compose2', label: 'Compose 2', hint: 'new three-pane layout (preview)' },
]

export function TopNav() {
  const pathname = usePathname()
  if (pathname === '/login') return null

  const active = (href: string) =>
    href === '/' ? pathname === '/' || pathname.startsWith('/enterprise')
      : pathname.startsWith(href)

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
      <div className="flex h-11 items-center gap-4 px-4">
        <Link href="/" className="flex items-center">
          <span className="text-sm font-semibold tracking-tight">FirstLight Compose</span>
        </Link>
        <nav className="flex items-center gap-1" aria-label="Primary">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs',
                active(l.href)
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground')}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
          className="ml-auto hidden items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground sm:flex"
        >
          Search <kbd className="rounded bg-muted px-1 font-mono text-[9px]">⌘K</kbd>
        </button>
      </div>
    </header>
  )
}
