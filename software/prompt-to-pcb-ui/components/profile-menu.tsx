'use client'

/**
 * Account popover (header / sidebar): identity, read-only credits and sign out.
 * Enterprise accounts link to workspace Settings; other plans link to the
 * public plan comparison. Billing operations stay on their existing surfaces.
 */

import { useEffect, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import Link from 'next/link'
import { CircleUserRound, Settings, X, Zap } from 'lucide-react'

interface Me {
  email: string
  credits: number
  monthlyCredits: number
  plan: string
}

export function ProfileMenu({ variant = 'header' }: { variant?: 'header' | 'sidebar' }) {
  const [me, setMe] = useState<Me | null>(null)
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => setMe(d.user))
      .catch(() => {})
  }, [])

  async function signOut() {
    if (signingOut) return
    setSigningOut(true)
    setError('')
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      if (!response.ok) throw new Error('logout failed')
      window.location.href = '/login'
    } catch {
      setError('Could not sign out. Please try again.')
    } finally {
      setSigningOut(false)
    }
  }

  const initial = me?.email?.[0]?.toUpperCase()

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {variant === 'sidebar' ? (
        <Popover.Trigger
          type="button"
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
        </Popover.Trigger>
      ) : (
        <Popover.Trigger
          type="button"
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
        </Popover.Trigger>
      )}

      <Popover.Portal>
        <Popover.Positioner side={variant === 'sidebar' ? 'top' : 'bottom'} align={variant === 'sidebar' ? 'start' : 'end'} sideOffset={8} className="z-[60]">
        <Popover.Popup className="w-64 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-card p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Popover.Title className="text-xs font-semibold">Account</Popover.Title>
            <Popover.Close aria-label="Close account" className="rounded-sm p-1 text-muted-foreground hover:bg-secondary">
              <X className="size-4" />
            </Popover.Close>
          </div>
          {me ? <>
          <p className="mb-0.5 truncate text-xs font-semibold text-foreground">{me.email}</p>
          <p className="mb-3 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {me.plan === 'enterprise' ? 'billing is managed per organization in Settings' : `${me.plan} plan`}
          </p>

          <div className="mb-3 flex items-center justify-between rounded-sm border border-border bg-background px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Zap className="size-3.5 text-primary" /> Credits
            </span>
            <span className="font-mono text-sm font-semibold text-foreground">{me.credits}</span>
          </div>

          <Link
            href={me.plan === 'enterprise' ? '/enterprise/settings' : '/pricing'}
            onClick={() => setOpen(false)}
            className="mb-1.5 flex w-full items-center gap-1.5 rounded-sm border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40 hover:bg-primary/5"
          >
            <Settings className="size-3.5 text-muted-foreground" />
            {me.plan === 'enterprise' ? 'Workspace settings' : 'View plans'}
            {me.plan === 'enterprise' && <span className="ml-auto font-mono text-[9px] text-muted-foreground">
              plan · usage · members
            </span>}
          </Link>

          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="mt-2 w-full rounded-sm border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
          {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
          </> : <p className="text-xs text-muted-foreground">Account details unavailable. <Link href="/login" className="underline">Sign in</Link></p>}
        </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
