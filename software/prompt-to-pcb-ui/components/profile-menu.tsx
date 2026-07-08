'use client'

/**
 * Account menu (header / sidebar). Enterprise-only: identity, a read-only
 * credit indicator, a link to workspace Settings (where org plan, billing,
 * usage, members, and security live), and sign out. Self-serve $49/mo + credit
 * packs were removed — Compose is licensed to orgs as board-program bundles,
 * and billing is managed by an admin in Settings, not bought from a popover.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CircleUserRound, Settings, Zap } from 'lucide-react'

interface Me {
  email: string
  credits: number
  monthlyCredits: number
}

export function ProfileMenu({ variant = 'header' }: { variant?: 'header' | 'sidebar' }) {
  const [me, setMe] = useState<Me | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => setMe(d.user))
      .catch(() => {})
  }, [])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.href = '/login'
  }

  const initial = me?.email?.[0]?.toUpperCase()

  return (
    <div className="relative" ref={ref}>
      {variant === 'sidebar' ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-sm border border-border bg-card px-2 py-1.5 text-left hover:border-primary/40"
          aria-label="Account"
        >
          {initial ? (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-primary">
              {initial}
            </span>
          ) : (
            <CircleUserRound className="size-6 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] font-medium text-foreground">
              {me?.email ?? 'Account'}
            </span>
            <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
              <Zap className="size-2.5 text-primary" />
              {me ? `${me.credits} credits` : '…'}
            </span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-full border border-border px-1.5 py-1 hover:border-primary/50"
          aria-label="Account"
        >
          {initial ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
              {initial}
            </span>
          ) : (
            <CircleUserRound className="size-5 text-muted-foreground" />
          )}
        </button>
      )}

      {open && me && (
        <div
          className={
            variant === 'sidebar'
              ? 'absolute bottom-full left-0 z-50 mb-2 w-64 rounded-md border border-border bg-card p-3 shadow-xl'
              : 'absolute right-0 top-9 z-50 w-64 rounded-md border border-border bg-card p-3 shadow-xl'
          }
        >
          <p className="mb-0.5 truncate text-xs font-semibold text-foreground">{me.email}</p>
          <p className="mb-3 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            billing is managed per organization in Settings
          </p>

          <div className="mb-3 flex items-center justify-between rounded-sm border border-border bg-background px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Zap className="size-3.5 text-primary" /> Credits
            </span>
            <span className="font-mono text-sm font-semibold text-foreground">{me.credits}</span>
          </div>

          <Link
            href="/enterprise/settings"
            onClick={() => setOpen(false)}
            className="mb-1.5 flex w-full items-center gap-1.5 rounded-sm border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40 hover:bg-primary/5"
          >
            <Settings className="size-3.5 text-muted-foreground" />
            Workspace settings
            <span className="ml-auto font-mono text-[9px] text-muted-foreground">
              plan · usage · members
            </span>
          </Link>

          <button
            type="button"
            onClick={signOut}
            className="mt-2 w-full rounded-sm border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
