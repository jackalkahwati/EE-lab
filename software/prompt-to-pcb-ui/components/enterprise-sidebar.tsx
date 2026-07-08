'use client'

/**
 * Left drawer nav for the enterprise console. Icons + labels, active-route
 * highlight. Rendered once by app/enterprise/layout.tsx so every section
 * inherits it; content renders to the right.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  Activity, BarChart3, Boxes, CheckSquare, Coins, LayoutDashboard,
  Plug, Receipt, ScrollText, Settings, Users,
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

export function EnterpriseSidebar() {
  const pathname = usePathname()
  const active = (href: string) =>
    href === '/enterprise' ? pathname === '/enterprise' : pathname.startsWith(href)
  return (
    <nav
      aria-label="Enterprise sections"
      className="sticky top-11 flex h-[calc(100dvh-2.75rem)] w-14 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-card/30 py-2 lg:w-48"
    >
      {LINKS.map(({ href, label, Icon }) => {
        const on = active(href)
        return (
          <Link
            key={href}
            href={href}
            title={label}
            className={cn(
              'mx-1.5 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs',
              on
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground')}
          >
            <Icon className={cn('size-4 shrink-0', on && 'text-primary')} />
            <span className="hidden lg:inline">{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
