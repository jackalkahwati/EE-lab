'use client'

/**
 * Enterprise navigation: horizontal scroll strip on mobile, left rail on desktop.
 * Icon-only by default; label visibility is persisted per browser.
 * Rendered once by app/enterprise/layout.tsx so every section inherits it.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Activity, BarChart3, Boxes, CheckSquare, Coins, LayoutDashboard,
  PanelLeftClose, PanelLeftOpen, Plug, Receipt, ScrollText, Settings, Users,
} from 'lucide-react'

const LINKS = [
  { href: '/enterprise', label: 'Home', Icon: LayoutDashboard },
  { href: '/enterprise/approvals', label: 'Approvals', Icon: CheckSquare },
  { href: '/enterprise/quotes', label: 'Quotes', Icon: Receipt },
  { href: '/enterprise/validation', label: 'Validation', Icon: BarChart3 },
  { href: '/enterprise/catalog', label: 'Catalog', Icon: Boxes },
  { href: '/enterprise/budgets', label: 'Budgets', Icon: Coins },
  { href: '/enterprise/activity', label: 'Activity', Icon: Activity },
  { href: '/enterprise/audit', label: 'Audit', Icon: ScrollText },
  { href: '/enterprise/iam', label: 'IAM', Icon: Users },
  { href: '/enterprise/integrations', label: 'Integrations', Icon: Plug },
  { href: '/enterprise/settings', label: 'Settings', Icon: Settings },
]

const PREF_KEY = 'ent-sidebar-expanded'

export function EnterpriseSidebar() {
  const pathname = usePathname()
  const [expanded, setExpanded] = useState(false)

  // restore the saved expand/collapse preference
  useEffect(() => {
    try {
      const v = localStorage.getItem(PREF_KEY)
      if (v !== null) setExpanded(v === '1')
    } catch { /* Keep the default when browser preferences are unavailable. */ }
  }, [])

  const toggle = () =>
    setExpanded((v) => {
      const next = !v
      try { localStorage.setItem(PREF_KEY, next ? '1' : '0') } catch { /* Toggle still works for this visit. */ }
      return next
    })

  const active = (href: string) =>
    pathname === href || (href !== '/enterprise' && pathname.startsWith(`${href}/`))

  return (
    <nav
      aria-label="Enterprise sections"
      className={cn(
        'flex w-full min-w-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-card/30 py-2 sm:sticky sm:top-9 sm:h-[calc(100dvh-2.25rem)] sm:flex-col sm:items-stretch sm:overflow-x-hidden sm:overflow-y-auto sm:border-r sm:border-b-0 sm:transition-[width] sm:duration-150',
        expanded ? 'sm:w-48' : 'sm:w-14',
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-expanded={expanded}
        title={expanded ? 'Collapse' : 'Expand'}
        className="mx-1.5 flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground sm:mb-1"
      >
        {expanded ? (
          <PanelLeftClose className="size-4 shrink-0" />
        ) : (
          <PanelLeftOpen className="size-4 shrink-0" />
        )}
        {expanded && <span>Collapse</span>}
      </button>

      {LINKS.map(({ href, label, Icon }) => {
        const on = active(href)
        return (
          <Link
            key={href}
            href={href}
            title={expanded ? undefined : label}
            aria-label={label}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'mx-1.5 flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs',
              on
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground')}
          >
            <Icon className={cn('size-4 shrink-0', on && 'text-primary')} />
            {expanded && <span>{label}</span>}
          </Link>
        )
      })}
    </nav>
  )
}
