'use client'

/**
 * Shell — an interactive command runner in the bottom panel. Streams each
 * command's output from POST /api/terminal (spawns `bash -lc`, gated behind
 * FL_TERMINAL on the server). Dependency-free (no xterm): a scrolling
 * transcript + a prompt input with command history. `cd` persists because the
 * server echoes the resulting pwd on a sentinel line we parse back out.
 *
 * NOT a full TTY: no line editing inside a running program, no curses apps
 * (vim/top/htop). Fine for git, ls, grep, build/test commands, one-shot tools.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

// keep in sync with CWD_SENTINEL in app/api/terminal/route.ts
const CWD_SENTINEL = ' __FL_CWD__:'

interface Block {
  id: number
  cwd: string
  command: string
  output: string
  running: boolean
}

export function ShellTab({ active }: { active: boolean }) {
  const [cwd, setCwd] = useState<string>('~')
  const [blocks, setBlocks] = useState<Block[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(1)

  const scrollToEnd = useCallback(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  useEffect(() => { scrollToEnd() }, [blocks, scrollToEnd])
  useEffect(() => { if (active) inputRef.current?.focus() }, [active])

  const run = useCallback(async (command: string) => {
    const id = nextId.current++
    const startCwd = cwd
    setBlocks((b) => [...b, { id, cwd: startCwd, command, output: '', running: true }])
    setHistory((h) => (h[h.length - 1] === command ? h : [...h, command]))
    const append = (chunk: string) =>
      setBlocks((b) => b.map((x) => (x.id === id ? { ...x, output: x.output + chunk } : x)))
    const finish = (extra?: string) =>
      setBlocks((b) => b.map((x) => (x.id === id ? { ...x, output: x.output + (extra ?? ''), running: false } : x)))

    const ac = new AbortController()
    abortRef.current = ac
    try {
      const r = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, cwd: startCwd === '~' ? undefined : startCwd }),
        signal: ac.signal,
      })
      if (r.status === 403) {
        const d = await r.json().catch(() => ({}))
        setEnabled(false)
        finish(`\n[disabled] ${d?.error ?? 'terminal is off (FL_TERMINAL=1 to enable)'}`)
        return
      }
      if (!r.ok || !r.body) { finish(`\n[error] HTTP ${r.status}`); return }
      setEnabled(true)
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let tail = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        tail += dec.decode(value, { stream: true })
        // pull the sentinel (resulting pwd) out of the stream, keep the rest
        const si = tail.indexOf(CWD_SENTINEL)
        if (si >= 0) {
          const after = tail.slice(si + CWD_SENTINEL.length)
          const nl = after.indexOf('\n')
          if (nl >= 0) {
            const newCwd = after.slice(0, nl).trim()
            if (newCwd) setCwd(newCwd)
            tail = tail.slice(0, si) + after.slice(nl + 1)
          }
        }
        // flush everything except a possible partial trailing sentinel
        const keep = Math.max(0, tail.length - CWD_SENTINEL.length)
        if (keep > 0) { append(tail.slice(0, keep)); tail = tail.slice(keep) }
      }
      if (tail) append(tail)
      finish()
    } catch (e) {
      finish(ac.signal.aborted ? '\n^C' : `\n[error] ${String(e)}`)
    } finally {
      abortRef.current = null
    }
  }, [cwd])

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const c = input.trim()
      setInput('')
      setHistIdx(null)
      if (c === 'clear') { setBlocks([]); return }
      if (c) run(c)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!history.length) return
      const i = histIdx == null ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(i); setInput(history[i])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx == null) return
      const i = histIdx + 1
      if (i >= history.length) { setHistIdx(null); setInput('') }
      else { setHistIdx(i); setInput(history[i]) }
    } else if (e.key === 'c' && e.ctrlKey) {
      abortRef.current?.abort()
    }
  }

  const shortCwd = cwd === '~' ? '~' : cwd.replace(/^.*\/(?=[^/]+\/[^/]+$)/, '…/')
  const anyRunning = blocks.some((b) => b.running)

  return (
    <div
      className="flex h-full flex-col bg-background font-mono text-[11px]"
      onClick={() => inputRef.current?.focus()}
    >
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {blocks.length === 0 && (
          <div className="py-1 text-muted-foreground/60">
            {enabled === false
              ? 'Shell is disabled on the server — set FL_TERMINAL=1 and restart to enable.'
              : 'Interactive shell (bash -lc). Try: git status · ls · npm run build. Type `clear` to reset.'}
          </div>
        )}
        {blocks.map((b) => (
          <div key={b.id} className="leading-[1.6]">
            <div className="flex gap-1.5">
              <span className="shrink-0 text-emerald-400/80">{b.cwd === '~' ? '~' : b.cwd.split('/').pop()} $</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">{b.command}</span>
            </div>
            {b.output && <div className="whitespace-pre-wrap break-words text-foreground/75">{b.output}</div>}
            {b.running && <span className="text-muted-foreground/50">▊ running… (Ctrl-C to stop)</span>}
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-card/40 px-2 py-1">
        <span className="shrink-0 text-emerald-400/80" title={cwd}>{shortCwd} $</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={anyRunning ? 'running… (Ctrl-C to stop)' : 'type a command'}
          className="min-w-0 flex-1 bg-transparent text-foreground/90 placeholder:text-muted-foreground/40 focus:outline-none"
        />
      </div>
    </div>
  )
}
