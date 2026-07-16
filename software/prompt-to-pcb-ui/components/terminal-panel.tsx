'use client'

/**
 * Terminal panel — Cursor/VS Code-style bottom panel for the Compose workspace.
 *   · slim tab strip: TERMINAL (everything) + PROBLEMS (warn/error only, with a
 *     live count badge), chevron collapse toggle, clear button
 *   · monospace log body fed by the terminal log bus (lib/terminal-log):
 *     dim timestamp · colored source chip · level-colored text
 *   · auto-scrolls to the newest line; scrolling up pauses the follow and a
 *     "resume" pill brings it back
 *   · draggable top edge to resize (pointer events); collapsed = just the bar
 *
 * Purely presentational over the log bus — it owns no data and fetches nothing.
 * Tab selection can be controlled (tab/onTabChange) so e.g. the status bar's
 * problems badge can focus the PROBLEMS tab, or left uncontrolled.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { clearLog, useTerminalLog, type TerminalLine } from '@/lib/terminal-log'
import { ChevronDown, ChevronUp, Trash2, ArrowDownToLine } from 'lucide-react'
import { ShellTab } from '@/components/shell-tab'

export type TerminalTab = 'terminal' | 'problems' | 'shell'

const BAR_PX = 28
const DEFAULT_OPEN_PX = 220
const MIN_OPEN_PX = 96
const MAX_OPEN_PX = 480

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// calm, token-matched colors: source chips stay neutral (amber = the only
// chromatic chrome accent, reserved for pipeline); only warn/error shout
const SOURCE_CHIP: Record<TerminalLine['source'], string> = {
  build: 'text-foreground/70 border-border',
  pipeline: 'text-primary/80 border-primary/25',
  system: 'text-muted-foreground border-border',
}

const LEVEL_TEXT: Record<TerminalLine['level'], string> = {
  info: 'text-foreground/80',
  ok: 'text-emerald-400/90',
  warn: 'text-amber-400/90',
  error: 'text-red-400/90',
}

function LogRow({ line }: { line: TerminalLine }) {
  return (
    <div className="flex items-start gap-2 px-2 leading-[1.7] hover:bg-secondary/40">
      <span className="shrink-0 tabular-nums text-muted-foreground/50">{fmtTime(line.ts)}</span>
      <span className={cn(
        'mt-[3px] inline-block w-14 shrink-0 border px-1 text-center text-[8px] uppercase leading-[1.5] tracking-wider',
        SOURCE_CHIP[line.source] ?? 'text-muted-foreground border-border')}>
        {line.source}
      </span>
      <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', LEVEL_TEXT[line.level] ?? 'text-foreground/80')}>
        {line.text}
      </span>
    </div>
  )
}

export function TerminalPanel({ collapsed, onToggle, heightPx, tab, onTabChange }: {
  collapsed: boolean
  onToggle: () => void
  /** initial open height in px (uncontrolled after that — the drag edge rules) */
  heightPx?: number
  /** controlled active tab (optional) — pass with onTabChange to drive it from
   *  outside, e.g. the status bar's problems badge focusing PROBLEMS */
  tab?: TerminalTab
  onTabChange?: (t: TerminalTab) => void
}) {
  const { lines, version } = useTerminalLog()
  const problems = lines.filter((l) => l.level === 'warn' || l.level === 'error')
  const hasErrors = problems.some((l) => l.level === 'error')

  // tab: controlled when the prop is given, else local
  const [localTab, setLocalTab] = useState<TerminalTab>('terminal')
  const activeTab = tab ?? localTab
  const setTab = (t: TerminalTab) => { onTabChange?.(t); if (tab === undefined) setLocalTab(t) }
  const shown = activeTab === 'problems' ? problems : lines

  // open height — draggable via the top edge
  const [height, setHeight] = useState(heightPx ?? DEFAULT_OPEN_PX)
  const dragFrom = useRef<{ y: number; h: number } | null>(null)
  const onEdgeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return
    dragFrom.current = { y: e.clientY, h: height }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onEdgeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current
    if (!from) return
    setHeight(Math.min(MAX_OPEN_PX, Math.max(MIN_OPEN_PX, from.h + (from.y - e.clientY))))
  }
  const onEdgeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // auto-scroll: follow the tail unless the user scrolled up
  const bodyRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const scrollToEnd = useCallback((smooth = false) => {
    const el = bodyRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])
  useEffect(() => {
    if (!collapsed && pinned) scrollToEnd()
  }, [version, activeTab, collapsed, pinned, scrollToEnd])
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 12)
  }

  const tabBtn = (t: TerminalTab, label: string, badge?: number) => {
    const on = activeTab === t && !collapsed
    return (
      <button
        key={t}
        type="button"
        onClick={() => { setTab(t); if (collapsed) onToggle() }}
        className={cn(
          'relative flex h-full items-center gap-1.5 px-3 font-mono text-[10px] uppercase tracking-wider',
          on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
        {label}
        {badge != null && badge > 0 && (
          <span className={cn('min-w-[16px] border px-1 text-center text-[9px] leading-[14px] tabular-nums',
            hasErrors ? 'border-red-400/40 text-red-400' : 'border-amber-400/40 text-amber-400')}>
            {badge}
          </span>
        )}
        {/* active indicator — 1px underline, no pills, no rounding */}
        {on && <span aria-hidden className="absolute inset-x-2 bottom-0 h-px bg-primary" />}
      </button>
    )
  }

  return (
    <div
      className="flex w-full shrink-0 flex-col border-t border-border bg-card/50"
      style={{ height: collapsed ? BAR_PX : height }}>
      {/* drag edge (top) */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          title="drag to resize"
          onPointerDown={onEdgeDown}
          onPointerMove={onEdgeMove}
          onPointerUp={onEdgeUp}
          className="-mt-px h-[3px] w-full shrink-0 cursor-row-resize touch-none bg-transparent transition-colors hover:bg-primary/50"
        />
      )}

      {/* header bar — 28px, tabs left, actions right */}
      <div className="flex h-7 shrink-0 items-center border-b border-border">
        {tabBtn('terminal', 'Terminal')}
        {tabBtn('shell', 'Shell')}
        {tabBtn('problems', 'Problems', problems.length)}
        <div className="ml-auto flex h-full items-center">
          <button type="button" title="clear log" onClick={clearLog}
            className="flex h-full items-center px-2 text-muted-foreground hover:text-foreground">
            <Trash2 className="size-3" />
          </button>
          <button type="button" title={collapsed ? 'open panel' : 'collapse panel'} onClick={onToggle}
            className="flex h-full items-center px-2 text-muted-foreground hover:text-foreground">
            {collapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* body: interactive shell OR log stream */}
      {!collapsed && activeTab === 'shell' && (
        <div className="min-h-0 flex-1">
          <ShellTab active={!collapsed} />
        </div>
      )}
      {!collapsed && activeTab !== 'shell' && (
        <div className="relative min-h-0 flex-1">
          <div ref={bodyRef} onScroll={onScroll}
            className="h-full overflow-y-auto overflow-x-hidden bg-background py-1 font-mono text-[11px]">
            {shown.length === 0 ? (
              <div className="px-3 py-2 text-muted-foreground/60">
                {activeTab === 'problems' ? 'No problems detected.' : 'No output yet — build or pipeline logs land here.'}
              </div>
            ) : (
              shown.map((l) => <LogRow key={l.id} line={l} />)
            )}
          </div>
          {/* follow-resume pill, shown while auto-scroll is paused */}
          {!pinned && (
            <button type="button"
              onClick={() => { setPinned(true); scrollToEnd(true) }}
              className="absolute bottom-2 right-3 flex items-center gap-1 border border-border bg-card px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
              <ArrowDownToLine className="size-3" /> resume
            </button>
          )}
        </div>
      )}
    </div>
  )
}
