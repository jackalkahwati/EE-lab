'use client'

import { useEffect, useRef, useState } from 'react'
import {
  promptFromFragment, readStartDraft, saveStartDraft, sessionDraftStorage,
  type StartDraft,
} from '@/lib/start-draft'

type CaptureWindow = Window & {
  __firstlightStartFragment?: string
  __firstlightStartScrubFailed?: boolean
}

export default function StartPage() {
  const initialized = useRef(false)
  const [recovery, setRecovery] = useState('')
  const [message, setMessage] = useState('Preparing your draft…')

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    const capture = window as CaptureWindow
    const fragment = capture.__firstlightStartFragment ?? window.location.hash
    delete capture.__firstlightStartFragment
    delete capture.__firstlightStartScrubFailed
    const prompt = promptFromFragment(fragment)
    // Repeat the early head scrub for client navigations and unusual browsers.
    try { window.history.replaceState(window.history.state, '', '/start') } catch {
      setRecovery(prompt ?? '')
      setMessage('Your browser could not clear this private link. Copy your description before continuing.')
      return
    }
    const storage = sessionDraftStorage()
    if (prompt) {
      const draft: StartDraft = { version: 1, id: crypto.randomUUID(), prompt, createdAt: Date.now() }
      if (saveStartDraft(storage, draft)) {
        window.location.replace('/compose')
        return
      }
      setRecovery(prompt)
      setMessage('Your browser could not save this draft. Copy your description, then paste it into Compose after signing in.')
      return
    }
    if (!fragment && readStartDraft(storage)) {
      window.location.replace('/compose')
      return
    }
    setMessage(fragment
      ? 'This draft link is empty or too long. Return to the website and try a shorter description, or continue to Compose.'
      : 'Continue to Compose to describe your board.')
  }, [])

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-6 py-12">
      <h1 className="text-2xl font-semibold">Start your design</h1>
      <p role="status">{message}</p>
      {recovery && <>
        <label htmlFor="draft-recovery">Your description</label>
        <textarea id="draft-recovery" readOnly value={recovery} rows={7}
          className="w-full rounded border border-border p-3"
          onFocus={(event) => event.currentTarget.select()} />
        <p className="text-sm text-muted-foreground">This text has not been sent to Firstlight. Select it to copy before leaving this page.</p>
      </>}
      <a href="/compose" className="underline">Continue to Compose</a>
      <noscript>
        <p>JavaScript is required to transfer your description privately. It has not been submitted. Go back to copy it, then enable JavaScript and sign in to Compose.</p>
      </noscript>
    </main>
  )
}
