'use client'

/**
 * Enterprise section nav — the "services" row across the program platform.
 * Every destination is a real, data-backed section (or an honest config
 * surface). Highlights the active route.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const LINKS: { href: string; label: string }[] = [
  { href: '/enterprise', label: 'Home' },
  { href: '/enterprise/approvals', label: 'Approvals' },
  { href: '/enterprise/quotes', label: 'Quotes' },
  { href: '/enterprise/validation', label: 'Validation' },
  { href: '/enterprise/catalog', label: 'Catalog' },
  { href: '/enterprise/budgets', label: 'Budgets' },
  { href: '/enterprise/activity', label: 'Activity' },
  { href: '/enterprise/audit', label: 'Audit' },
  { href: '/enterprise/iam', label: 'IAM' },
  { href: '/enterprise/integrations', label: 'Integrations' },
  { href: '/enterprise/settings', label: 'Settings' },
]

export function EnterpriseNav() {
  const pathname = usePathname()
  const active = (href: string) =>
    href === '/enterprise' ? pathname === '/enterprise' : pathname.startsWith(href)
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-border pb-2">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={cn('rounded-sm px-2.5 py-1 text-xs',
            active(l.href)
              ? 'bg-secondary font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground')}
        >
          {l.label}
        </Link>
      ))}
    </div>
  )
}
