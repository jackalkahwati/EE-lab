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

import { useCallback, useEffect, useMemo, useState } from 'react'
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
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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
    const line = esc(raw)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="ae-inline">$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" class="underline">$1</a>')
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
              onClick={() => (n.dir ? toggle(n.path) : onSel(n))}
              className={`flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-xs hover:bg-accent/50 ${sel === n.path ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
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

export function ArtifactExplorer({ runId, compact }: { runId: string | null; compact?: boolean }) {
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const [count, setCount] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set(['data', 'disciplines', 'id']))
  const [sel, setSel] = useState<FileNode | null>(null)
  const [body, setBody] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    if (!runId) return
    setErr(null)
    fetch(`/api/runs/files?run=${encodeURIComponent(runId)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setErr(String(d.error))
        else { setTree(d.tree); setCount(d.files) }
      })
      .catch((e) => setErr(String(e)))
  }, [runId])

  useEffect(() => { setTree(null); setSel(null); setBody(null); load() }, [load])

  const openFile = useCallback((n: FileNode) => {
    setSel(n)
    setBody(null)
    const e = ext(n.name)
    if (IMG_EXT.has(e)) return // <img> loads itself
    if (!TEXT_EXT.has(e) || (n.size ?? 0) > MAX_PREVIEW) return // download-only
    setLoading(true)
    fetch(`/runs/${runId}/${n.path}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setBody)
      .catch((er) => setBody(`⚠ could not load: ${String(er)}`))
      .finally(() => setLoading(false))
  }, [runId])

  const toggle = (p: string) =>
    setOpenDirs((s) => {
      const n = new Set(s)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })

  if (!runId) return <div className="p-4 text-xs text-muted-foreground">No run selected — build a product first.</div>
  if (err) return <div className="p-4 text-xs text-red-400">Could not list files: {err}</div>
  if (!tree) return <div className="p-4 text-xs text-muted-foreground">Loading file tree…</div>

  const e = sel ? ext(sel.name) : ''
  const url = sel ? `/runs/${runId}/${sel.path}` : ''

  return (
    <div className="flex h-full min-h-0 text-sm">
      {/* tree pane */}
      <div className={compact
        ? `${sel ? 'hidden' : 'flex'} w-full flex-col`
        : 'flex w-64 shrink-0 flex-col border-r border-border/60'}>
        <div className="flex items-center justify-between border-b border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground">
          <span>{count} files</span>
          <button onClick={load} className="rounded p-1 hover:bg-accent/50" title="Refresh">
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <Tree nodes={tree} sel={sel?.path ?? null} onSel={openFile} openDirs={openDirs} toggle={toggle} />
        </div>
      </div>
      {/* preview pane */}
      <div className={compact && !sel ? 'hidden' : 'min-w-0 flex-1 overflow-auto'}>
        {!sel ? (
          <div className="p-6 text-xs text-muted-foreground">
            Every file this run generated, live from disk. Select one to preview — markdown, JSON,
            CSV and images render inline; CAD/board binaries download.
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
              {compact && (
                <button onClick={() => { setSel(null); setBody(null) }} className="rounded p-0.5 hover:bg-accent/50" title="Back to files">
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
              )}
              <span className="truncate font-mono text-xs text-foreground">{sel.path}</span>
              <span className="text-[10px] text-muted-foreground">{fmtSize(sel.size)}</span>
              <a href={url} download className="ml-auto flex items-center gap-1 rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/50">
                <Download className="h-3 w-3" /> Download
              </a>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {loading && <div className="text-xs text-muted-foreground">Loading…</div>}
              {IMG_EXT.has(e) && <img src={url} alt={sel.name} className="max-w-full rounded border border-border/40" />}
              {e === 'svg' && <img src={url} alt={sel.name} className="max-w-full rounded border border-border/40 bg-white/5" />}
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
              {!loading && body == null && !IMG_EXT.has(e) && e !== 'svg' && (
                <div className="text-xs text-muted-foreground">
                  {(sel.size ?? 0) > MAX_PREVIEW
                    ? `Too large to preview inline (${fmtSize(sel.size)}) — use Download.`
                    : 'Binary file — use Download (boards open in KiCad, .step/.glb in a CAD viewer).'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
