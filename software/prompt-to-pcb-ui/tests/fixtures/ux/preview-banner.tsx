'use client'
import { useEffect, useRef, useState } from 'react'

export function PreviewBanner() {
  const [scenario, setScenario] = useState('empty')
  const banner = useRef<HTMLElement>(null)
  useEffect(() => {
    setScenario(new URLSearchParams(location.search).get('scenario') || 'empty')
    const measure = () => document.documentElement.style.setProperty('--preview-banner-height', `${banner.current?.getBoundingClientRect().height || 0}px`)
    measure()
    const observer = new ResizeObserver(measure)
    if (banner.current) observer.observe(banner.current)
    return () => observer.disconnect()
  }, [])
  return <aside ref={banner} aria-label="Preview controls" style={{ background: '#422e0d', color: '#ffe1a4', padding: '5px 12px', font: '12px system-ui', position: 'relative', zIndex: 100, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
    <span>UI preview · synthetic data · Offline, no providers or tools</span>
    <label>Scenario <select aria-label="Preview scenario" value={scenario} style={{ background: '#241c10', border: '1px solid #80623a', padding: '2px 6px', color: 'inherit' }} onChange={event => {
      const next = event.target.value
      const url = new URL('/compose', location.origin)
      url.searchParams.set('scenario', next)
      if (['completed', 'partial', 'building', 'missing', 'model-a', 'model-b'].includes(next)) url.searchParams.set('run', `ux-${next}`)
      if (['pipeline-success', 'pipeline-error'].includes(next)) url.searchParams.set('run', 'ux-model-a')
      location.assign(url)
    }}>
      <option value="empty">New design</option>
      <option value="interview">Interview</option>
      <option value="building">Building snapshot</option>
      <option value="partial">Partial failure</option>
      <option value="completed">Completed fixture</option>
      <option value="missing">Missing artifacts</option>
      <option value="network-error">Network error</option>
      <option value="build-success">Live synthetic build</option>
      <option value="build-error">Live synthetic build failure</option>
      <option value="build-malformed">Malformed build update</option>
      <option value="build-disconnect">Disconnected build updates</option>
      <option value="model-a">3D test model A</option>
      <option value="model-b">3D test model B</option>
      <option value="pipeline-success">Synthetic downstream flow</option>
      <option value="pipeline-error">Downstream rejection</option>
      <option value="import-success">Synthetic import</option>
      <option value="import-error">Import rejection</option>
      <option value="import-malformed">Invalid import response</option>
    </select></label>
    <span style={{ fontSize: 11 }}>Illustrations only. Not engineering or manufacturing evidence.</span>
  </aside>
}
