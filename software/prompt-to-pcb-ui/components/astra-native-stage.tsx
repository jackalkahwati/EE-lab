'use client'

import { useEffect, useRef, useState } from 'react'
import { Board3D } from '@/components/board-3d'
import { ASTRA_MANIFEST, astraArtifactUrl, buildAstraRunView, parseAstraManifest, type AstraManifest } from '@/lib/astra-run-view'

export type AstraNativeStageProps = {
  runId: string
  /** Refresh saved evidence when a build/cancellation settles. Never starts work. */
  refreshKey?: string | number
  className?: string
}

type Metadata = Record<string, unknown> | null
type Snapshot = { manifest: AstraManifest | null; policy: Metadata; timing: Metadata; warnings: string[] }
type Tab = 'pcba' | 'top' | 'bottom' | 'layout' | 'layers' | 'checks' | 'files'
const tabs: [Tab, string][] = [['pcba', '3D PCBA'], ['top', 'Top render'], ['bottom', 'Bottom render'], ['layout', 'Layout'], ['layers', 'Layers'], ['checks', 'Native checks'], ['files', 'Files']]
const buttonClass = 'rounded border border-border px-2.5 py-1 text-xs hover:bg-secondary disabled:opacity-50'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Injected transport keeps tests offline. Every read uses a fixed, run-scoped URL. */
export async function readAstraNativeSnapshot(runId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<Snapshot> {
  const names = [ASTRA_MANIFEST, 'astra-policy.json', 'timing.json'] as const
  // Construct every URL before submitting any read; malformed identities make no requests.
  const urls = names.map(name => astraArtifactUrl(runId, name))
  const results = await Promise.allSettled(urls.map(async (url, index) => {
    const response = await transport(url, { cache: 'no-store', redirect: 'error', signal })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Could not read ${names[index]} (HTTP ${response.status}).`)
    const value: unknown = await response.json()
    if (index === 0) return parseAstraManifest(value, runId)
    if (!object(value)) throw new Error(`Invalid ${names[index]}.`)
    return value
  }))
  if (signal.aborted) throw new Error('Saved artifact read cancelled.')
  const warnings: string[] = []
  const values = results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value
    warnings.push(result.reason instanceof Error ? result.reason.message : `Could not read ${names[index]}.`)
    return null
  })
  if (results[0].status === 'rejected') throw new Error(warnings[0])
  return { manifest: values[0] as AstraManifest | null, policy: values[1] as Metadata, timing: values[2] as Metadata, warnings }
}

export function nativeCountLabel(value: unknown, available = true): string {
  if (!available || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'Unknown'
  return value === 0 ? 'Passed (0)' : `Failed (${value})`
}

/** The only artifact link constructor: require an exact validated manifest entry. */
export function nativeManifestUrl(manifest: AstraManifest, relative: string): string | null {
  const entry = manifest.artifacts.find(item => item.path === relative)
  return entry ? `${astraArtifactUrl(manifest.runId, entry.path)}?v=${entry.sha256}` : null
}

function NativeImage({ url, label }: { url: string | null; label: string }) {
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  if (!url) return <p className="p-6 text-sm text-muted-foreground">{label} was not published for this run.</p>
  if (failed) return <div role="alert" className="p-6 text-sm"><p>{label} could not be read. No replacement was generated.</p><button type="button" className={`${buttonClass} mt-3`} onClick={() => { setFailed(false); setRetry(value => value + 1) }}>Retry image read</button></div>
  return <figure className="flex min-h-64 flex-col items-center justify-center p-4">
    {/* Saved artifacts only; image context does not execute SVG scripts. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img key={retry} src={url} alt={label} onError={() => setFailed(true)} className="max-h-[65vh] max-w-full object-contain" />
    <figcaption className="mt-3 text-xs text-muted-foreground">{label} · saved native output</figcaption>
  </figure>
}

export function AstraNativeStage(props: AstraNativeStageProps) {
  // Identity boundary also clears image errors, selected tabs and old evidence synchronously.
  return <NativeStageRun key={props.runId} {...props} />
}

function NativeStageRun({ runId, refreshKey, className = '' }: AstraNativeStageProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [tab, setTab] = useState<Tab>('pcba')
  const version = useRef(0)

  useEffect(() => {
    const token = ++version.current
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    readAstraNativeSnapshot(runId, controller.signal).then(value => {
      if (controller.signal.aborted || version.current !== token) return
      setSnapshot(value)
      setLoading(false)
    }).catch(reason => {
      if (controller.signal.aborted || version.current !== token) return
      setError(reason instanceof Error ? reason.message : 'Saved native artifacts could not be read.')
      setLoading(false)
    })
    return () => { ++version.current; controller.abort() }
  }, [runId, refreshKey, retry])

  const manifest = snapshot?.manifest ?? null
  const url = (relative: string) => manifest ? nativeManifestUrl(manifest, relative) : null
  const glb = url('board/chipscale.glb')
  const readAgain = () => setRetry(value => value + 1)
  const image = (path: string, label: string) => <NativeImage key={`${path}:${url(path)}:${retry}`} url={url(path)} label={label} />
  // Timing may restrict a terminal outcome, but can never manufacture native success.
  let outcome = 'UNKNOWN'
  try { outcome = buildAstraRunView({ runId, manifest, policy: snapshot?.policy, timing: snapshot?.timing }).status } catch { /* invalid identity is a read error */ }
  const state = outcome === 'PASSED' ? 'Passed' : outcome === 'GATE FAILED' ? 'Failed' : outcome === 'CANCELLED' ? 'Cancelled' : outcome === 'RUNNING' ? 'Running (saved timing)' : 'Unknown'
  const checks = manifest?.checks

  return <section aria-label="Saved native electronics" aria-busy={loading} className={`flex h-full min-h-0 flex-col overflow-auto ${className}`}>
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
      <h2 className="text-sm font-medium">Native electronics</h2>
      <span className="text-xs text-muted-foreground">{state} · electronics only</span>
      <button type="button" disabled={loading} onClick={readAgain} className={`${buttonClass} ml-auto`}>{loading ? 'Reading saved files…' : error ? 'Retry saved reads' : 'Refresh saved reads'}</button>
    </header>
    <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">Read-only saved evidence. Mechanical, thermal, firmware and system validation were not run by this electronics-only workflow.</p>
    {loading && <p role="status" className="px-4 py-3 text-sm">Loading saved native artifacts. No generation is started.</p>}
    {error && <div role="alert" className="border-b border-border px-4 py-3 text-sm"><p>{error}</p>{snapshot && <p className="mt-1 text-xs text-muted-foreground">The previous saved snapshot is retained below. Its current freshness is unknown.</p>}</div>}
    {snapshot?.warnings.map((warning, index) => <p role="status" key={index} className="px-4 py-1 text-xs text-muted-foreground">{warning}</p>)}
    {!loading && !manifest && !error && <p role="status" className="px-4 py-4 text-sm">No verified native manifest is available. Checks are unknown. Refresh saved reads after the workflow settles.</p>}
    {snapshot && outcome !== 'PASSED' && <p className="border-b border-border px-4 py-3 text-sm">{outcome === 'CANCELLED' ? 'This run was cancelled.' : 'This run has not passed native checks.'} Any published partial artifacts remain available for inspection, not approval.</p>}
    <nav aria-label="Native artifact views" className="flex flex-wrap gap-1 border-b border-border p-2">
      {tabs.map(([id, label]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)} className={`${buttonClass} ${tab === id ? 'bg-secondary font-medium' : 'text-muted-foreground'}`}>{label}</button>)}
    </nav>
    <div className="min-h-64 flex-1">
      {tab === 'pcba' && (glb ? <div className="h-[min(65vh,600px)] min-h-80"><Board3D key={`${glb}:${retry}`} basePath={`/runs/${runId}`} glbUrl={glb} fallback={image('board/render-top.png', 'Top board render')} /></div> : <><p className="px-4 pt-4 text-xs text-muted-foreground">No saved 3D model was published. Showing the saved top render when available.</p>{image('board/render-top.png', 'Top board render')}</>)}
      {tab === 'top' && image('board/render-top.png', 'Top board render')}
      {tab === 'bottom' && image('board/render-bottom.png', 'Bottom board render')}
      {tab === 'layout' && image('electronics/chipscale.svg', 'Native routed layout')}
      {tab === 'layers' && <div>{image('electronics/layer-top.svg', 'Top copper layer')}{image('electronics/layer-bottom.svg', 'Bottom copper layer')}</div>}
      {tab === 'checks' && <div className="space-y-4 p-4">
        <table className="w-full text-left text-sm"><caption className="mb-2 text-left text-xs text-muted-foreground">Native check evidence from the validated manifest only</caption><tbody>
          {[
            ['DRC errors', nativeCountLabel(checks?.drcErrors, checks?.drcAvailable === true)],
            ['Unrouted connections', nativeCountLabel(checks?.unrouted)],
            ['Component and net identity', checks ? checks.identityPreserved ? 'Passed' : 'Failed' : 'Unknown'],
            ['Native exports', checks ? checks.exportsComplete ? 'Passed' : 'Incomplete' : 'Unknown'],
            ['Route attempts', manifest ? String(manifest.routeAttempts) : 'Unknown'],
            ['Mechanical / thermal / firmware / system', 'Not run'],
          ].map(([label, value]) => <tr key={label} className="border-b border-border"><th scope="row" className="py-2 pr-4 font-normal">{label}</th><td className="py-2">{value}</td></tr>)}
        </tbody></table>
        {manifest && <><p className="break-all text-xs text-muted-foreground">Saved {manifest.createdAt} · proposal SHA-256 {manifest.proposalSha256}</p><dl className="text-xs">{Object.entries(manifest.tools).map(([tool, value]) => <div key={tool} className="flex gap-2"><dt>{tool}</dt><dd className="break-all">{value}</dd></div>)}</dl></>}
        <p className="text-xs text-muted-foreground">Policy {snapshot?.policy ? 'read' : 'unavailable'} · timing {snapshot?.timing ? 'read' : 'unavailable'}. Policy and timing are metadata, not proof that native checks passed.</p>
      </div>}
      {tab === 'files' && <div className="p-4"><p className="mb-3 text-xs text-muted-foreground">Only exact files published in the validated manifest are offered. The artifact server verifies saved bytes and SHA-256 before serving each file.</p>{manifest?.artifacts.length ? <ul className="space-y-3">{manifest.artifacts.map(entry => <li key={entry.path} className="text-sm"><a href={nativeManifestUrl(manifest, entry.path)!} download={entry.path.split('/').at(-1)} className="break-all underline underline-offset-4">{entry.path}</a><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{entry.bytes} bytes · SHA-256 {entry.sha256}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">No verified files were published.</p>}</div>}
    </div>
  </section>
}
