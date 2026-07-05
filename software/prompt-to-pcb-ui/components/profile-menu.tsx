'use client'

/**
 * Account menu (sidebar drawer): credit balance, buy credit packs (volume
 * discount), upgrade to Pro, sign out. The whole app is behind login.
 */

import { useEffect, useRef, useState } from 'react'
import { CircleUserRound, Loader2, Zap } from 'lucide-react'

interface Me {
  email: string
  plan: 'free' | 'pro'
  credits: number
  monthlyCredits: number
}
interface Pack {
  id: string
  credits: number
  cents: number
}

export function ProfileMenu({ variant = 'header' }: { variant?: 'header' | 'sidebar' }) {
  const [me, setMe] = useState<Me | null>(null)
  const [packs, setPacks] = useState<Pack[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const refresh = () =>
      fetch('/api/auth/me')
        .then((r) => r.json())
        .then((d) => {
          setMe(d.user)
          if (d.packs) setPacks(d.packs)
        })
        .catch(() => {})

    const sid = new URLSearchParams(window.location.search).get('session_id')
    if (sid) {
      window.history.replaceState({}, '', '/')
      fetch('/api/billing/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      })
        .catch(() => {})
        .then(() => refresh())
    } else {
      refresh()
    }
  }, [])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  async function upgrade() {
    setBusy('pro')
    setMsg('')
    try {
      const r = await fetch('/api/billing/checkout', { method: 'POST' })
      const d = await r.json()
      if (d.url) window.location.href = d.url
      else setMsg(d.error ?? 'checkout unavailable')
    } catch (e) {
      setMsg(String(e))
    } finally {
      setBusy('')
    }
  }

  async function buyPack(packId: string) {
    setBusy(packId)
    setMsg('')
    try {
      const r = await fetch('/api/billing/credits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packId }),
      })
      const d = await r.json()
      if (d.url) window.location.href = d.url
      else setMsg(d.error ?? 'checkout unavailable')
    } catch (e) {
      setMsg(String(e))
    } finally {
      setBusy('')
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.href = '/login'
  }

  const initial = me?.email?.[0]?.toUpperCase()
  const perCredit = (p: Pack) => (p.cents / 100 / p.credits).toFixed(2)
  const bestRate = packs.length ? Math.min(...packs.map((p) => p.cents / p.credits)) : 0

  return (
    <div className="relative" ref={ref}>
      {variant === 'sidebar' ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-sm border border-border bg-card px-2 py-1.5 text-left hover:border-primary/40"
          aria-label="Account and billing"
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
              {me ? `${me.credits} credits · ${me.plan}` : '…'}
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
              ? 'absolute bottom-full left-0 z-50 mb-2 w-72 rounded-md border border-border bg-card p-3 shadow-xl'
              : 'absolute right-0 top-9 z-50 w-72 rounded-md border border-border bg-card p-3 shadow-xl'
          }
        >
          <p className="mb-0.5 truncate text-xs font-semibold text-foreground">{me.email}</p>
          <p className="mb-3 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {me.plan === 'pro' ? 'Pro plan' : 'Free plan'} · {me.monthlyCredits} credits / month
          </p>

          <div className="mb-3 flex items-center justify-between rounded-sm border border-border bg-background px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Zap className="size-3.5 text-primary" /> Credits
            </span>
            <span className="font-mono text-sm font-semibold text-foreground">{me.credits}</span>
          </div>

          {me.plan === 'free' && (
            <button
              type="button"
              onClick={upgrade}
              disabled={busy === 'pro'}
              className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'pro' && <Loader2 className="size-3.5 animate-spin" />}
              Upgrade to Pro, $49/mo · 100 credits
            </button>
          )}

          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Buy credits
          </p>
          <div className="space-y-1.5">
            {packs.map((p) => {
              const rate = p.cents / p.credits
              const best = rate === bestRate && packs.length > 1
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => buyPack(p.id)}
                  disabled={busy === p.id}
                  className="flex w-full items-center justify-between rounded-sm border border-border px-3 py-1.5 text-left hover:border-primary/40 disabled:opacity-50"
                >
                  <span className="text-xs text-foreground">
                    {busy === p.id ? (
                      <Loader2 className="inline size-3 animate-spin" />
                    ) : (
                      <>
                        {p.credits} credits
                        {best && (
                          <span className="ml-1.5 rounded-sm bg-primary/15 px-1 py-0.5 text-[9px] font-bold uppercase text-primary">
                            best value
                          </span>
                        )}
                      </>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ${(p.cents / 100).toFixed(0)}{' '}
                    <span className="text-[10px] text-muted-foreground/70">(${perCredit(p)}/cr)</span>
                  </span>
                </button>
              )
            })}
          </div>

          {msg && (
            <p className="mt-2 rounded-sm border border-border bg-background p-2 text-[10px] text-muted-foreground">
              {msg}
            </p>
          )}

          <button
            type="button"
            onClick={signOut}
            className="mt-3 w-full rounded-sm border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
