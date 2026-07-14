'use client'

/**
 * Global product nav. Frames Compose as an enterprise board-program platform:
 * Programs (the portfolio front door) is primary; Compose is the design tool.
 * Self-hides on /login so the auth screen stays chromeless.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { ProfileMenu } from '@/components/profile-menu'

const LINKS: { href: string; label: string; hint: string }[] = [
  { href: '/', label: 'Programs', hint: 'board-program portfolio' },
  { href: '/compose', label: 'Compose', hint: 'design tool' },
]

export function TopNav() {
  const pathname = usePathname()
  if (pathname === '/login') return null

  // Programs also lights up on the enterprise console ('/' redirects there) —
  // both are portfolio surfaces; /programs is the nav's canonical target.
  const active = (href: string) =>
    href === '/programs'
      ? pathname.startsWith('/programs') || pathname === '/' || pathname.startsWith('/enterprise')
      : pathname.startsWith(href)

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
      <div className="flex h-9 items-center gap-3 px-3">
        <Link href="/" className="flex items-center">
          <span className="text-xs font-semibold tracking-tight">Firstlight</span>
        </Link>
        <nav className="flex h-full items-center" aria-label="Primary">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                'flex h-full items-center px-2.5 text-[11.5px]',
                active(l.href)
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground')}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
            className="hidden items-center gap-1.5 border border-border bg-card/50 px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground sm:flex"
          >
            Search <kbd className="bg-muted px-1 font-mono text-[9px]">⌘K</kbd>
          </button>
          <ProfileMenu />
        </div>
      </div>
    </header>
  )
}
