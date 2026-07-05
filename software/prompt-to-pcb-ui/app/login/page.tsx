'use client'

import { useEffect, useState } from 'react'

const OAUTH_ERRORS: Record<string, string> = {
  'google-not-configured':
    'Google sign-in is not configured on this deployment yet, use email and password.',
  'google-state-mismatch': 'Google sign-in session expired, try again.',
  'google-exchange-failed': 'Google did not accept the sign-in, try again.',
  'google-bad-token': 'Google returned an unreadable identity, try again.',
  'google-identity-rejected': 'This Google account could not be verified.',
}

export default function LoginPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('error')
    if (code) setError(OAUTH_ERRORS[code] ?? code)
  }, [])

  function nextDest(): string {
    const next = new URLSearchParams(window.location.search).get('next')
    // only same-origin paths, never an absolute URL from the query string
    return next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const res = await fetch(mode === 'signin' ? '/api/auth/login' : '/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (res.ok) {
      window.location.href = nextDest()
    } else {
      const d = await res.json().catch(() => ({}))
      setError(d.error ?? 'something went wrong')
      setBusy(false)
    }
  }

  const input: React.CSSProperties = {
    width: '100%',
    padding: '11px 14px',
    borderRadius: 8,
    border: '1px solid #2a2e37',
    background: '#101216',
    color: '#eceae4',
    fontSize: 14,
    marginBottom: 12,
    outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#101216',
        color: '#eceae4',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 360,
          padding: '36px 32px',
          background: '#16181d',
          border: '1px solid #2a2e37',
          borderRadius: 14,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '0.04em',
            marginBottom: 6,
          }}
        >
          <span style={{ color: '#ff6e00' }}>✳</span> firstlight compose
        </div>
        <p style={{ color: '#a7a49c', fontSize: 13, marginBottom: 24 }}>
          {mode === 'signin'
            ? 'Sign in to your workspace.'
            : 'Create your account, 5 free board runs a month.'}
        </p>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoFocus
          style={input}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === 'signup' ? 'Password (8+ characters)' : 'Password'}
          style={input}
        />
        <button
          type="submit"
          disabled={busy || !email || !password}
          style={{
            width: '100%',
            padding: '11px 14px',
            borderRadius: 8,
            border: 'none',
            background: '#ff6e00',
            color: '#14100b',
            fontWeight: 600,
            fontSize: 14,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy || !email || !password ? 0.7 : 1,
          }}
        >
          {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            margin: '16px 0 12px',
            color: '#5b5e66',
            fontSize: 11,
          }}
        >
          <span style={{ flex: 1, height: 1, background: '#2a2e37' }} />
          or
          <span style={{ flex: 1, height: 1, background: '#2a2e37' }} />
        </div>
        <button
          type="button"
          onClick={() => {
            window.location.href = `/api/auth/google?next=${encodeURIComponent(nextDest())}`
          }}
          style={{
            width: '100%',
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid #2a2e37',
            background: '#101216',
            color: '#eceae4',
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Continue with Google
        </button>
        {error && (
          <p style={{ color: '#e05252', fontSize: 13, marginTop: 12 }}>{error}</p>
        )}
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin')
            setError('')
          }}
          style={{
            marginTop: 18,
            background: 'none',
            border: 'none',
            color: '#a7a49c',
            fontSize: 13,
            cursor: 'pointer',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          {mode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </button>
      </form>
    </main>
  )
}
