'use client'

import { useState } from 'react'
import { Zap, MessagesSquare } from 'lucide-react'

const EXAMPLES = [
  '8-probe relay matrix, scope + DMM, RP2040, 24V',
  'compact 4-probe matrix, scope and DMM only, 12V',
  '6-probe, scope + logic analyzer + DAQ lanes, 24V',
  'tiny 2-probe continuity tester, 5V',
]

export function PromptComposer({
  onGenerate,
  onInterview,
  disabled,
}: {
  onGenerate: (prompt: string) => void
  onInterview: (prompt: string) => void
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
      {!prompt && !disabled && (
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setPrompt(ex)}
              className="rounded-full border border-border bg-secondary/50 px-2.5 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {ex}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-muted-foreground">
          ⌘↵ to run · 5 stages · hard gates
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onInterview(prompt.trim())}
            disabled={disabled}
            className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40"
            title="Describe any board in natural language; it asks follow-ups"
          >
            <MessagesSquare className="size-3.5" />
            Design Interview
          </button>
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
    </div>
  )
}
