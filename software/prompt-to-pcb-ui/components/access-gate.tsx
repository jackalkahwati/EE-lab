'use client'

import { useEffect, useState } from 'react'

/**
 * Renders the right thing when an enterprise data fetch comes back with an
 * error, distinguishing the two very different cases:
 *
 *  - AUTH (401 "sign in required"): the session expired while the user sat on
 *    a live page. The middleware only redirects on navigation, so without this
 *    the user is stranded. We bounce to /login?next=<current> and land them
 *    back where they were after signing in.
 *
 *  - MEMBERSHIP (403 "enterprise membership required"): the user IS signed in
 *    but belongs to no workspace yet (e.g. a brand-new signup — `/` redirects
 *    here). Redirecting to /login would loop forever. Instead we show a clear
 *    "no workspace" state and point them at the design workspace.
 */
function isAuthError(error?: string): boolean {
  if (!error) return true
  return /sign in|unauthenticated|session|not configured/i.test(error)
}

export function AccessGate({ error }: { error?: string }) {
  const [href, setHref] = useState('/login')
  const auth = isAuthError(error)

  useEffect(() => {
    if (!auth) return
    const next = window.location.pathname + window.location.search
    const dest = `/login?next=${encodeURIComponent(next)}`
    setHref(dest)
    const t = setTimeout(() => { window.location.href = dest }, 900)
    return () => clearTimeout(t)
  }, [auth])

  if (auth) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Your session expired</p>
          <p className="text-xs text-muted-foreground">Taking you to sign in…</p>
        </div>
        <a
          href={href}
          className="rounded-sm bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Sign in to continue
        </a>
      </div>
    )
  }

  // Signed in, but no workspace membership.
  async function signOutAndSwitch() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    window.location.href = '/login'
  }

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="max-w-md space-y-2">
        <p className="text-sm font-medium text-foreground">No workspace yet</p>
        <p className="text-xs text-muted-foreground">
          You&apos;re signed in, but you don&apos;t belong to an enterprise workspace.
          If your team uses Compose, ask an admin to invite you — otherwise start in
          the design workspace.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <a
          href="/compose"
          className="rounded-sm bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Go to the design workspace
        </a>
        <button
          type="button"
          onClick={signOutAndSwitch}
          className="rounded-sm border border-border px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Sign in as a different user
        </button>
      </div>
    </div>
  )
}
