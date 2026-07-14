'use client'

/**
 * Left drawer nav for the enterprise console. Collapsible: icon-only by default,
 * toggle to an expanded rail with labels (preference persisted per browser).
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
    const v = localStorage.getItem(PREF_KEY)
    if (v !== null) setExpanded(v === '1')
  }, [])

  const toggle = () =>
    setExpanded((v) => {
      const next = !v
      localStorage.setItem(PREF_KEY, next ? '1' : '0')
      return next
    })

  const active = (href: string) =>
    href === '/enterprise' ? pathname === '/enterprise' : pathname.startsWith(href)

  return (
    <nav
      aria-label="Enterprise sections"
      className={cn(
        'sticky top-9 flex h-[calc(100dvh-2.25rem)] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-card/30 py-2 transition-[width] duration-150',
        expanded ? 'w-48' : 'w-14',
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-expanded={expanded}
        title={expanded ? 'Collapse' : 'Expand'}
        className="mx-1.5 mb-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
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
            className={cn(
              'mx-1.5 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs',
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
