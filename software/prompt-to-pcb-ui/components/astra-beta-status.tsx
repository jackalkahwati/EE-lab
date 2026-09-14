'use client'

import { useEffect, useState } from 'react'
import { astraGenerationBlocker, astraPreferenceBlocker, fetchAstraStatus, type AstraAvailability } from '@/lib/astra-client'

export function readAstraPreferenceBlocker(): string | null {
  try { return astraPreferenceBlocker(window.localStorage) }
  catch { return 'Saved model/provider settings could not be checked. Generation is blocked until browser storage is readable.' }
}

export function useAstraAvailability() {
  const [availability, setAvailability] = useState<AstraAvailability>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [preferenceBlocker, setPreferenceBlocker] = useState<string | null>(null)
  const refreshPreferences = () => setPreferenceBlocker(readAstraPreferenceBlocker())
  useEffect(() => {
    const controller = new AbortController()
    let current = true
    const timeout = setTimeout(() => controller.abort(), 15000)
    setAvailability({ state: 'loading' })
    fetchAstraStatus(fetch, controller.signal).then((status) => {
      if (current && !controller.signal.aborted) setAvailability({ state: 'loaded', status })
    }).catch(() => {
      if (current) setAvailability({ state: 'error', error: 'Generation mode could not be verified. Generation is blocked. Retry the status check; it does not run a model.' })
    }).finally(() => clearTimeout(timeout))
    return () => { current = false; clearTimeout(timeout); controller.abort() }
  }, [attempt])
  useEffect(() => {
    refreshPreferences()
    window.addEventListener('storage', refreshPreferences)
    window.addEventListener('focus', refreshPreferences)
    return () => {
      window.removeEventListener('storage', refreshPreferences)
      window.removeEventListener('focus', refreshPreferences)
    }
  }, [])
  return {
    availability, preferenceBlocker, refreshPreferences,
    beta: availability.state === 'loaded' && availability.status.enabled,
    generationBlocker: astraGenerationBlocker(availability, preferenceBlocker),
    retryStatus: () => setAttempt((value) => value + 1),
  }
}

export function AstraBetaStatus({ availability, preferenceBlocker, retryStatus, workflowId, cancelling, terminal, detail, onCancel }: {
  availability: AstraAvailability
  preferenceBlocker: string | null
  retryStatus: () => void
  workflowId: string | null
  cancelling: boolean
  terminal: boolean
  detail: string | null
  onCancel: () => void
}) {
  if (availability.state === 'loaded' && !availability.status.enabled && !workflowId) return null
  const status = availability.state === 'loaded' && availability.status.enabled ? availability.status : null
  return <section aria-label="Astra beta status" aria-live="polite" className="shrink-0 space-y-1.5 border-b border-border bg-secondary/30 p-2.5 text-[11px]">
    {(status || workflowId) && <>
      <p className="font-medium">Astra beta · Bedrock</p>
      <p>Electronics-only. Other disciplines are not run.</p>
      <p className="text-muted-foreground">Auto is required in the model picker. Saved provider preferences are not changed.</p>
    </>}
    {availability.state === 'loading' && <p>Checking generation mode…</p>}
    {availability.state === 'error' && <p role="alert">{availability.error}</p>}
    {status && (!status.ready || status.blockers.length > 0) && <>
      <p className="font-medium">Generation blocked</p>
      <ul className="list-disc space-y-1 pl-4">{(status.blockers.length ? status.blockers : ['Native execution is not ready.']).map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>
    </>}
    {status && preferenceBlocker && <p role="alert">{preferenceBlocker}</p>}
    {status?.ready && !status.blockers.length && !preferenceBlocker && <p>Ready for an explicit request. Nothing starts from this status check.</p>}
    {availability.state !== 'loading' && <button type="button" onClick={retryStatus} disabled={cancelling}
      className="rounded border border-border px-2 py-1 disabled:opacity-40">Check status again</button>}
    {workflowId && !terminal && <div className="space-y-1">
      <button type="button" onClick={onCancel} disabled={cancelling} className="rounded border border-destructive/40 px-2 py-1 disabled:opacity-40">
        {cancelling ? 'Requesting cancellation…' : 'Cancel Astra workflow'}
      </button>
      <p className="text-muted-foreground">Cancels only this workflow. Disconnecting updates does not cancel it. In-flight provider work may still incur charges.</p>
    </div>}
    {detail && <p>{detail}</p>}
  </section>
}
