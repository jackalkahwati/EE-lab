'use client'

import { useState } from 'react'
import { Zap } from 'lucide-react'

export function PromptComposer({
  onGenerate,
  disabled,
}: {
  onGenerate: (prompt: string) => void
  disabled: boolean
}) {
  const [prompt, setPrompt] = useState('')

  const submit = () => {
    if (disabled) return
    onGenerate(
      prompt.trim() ||
        '8x11 relay probe matrix, 4-layer, RP2040 control, USB-C, 24V input',
    )
    setPrompt('')
  }

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-border bg-card p-3">
      <label htmlFor="board-prompt" className="sr-only">
        Describe the board
      </label>
      <textarea
        id="board-prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
        }}
        rows={2}
        placeholder="Describe the board… e.g. 8x11 relay probe matrix, 4-layer, RP2040 control, USB-C, 24V input"
        className="w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-muted-foreground">
          ⌘↵ to run · 4 stages · hard gates
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Zap className="size-3.5" />
          {disabled ? 'Pipeline running…' : 'Generate Board'}
        </button>
      </div>
    </div>
  )
}
