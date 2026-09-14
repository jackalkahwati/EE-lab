'use client'

import { useCallback, useEffect, useState } from 'react'
import { AccessGate } from '@/components/access-gate'
import { EnterpriseReadFailure, readEnterprise, type EnterpriseReadError } from '@/lib/enterprise-read'

export function useEnterpriseRead() {
  const [db, setDb] = useState<Record<string, any> | null>(null)
  const [error, setError] = useState<EnterpriseReadError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const refresh = useCallback(() => setAttempt(value => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    let current = true
    let timedOut = false
    setDb(null)
    setError(null)
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
    readEnterprise(controller.signal).then(data => {
      if (current) setDb(data)
    }).catch(reason => {
      if (!current) return
      setError(reason instanceof EnterpriseReadFailure
        ? { kind: reason.kind, message: reason.message }
        : { kind: 'network', message: timedOut
          ? 'The workspace took too long to respond. Try again.'
          : 'Could not connect to the workspace. Check your connection and try again.' })
    }).finally(() => clearTimeout(timeout))
    return () => { current = false; clearTimeout(timeout); controller.abort() }
  }, [attempt])

  return { db, error, refresh }
}

export function EnterpriseReadState({ error, retry, label }: {
  error: EnterpriseReadError | null
  retry: () => void
  label: string
}) {
  if (error && error.kind !== 'network') return <AccessGate error={error.message} />
  if (!error) return <div role="status" className="p-6 text-sm text-muted-foreground">Loading {label}…</div>
  return (
    <section className="mx-auto flex max-w-lg flex-col items-start gap-3 p-6">
      <h1 className="text-lg font-medium">Could not load {label}</h1>
      <p role="alert" className="text-sm text-muted-foreground">{error.message}</p>
      <button type="button" onClick={retry}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        Try again
      </button>
    </section>
  )
}
