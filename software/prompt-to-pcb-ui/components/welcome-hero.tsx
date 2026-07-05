'use client'

/**
 * First-visit hero: one clear action (describe your board) plus a 3-step
 * explanation of what happens next. Shown until the user starts a design or
 * chooses to explore; never blocks returning users (localStorage flag).
 */

import { useState } from 'react'
import { ArrowRight, MessagesSquare, CircuitBoard, Download } from 'lucide-react'

const EXAMPLES = [
  'LoRa GNSS asset tracker, USB-C charging',
  'Quad stepper driver, CAN bus, 24V',
  '8-probe relay test matrix, RP2040',
  'BLE environmental sensor node, coin cell',
]

const STEPS = [
  {
    icon: MessagesSquare,
    title: 'Describe it',
    body: 'Plain language. A short interview fills in the details, MCU, radio, power, with sensible defaults.',
  },
  {
    icon: CircuitBoard,
    title: 'Watch it build',
    body: 'Design, placement, routing, electrical checks, and firmware run as a live pipeline in front of you.',
  },
  {
    icon: Download,
    title: 'Get real outputs',
    body: 'A manufacturable fab package and firmware, ready for your board house, plus the FL-1 test plan.',
  },
]

export function WelcomeHero({
  onStart,
  onExplore,
}: {
  onStart: (prompt: string) => void
  onExplore: () => void
}) {
  const [prompt, setPrompt] = useState('')

  const start = () => onStart(prompt.trim())

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
            FirstLight Compose
          </p>
          <h1 className="mb-3 text-3xl font-bold tracking-tight text-foreground">
            Describe a board. Get a board.
          </h1>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            From a sentence to a routed, checked, manufacturable PCB with
            firmware, in one continuous run.
          </p>
        </div>

        <div className="mb-4 rounded-lg border border-border bg-card p-4 shadow-xl">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                start()
              }
            }}
            rows={2}
            autoFocus
            placeholder="What are you building? e.g. a solar-powered soil sensor with LoRa…"
            className="mb-3 w-full resize-none bg-transparent text-base leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setPrompt(ex)}
                  className="rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  {ex}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={start}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Design my board
              <ArrowRight className="size-4" />
            </button>
          </div>
        </div>

        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title} className="rounded-lg border border-border bg-card/50 p-3.5">
              <div className="mb-2 flex items-center gap-2">
                <s.icon className="size-4 text-primary" />
                <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                <span className="text-xs font-semibold text-foreground">{s.title}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>

        <div className="text-center">
          <button
            type="button"
            onClick={onExplore}
            className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Skip, explore example boards instead
          </button>
        </div>
      </div>
    </div>
  )
}
