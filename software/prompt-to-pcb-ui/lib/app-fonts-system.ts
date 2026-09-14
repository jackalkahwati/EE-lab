import type { CSSProperties } from 'react'

/** Actual system fonts for the isolated beta, not a Google-font mock or font gate. */
export const appFontClasses = ''
export const appFontStyle = {
  '--font-inter': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--font-jetbrains-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as CSSProperties
