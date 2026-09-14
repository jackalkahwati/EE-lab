'use client'

/**
 * Files — a real IDE-style file explorer over the run directory (replaces the
 * old hand-maintained artifact catalog, which silently hid anything it didn't
 * know about: scorecards, fidelity verdicts, ID renders, firmware zips…).
 * Left: the ACTUAL recursive tree from /api/runs/files. Right: type-aware
 * preview — markdown (tiny built-in renderer, no deps), JSON, images, CSV
 * tables; binaries get an honest size + download. Content is fetched from the
 * existing /runs/<id>/<path> live-file route.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronLeft, ChevronRight, Download, File, FileCode, FileJson, FileText,
  FileSpreadsheet, Folder, FolderOpen, Image as ImageIcon, RefreshCw,
} from 'lucide-react'

interface FileNode {
  name: string
  path: string
  dir: boolean
  size?: number
  mtime?: string
  children?: FileNode[]
}

const TEXT_EXT = new Set(['md', 'txt', 'log', 'csv', 'json', 'svg', 'ses', 'dsn', 'sh', 'py', 'ts', 'tsx', 'mjs', 'rs', 'toml', 'yaml', 'yml', 'dru'])
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const MAX_PREVIEW = 1_500_000 // bytes — bigger files get download-only, honestly

const ext = (p: string) => (p.split('.').pop() ?? '').toLowerCase()

function fmtSize(n?: number): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function iconFor(n: FileNode, open: boolean) {
  if (n.dir) return open ? FolderOpen : Folder
  const e = ext(n.name)
  if (e === 'json') return FileJson
  if (e === 'md' || e === 'txt' || e === 'log') return FileText
  if (e === 'csv') return FileSpreadsheet
  if (IMG_EXT.has(e) || e === 'svg') return ImageIcon
  if (e === 'kicad_pcb' || e === 'dsn' || e === 'ses' || e === 'step' || e === 'glb') return FileCode
  return File
}

// ---- tiny markdown renderer (escape first — output is trusted-safe) --------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// Tokenize before emitting HTML: formatting must never insert markup into href.
function inlineMarkdown(raw: string): string {
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:[^)\s]+)\)|\*\*([^*]+)\*\*/g
  let html = ''
  let end = 0
  for (const match of raw.matchAll(pattern)) {
    html += esc(raw.slice(end, match.index))
    const [, code, label, url, strong] = match
    if (code !== undefined) html += `<code class="ae-inline">${esc(code)}</code>`
    else if (url !== undefined) html += `<a href="${esc(url)}" target="_blank" rel="noreferrer" class="underline">${inlineMarkdown(label)}</a>`
    else html += `<strong>${inlineMarkdown(strong)}</strong>`
    end = match.index + match[0].length
  }
  return html + esc(raw.slice(end))
}

