'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ATO_FILES, type AtoFile } from '@/lib/firstlight'
import { FileCode2 } from 'lucide-react'

/* lightweight .ato syntax highlighting */
function highlightLine(line: string, key: number) {
  if (line.trim().startsWith('#')) {
    return (
      <span key={key} className="text-muted-foreground/70">
        {line}
      </span>
    )
  }

  const tokens = line.split(
    /(\bmodule\b|\bimport\b|\bfrom\b|\bnew\b|\bsignal\b|\binterface\b|\bfor\b|\bin\b|\bassert\b|\bwithin\b|\bto\b|"[^"]*"|#.*$)/g,
  )
  return (
    <span key={key}>
      {tokens.map((tok, i) => {
        if (!tok) return null
        if (
          /^(module|import|from|new|signal|interface|for|in|assert|within|to)$/.test(
            tok,
          )
        ) {
          return (
            <span key={i} className="text-primary">
              {tok}
            </span>
          )
        }
        if (tok.startsWith('"')) {
          return (
            <span key={i} className="text-success">
              {tok}
            </span>
          )
        }
        if (tok.startsWith('#')) {
          return (
            <span key={i} className="text-muted-foreground/70">
              {tok}
            </span>
          )
        }
        return <span key={i}>{tok}</span>
      })}
    </span>
  )
}

export function CodeViewer({ files }: { files?: AtoFile[] | null }) {
  const data = files && files.length > 0 ? files : ATO_FILES
  const [selected, setSelected] = useState(data[0].name)
  const file = data.find((f) => f.name === selected) ?? data[0]
  const lines = file.content.split('\n')

  return (
    <div className="flex h-full">
      <nav
        className="w-44 shrink-0 border-r border-border bg-card"
        aria-label="ato source files"
      >
        <p className="border-b border-border px-3 py-2 font-mono text-[10px] tracking-wide text-muted-foreground">
          elec/src/
        </p>
        <ul>
          {data.map((f) => (
            <li key={f.name}>
              <button
                type="button"
                onClick={() => setSelected(f.name)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 font-mono text-xs transition-colors',
                  f.name === selected
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <FileCode2 className="size-3.5 shrink-0" />
                {f.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex-1 overflow-auto bg-[#07090c]">
        <pre className="p-4 font-mono text-xs leading-relaxed">
          <code>
            {lines.map((line, i) => (
              <div key={i} className="flex">
                <span className="w-8 shrink-0 select-none pr-3 text-right text-muted-foreground/40">
                  {i + 1}
                </span>
                {highlightLine(line, i)}
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  )
}
