'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { clampWorkspacePanes, workspaceMode, type WorkspaceSurface } from '@/lib/workspace-state'

function storedWidth(key: string, fallback: number) {
  try { const value = Number(localStorage.getItem(key)); return value > 0 && Number.isFinite(value) ? value : fallback } catch { return fallback }
}
function saveWidth(key: string, value: number) {
  try { localStorage.setItem(key, String(value)) } catch { /* Storage is optional. */ }
}

/** Visibility does not own the lifetime of the conversation or its connection. */
export function WorkspacePanes({ conversation, preview, details, surface, onSurfaceChange, inspectorOpen, onInspectorChange }: {
  conversation: ReactNode; preview: ReactNode; details: ReactNode
  surface: WorkspaceSurface; onSurfaceChange: (surface: WorkspaceSurface) => void
  inspectorOpen: boolean; onInspectorChange: (open: boolean) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1440)
  const [left, setLeft] = useState(320)
  const [right, setRight] = useState(360)
  const [conversationOpen, setConversationOpen] = useState(true)
  const mode = workspaceMode(width)
  const showLeft = mode === 'mobile' ? surface === 'conversation' : mode === 'tablet' ? surface === 'conversation' : conversationOpen
  const showRight = mode === 'mobile' ? surface === 'details' : mode === 'tablet' ? surface === 'details' : inspectorOpen
  const showPreview = mode !== 'mobile' || surface === 'preview'
  const sizes = clampWorkspacePanes(width, left, right, showLeft, showRight)

  useEffect(() => {
    setLeft(storedWidth('c2-leftW', 320)); setRight(storedWidth('c2-rightW', 360))
    const el = root.current
    if (!el) return
    const measure = () => setWidth(el.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (surface === 'conversation') setConversationOpen(true)
  }, [surface])

  const resize = (side: 'left' | 'right', value: number) => {
    const bounded = clampWorkspacePanes(width, side === 'left' ? value : left, side === 'right' ? value : right, showLeft, showRight)
    if (side === 'left') { setLeft(bounded.left); saveWidth('c2-leftW', bounded.left) }
    else { setRight(bounded.right); saveWidth('c2-rightW', bounded.right) }
  }
  const separator = (side: 'left' | 'right') => (
    <div role="separator" tabIndex={0} aria-label={`Resize ${side === 'left' ? 'conversation' : 'details'} pane`}
      aria-orientation="vertical" aria-valuemin={0} aria-valuemax={Math.max(0, width - 425)} aria-valuenow={Math.round(side === 'left' ? sizes.left : sizes.right)}
      className="workspace-separator" title="Drag or use arrow keys to resize. Home resets."
      onKeyDown={(event) => {
        const current = side === 'left' ? sizes.left : sizes.right
        if (event.key === 'Home') { event.preventDefault(); resize(side, side === 'left' ? 320 : 360) }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          resize(side, current + (event.key === 'ArrowRight' ? 20 : -20) * (side === 'left' ? 1 : -1))
        }
      }}
      onDoubleClick={() => resize(side, side === 'left' ? 320 : 360)}
      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId) || !root.current) return
        const rect = root.current.getBoundingClientRect()
        resize(side, side === 'left' ? event.clientX - rect.left : rect.right - event.clientX)
      }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} />
  )

  return <div ref={root} className="workspace-panes" data-mode={mode}>
    <nav aria-label="Workspace surfaces" className="workspace-surface-nav">
      {(['conversation', 'preview', 'details'] as const).map((next) => {
        const selected = mode === 'desktop' ? next === 'preview' || (next === 'conversation' ? showLeft : showRight) : next === surface
        return <button key={next} type="button" aria-pressed={selected} onClick={() => {
          if (mode === 'desktop' && next === 'conversation') {
            setConversationOpen(!showLeft)
            onSurfaceChange(showLeft ? 'preview' : 'conversation')
          } else if (mode === 'desktop' && next === 'details') {
            onInspectorChange(!showRight)
            onSurfaceChange(showRight ? 'preview' : 'details')
          } else onSurfaceChange(next)
        }}>{next === 'conversation' ? 'Conversation' : next === 'preview' ? 'Preview' : 'Details'}</button>
      })}
      <span className="workspace-surface-hint">{mode === 'mobile' ? 'One surface at a time' : mode === 'tablet' ? 'Preview + one panel' : 'Focused workspace'}</span>
    </nav>
    <div className="workspace-pane-row">
      <aside aria-label="Design conversation" hidden={!showLeft} className="workspace-conversation" style={{ width: mode === 'mobile' ? '100%' : sizes.left }}>{conversation}</aside>
      {showLeft && mode !== 'mobile' && separator('left')}
      <section id="workspace-preview" tabIndex={-1} aria-label="Design preview" hidden={!showPreview} className="workspace-preview">{preview}</section>
      {showRight && mode !== 'mobile' && separator('right')}
      <aside aria-label="Design details" hidden={!showRight} className="workspace-details" style={{ width: mode === 'mobile' ? '100%' : sizes.right }}>{details}</aside>
    </div>
  </div>
}