function mdToHtml(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let inCode = false
  let inList = false
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }
  for (const raw of lines) {
    if (raw.startsWith('```')) {
      closeList()
      out.push(inCode ? '</code></pre>' : '<pre class="ae-code"><code>')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(esc(raw) + '\n'); continue }
    const line = inlineMarkdown(raw)
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) { closeList(); out.push(`<h${h[1].length + 2} class="ae-h">${h[2]}</h${h[1].length + 2}>`); continue }
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) { if (!inList) { out.push('<ul class="ae-ul">'); inList = true } out.push(`<li>${li[1]}</li>`); continue }
    closeList()
    if (/^\s*\|.*\|\s*$/.test(raw)) { out.push(`<div class="ae-row">${line}</div>`); continue } // tables stay monospace, honest
    if (line.trim() === '') { out.push('<div class="ae-gap"></div>'); continue }
    out.push(`<p class="ae-p">${line}</p>`)
  }
  if (inCode) out.push('</code></pre>')
  closeList()
  return out.join('')
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(
    () => text.trim().split('\n').slice(0, 200).map((r) => r.split(',')),
    [text],
  )
  if (!rows.length) return null
  return (
    <div className="overflow-auto">
      <table className="border-collapse font-mono text-xs">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
              {r.map((c, j) => (
                <td key={j} className="whitespace-nowrap border border-border/40 px-2 py-0.5">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Tree({ nodes, sel, onSel, openDirs, toggle, depth = 0 }: {
  nodes: FileNode[]
  sel: string | null
  onSel: (n: FileNode) => void
  openDirs: Set<string>
  toggle: (p: string) => void
  depth?: number
}) {
  return (
    <div>
      {nodes.map((n) => {
        const open = openDirs.has(n.path)
        const Icon = iconFor(n, open)
        return (
          <div key={n.path}>
            <button
              type="button"
              aria-label={`${n.dir ? (open ? 'Collapse' : 'Expand') : 'Preview'} ${n.path}`}
              aria-expanded={n.dir ? open : undefined}
              aria-current={!n.dir && sel === n.path ? 'true' : undefined}
              onClick={() => (n.dir ? toggle(n.path) : onSel(n))}
              className={`flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-xs hover:bg-accent/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${sel === n.path ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
              style={{ paddingLeft: `${6 + depth * 14}px` }}
            >
              {n.dir ? (
                open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{n.name}</span>
              {!n.dir && <span className="ml-auto shrink-0 pl-2 text-[10px] opacity-50">{fmtSize(n.size)}</span>}
            </button>
            {n.dir && open && n.children && (
              <Tree nodes={n.children} sel={sel} onSel={onSel} openDirs={openDirs} toggle={toggle} depth={depth + 1} />
            )}
          </div>
        )
      })}
    </div>
  )
}


const REQUEST_TIMEOUT = 15_000
const controlClass = 'rounded border border-border/60 px-2 py-1 text-xs hover:bg-accent/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring'

class PreviewTooLarge extends Error {}

/** Bound bytes actually read, even when the listing/Content-Length is stale. */
async function readPreviewText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_PREVIEW) {
    void response.body?.cancel().catch(() => {})
    throw new PreviewTooLarge()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_PREVIEW) {
        void reader.cancel().catch(() => {})
        throw new PreviewTooLarge()
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

type PreviewProps = {
  revision?: number
  runId: string
  file: { name: string; path: string; size?: number }
  onClose?: () => void
}
type PreviewState =
  | { kind: 'loading' | 'image' | 'binary' | 'oversize' }
  | { kind: 'text'; body: string }
  | { kind: 'error'; message: string }

/** Identity keys clear old content before paint, not just after an effect runs. */
export function FilePreview(props: PreviewProps) {
  return <PreviewSession key={JSON.stringify([props.runId, props.file.path, props.file.name, props.file.size, props.revision])} {...props} />
}

function PreviewSession(props: PreviewProps) {
  const [attempt, setAttempt] = useState(0)
  return <PreviewAttempt key={attempt} {...props} attempt={attempt} onRetry={() => setAttempt((n) => n + 1)} />
}

/** Full-pane preview shared by the explorer and the compose center pane. */
function PreviewAttempt({ runId, file, onClose, attempt, onRetry, revision = 0 }: PreviewProps & { attempt: number; onRetry: () => void }) {
  const e = ext(file.name)
  const image = IMG_EXT.has(e) || e === 'svg'
  const initialKind = (file.size ?? 0) > MAX_PREVIEW ? 'oversize' : image || TEXT_EXT.has(e) ? 'loading' : 'binary'
  const [state, setState] = useState<PreviewState>({ kind: initialKind })
  const imageDone = useRef<((error?: string) => void) | null>(null)
  const imageElement = useRef<HTMLImageElement | null>(null)
  const url = `/runs/${encodeURIComponent(runId)}/${file.path.split('/').map(encodeURIComponent).join('/')}`
  const imageUrl = revision ? `${url}?previewRetry=${attempt}&revision=${revision}` : attempt ? `${url}?previewRetry=${attempt}` : url
  useEffect(() => {
    if (initialKind !== 'loading') return
    const controller = new AbortController()
    let active = true
    const finish = (next: PreviewState) => {
      if (!active) return
      active = false
      clearTimeout(timer)
      setState(next)
    }
    const timer = setTimeout(() => {
      finish({ kind: 'error', message: 'Preview timed out. Try again or download the file.' })
      controller.abort()
    }, REQUEST_TIMEOUT)
    if (image) {
      imageDone.current = (error) => finish(error ? { kind: 'error', message: error } : { kind: 'image' })
      // Cached images can settle before the passive effect installs the handler.
      const element = imageElement.current
      if (element?.complete) imageDone.current(element.naturalWidth > 0 ? undefined : 'Image could not be loaded.')
    } else {
      void (async () => {
        try {
          const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
          if (!active) { void response.body?.cancel().catch(() => {}); return }
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await readPreviewText(response)
          finish(body.includes('\0') ? { kind: 'binary' } : { kind: 'text', body })
        } catch (error) {
          finish(error instanceof PreviewTooLarge ? { kind: 'oversize' } : { kind: 'error', message: error instanceof Error ? error.message : 'Request failed.' })
        }
      })()
    }
    return () => {
      active = false
      imageDone.current = null
      clearTimeout(timer)
      controller.abort()
    }
  }, [url, image, initialKind])
  const body = state.kind === 'text' ? state.body : null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        {onClose && (
          <button type="button" onClick={onClose} className={controlClass} title="Close preview" aria-label="Close file preview">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="truncate font-mono text-xs text-foreground">{file.path}</span>
        <span className="text-[10px] text-muted-foreground">{fmtSize(file.size)}</span>
        <a href={url} download aria-label={`Download ${file.path}`} className={`ml-auto flex items-center gap-1 text-muted-foreground ${controlClass}`}>
          <Download className="h-3 w-3" /> Download
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {state.kind === 'loading' && <div role="status" className="text-xs text-muted-foreground">Loading preview…</div>}
        {state.kind === 'error' && (
          <div role="alert" className="space-y-2 text-xs text-destructive">
            <p>Could not load preview: {state.message}</p>
            <button type="button" onClick={onRetry} className={controlClass}>Retry preview</button>
          </div>
        )}
        {image && (state.kind === 'loading' || state.kind === 'image') && (
          <img
            ref={imageElement}
            src={imageUrl}
            alt={file.name}
            onLoad={() => imageDone.current?.()}
            onError={() => imageDone.current?.('Image could not be loaded.')}
            className={`max-w-full rounded border border-border/40 ${e === 'svg' ? 'bg-white/5' : ''} ${state.kind === 'loading' ? 'invisible' : ''}`}
          />
        )}
        {body === '' && <div role="status" className="text-xs text-muted-foreground">This file is empty.</div>}
        {e === 'md' && body && (
          <div
            className="max-w-3xl text-[13px] leading-relaxed text-foreground/90 [&_.ae-h]:mt-4 [&_.ae-h]:mb-1 [&_.ae-h]:font-semibold [&_.ae-h]:text-foreground [&_.ae-p]:my-1 [&_.ae-ul]:my-1 [&_.ae-ul]:list-disc [&_.ae-ul]:pl-5 [&_.ae-gap]:h-2 [&_.ae-code]:my-2 [&_.ae-code]:overflow-auto [&_.ae-code]:rounded [&_.ae-code]:bg-black/30 [&_.ae-code]:p-2 [&_.ae-code]:font-mono [&_.ae-code]:text-xs [&_.ae-inline]:rounded [&_.ae-inline]:bg-black/30 [&_.ae-inline]:px-1 [&_.ae-inline]:font-mono [&_.ae-inline]:text-xs [&_.ae-row]:whitespace-pre [&_.ae-row]:font-mono [&_.ae-row]:text-xs"
            dangerouslySetInnerHTML={{ __html: mdToHtml(body) }}
          />
        )}
        {e === 'json' && body && (
          <pre className="overflow-auto rounded bg-black/30 p-2 font-mono text-xs text-foreground/90">
            {(() => { try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body } })()}
          </pre>
        )}
        {e === 'csv' && body && <CsvTable text={body} />}
        {!IMG_EXT.has(e) && !['md', 'json', 'csv', 'svg'].includes(e) && body && (
          <pre className="overflow-auto rounded bg-black/30 p-2 font-mono text-xs text-foreground/90">{body}</pre>
        )}
        {(state.kind === 'oversize' || state.kind === 'binary') && (
          <div role="status" className="text-xs text-muted-foreground">
            {state.kind === 'oversize'
              ? `Too large to preview inline (limit ${fmtSize(MAX_PREVIEW)}) — use Download.`
              : 'Binary or unsupported file — use Download (boards open in KiCad, .step/.glb in a CAD viewer).'}
          </div>
        )}
      </div>
    </div>
  )
}

type ExplorerProps = {
  revision?: number
  runId: string | null
  compact?: boolean
  /** when set, file clicks open in the HOST's pane (IDE center) — no inline preview */
  onOpen?: (f: { name: string; path: string; size?: number }) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function validNodes(value: unknown, depth = 0): value is FileNode[] {
  return depth <= 16 && Array.isArray(value) && value.every((node: unknown) => {
    if (!isRecord(node) || typeof node.name !== 'string' || !node.name || typeof node.path !== 'string' || !node.path || typeof node.dir !== 'boolean') return false
    if (node.path.split('/').some((part) => !part || part === '.' || part === '..')) return false
    if (node.size !== undefined && (typeof node.size !== 'number' || !Number.isFinite(node.size) || node.size < 0)) return false
    if (node.mtime !== undefined && typeof node.mtime !== 'string') return false
    return node.dir ? validNodes(node.children, depth + 1) : node.children === undefined
  })
}

type TreeState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; tree: FileNode[]; count: number }

export function ArtifactExplorer(props: ExplorerProps) {
  return <ExplorerSession key={props.runId} {...props} />
}

function ExplorerSession(props: ExplorerProps) {
  const [attempt, setAttempt] = useState(0)
  return <ExplorerAttempt key={attempt} {...props} onReload={() => setAttempt((n) => n + 1)} />
}

function ExplorerAttempt({ runId, compact, onOpen, onReload, revision = 0 }: ExplorerProps & { onReload: () => void }) {
  const [state, setState] = useState<TreeState>({ kind: 'loading' })
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set(['data', 'disciplines', 'id']))
  const [sel, setSel] = useState<FileNode | null>(null)

  useEffect(() => {
    if (!runId) return
    setState({ kind: 'loading' })
    const controller = new AbortController()
    let active = true
    const finish = (next: TreeState) => {
      if (!active) return
      active = false
      clearTimeout(timer)
      setState(next)
    }
    const timer = setTimeout(() => {
      finish({ kind: 'error', message: 'File listing timed out. Try again.' })
      controller.abort()
    }, REQUEST_TIMEOUT)
    void (async () => {
      try {
        const response = await fetch(`/api/runs/files?run=${encodeURIComponent(runId)}`, { cache: 'no-store', signal: controller.signal })
        if (!active) return
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data: unknown = await response.json()
        if (isRecord(data) && typeof data.error === 'string' && data.error) throw new Error(data.error)
        if (!isRecord(data) || data.runId !== runId || !validNodes(data.tree) || typeof data.files !== 'number' || !Number.isSafeInteger(data.files) || data.files < 0) {
          throw new Error('Invalid file listing response.')
        }
        const countFiles = (nodes: FileNode[]): number => nodes.reduce((total, node) => total + (node.dir ? countFiles(node.children ?? []) : 1), 0)
        if (countFiles(data.tree) !== data.files) throw new Error('Invalid file count in listing response.')
        if (!active) return
        const findFile = (nodes: FileNode[], path: string): FileNode | null => {
          for (const node of nodes) {
            if (!node.dir && node.path === path) return node
            const found = node.children && findFile(node.children, path)
            if (found) return found
          }
          return null
        }
        setSel((previous) => previous ? findFile(data.tree as FileNode[], previous.path) : null)
        finish({ kind: 'ready', tree: data.tree, count: data.files })
      } catch (error) {
        finish({ kind: 'error', message: error instanceof Error ? error.message : 'Request failed.' })
      }
    })()
    return () => {
      active = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [runId, revision])

  const openFile = useCallback((n: FileNode) => {
    setSel(n)
    if (onOpen) onOpen({ name: n.name, path: n.path, size: n.size })
  }, [onOpen])

  const toggle = (p: string) =>
    setOpenDirs((s) => {
      const n = new Set(s)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })

  if (!runId) return <div className="p-4 text-xs text-muted-foreground">No run selected — build a product first.</div>
  if (state.kind === 'error') return (
    <div role="alert" className="space-y-2 p-4 text-xs text-destructive">
      <p>Could not list files: {state.message}</p>
      <button type="button" onClick={onReload} className={controlClass}>Retry file listing</button>
    </div>
  )
  if (state.kind === 'loading') return <div role="status" className="p-4 text-xs text-muted-foreground">Loading file tree…</div>
  const { tree, count } = state

  return (
    <div className="flex h-full min-h-0 text-sm">
      {/* tree pane */}
      <div className={compact
        ? `${sel && !onOpen ? 'hidden' : 'flex'} w-full flex-col`
        : 'flex w-64 shrink-0 flex-col border-r border-border/60'}>
        <div className="flex items-center justify-between border-b border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground">
          <span>{count} files</span>
          <button type="button" onClick={onReload} className={controlClass} title="Refresh files" aria-label="Refresh file listing">
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {count === 0 && <p role="status" className="p-3 text-xs text-muted-foreground">No files generated for this run yet.</p>}
          <Tree nodes={tree} sel={sel?.path ?? null} onSel={openFile} openDirs={openDirs} toggle={toggle} />
        </div>
      </div>
      {/* preview pane (hosts without onOpen only — onOpen mode is tree-only) */}
      {!onOpen && <div className={compact && !sel ? 'hidden' : 'min-w-0 flex-1 overflow-auto'}>
        {!sel ? (
          <div className="p-6 text-xs text-muted-foreground">
            Every file this run generated, live from disk. Select one to preview — markdown, JSON,
            CSV and images render inline; CAD/board binaries download.
          </div>
        ) : (
          <FilePreview revision={revision} runId={runId} file={sel} onClose={compact ? () => setSel(null) : undefined} />
        )}
      </div>}
    </div>
  )
}
