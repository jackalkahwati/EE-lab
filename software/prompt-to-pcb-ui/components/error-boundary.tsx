'use client'

import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
  label?: string
}
interface State {
  error: Error | null
}

/** Keeps one bad panel from white-screening the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle className="size-6 text-destructive" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">
              {this.props.label ?? 'This panel'} hit an error
            </p>
            <p className="max-w-md font-mono text-[11px] leading-relaxed text-muted-foreground">
              {this.state.error.message}
            </p>
          </div>
          <button
            type="button"
            onClick={this.reset}
            className="rounded-sm border border-border px-3 py-1.5 font-mono text-[11px] text-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
