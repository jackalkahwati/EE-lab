'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  MessagesSquare,
  X,
  Send,
  Loader2,
  CircuitBoard,
  Sparkles,
  ArrowRight,
} from 'lucide-react'

interface Answer {
  question: string
  answer: string
}
interface Question {
  type: 'question'
  boardClass: string
  blocks: string[]
  question: string
  options: string[]
  default: string
}
interface Spec {
  type: 'spec'
  boardClass: string
  blocks: string[]
  spec: Record<string, unknown>
  summary: string
  buildable: boolean
  request: string
}

export function InterviewPanel({
  request,
  onGenerate,
  onClose,
}: {
  request: string
  onGenerate: (prompt: string) => void
  onClose: () => void
}) {
  const [answers, setAnswers] = useState<Answer[]>([])
  const [current, setCurrent] = useState<Question | null>(null)
  const [spec, setSpec] = useState<Spec | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const ask = useCallback(
    async (acc: Answer[]) => {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch('/api/interview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ request, answers: acc }),
        })
        const data = await r.json()
        if (data.error) throw new Error(data.error)
        if (data.type === 'spec') setSpec(data as Spec)
        else setCurrent(data as Question)
      } catch (e) {
        setError(String(e))
      } finally {
        setLoading(false)
      }
    },
    [request],
  )

  useEffect(() => {
    ask([])
  }, [ask])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [answers, current, spec, loading])

  const answer = (value: string) => {
    if (!current || !value.trim()) return
    const next = [...answers, { question: current.question, answer: value.trim() }]
    setAnswers(next)
    setCurrent(null)
    setTyped('')
    ask(next)
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[640px] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <MessagesSquare className="size-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Design Interview</span>
            {current?.boardClass && (
              <span className="rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                {current.boardClass}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Close interview"
          >
            <X className="size-4" />
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
          {/* the request */}
          <div className="flex justify-end">
            <div className="max-w-[80%] rounded-md bg-primary/10 px-3 py-2 text-sm text-foreground">
              {request}
            </div>
          </div>

          {/* answered turns */}
          {answers.map((a, i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <p className="text-sm text-muted-foreground">{a.question}</p>
              </div>
              <div className="flex justify-end">
                <div className="rounded-md bg-secondary px-3 py-1.5 font-mono text-xs text-foreground">
                  {a.answer}
                </div>
              </div>
            </div>
          ))}

          {/* current question */}
          {current && !loading && (
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <p className="text-sm font-medium text-foreground">{current.question}</p>
              </div>
              <div className="flex flex-wrap gap-1.5 pl-5">
                {current.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => answer(opt)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors',
                      opt === current.default
                        ? 'border-primary/50 bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
                    )}
                  >
                    {opt}
                    {opt === current.default && ' ·default'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 pl-5 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="font-mono text-[11px]">thinking…</span>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-[11px] text-destructive">
              {error}
            </div>
          )}

          {/* finalized spec */}
          {spec && (
            <div className="space-y-3 rounded-md border border-border bg-background p-3">
              <div className="flex items-center gap-2">
                <CircuitBoard className="size-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">{spec.boardClass}</span>
              </div>
              <p className="text-xs text-muted-foreground">{spec.summary}</p>
              <div className="flex flex-wrap gap-1.5">
                {spec.blocks.map((b) => (
                  <span
                    key={b}
                    className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                  >
                    {b}
                  </span>
                ))}
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
                {Object.entries(spec.spec).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 border-b border-border/40 py-0.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-foreground">{String(v)}</dd>
                  </div>
                ))}
              </dl>
              {spec.buildable ? (
                <button
                  type="button"
                  onClick={() => {
                    onGenerate(spec.request)
                    onClose()
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
                >
                  Generate this board <ArrowRight className="size-4" />
                </button>
              ) : (
                <div className="rounded-sm border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
                  Spec captured. A generator for{' '}
                  <span className="font-semibold">{spec.boardClass}</span> isn’t built
                  yet — today the pipeline routes the relay/probe-matrix family. This
                  spec is the exact input the block-composition engine (Layer 2) will
                  consume.
                </div>
              )}
            </div>
          )}
        </div>

        {/* free-text answer */}
        {current && !spec && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              answer(typed)
            }}
            className="flex items-center gap-2 border-t border-border p-3"
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="…or type your own answer"
              className="flex-1 rounded-sm border border-border bg-secondary px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!typed.trim()}
              className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              <Send className="size-3.5" /> Send
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
