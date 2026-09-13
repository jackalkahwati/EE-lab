'use client'

import { Analytics } from '@vercel/analytics/next'
import { usePathname } from 'next/navigation'
import { isStartPath } from '@/lib/start-draft'

export function PrivateAnalytics() {
  const pathname = usePathname()
  if (isStartPath(pathname)) return null
  return <Analytics beforeSend={(event) => {
    // Also guard an already-loaded SDK during a client-side navigation.
    if (isStartPath(window.location.pathname)) return null
    try { if (isStartPath(new URL(event.url).pathname)) return null } catch { return null }
    return event
  }} />
}
