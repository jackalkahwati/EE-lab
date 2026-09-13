import { headers } from 'next/headers'
import { PrivateAnalytics } from '@/components/private-analytics'
import { START_SCRUB_SCRIPT } from '@/lib/start-draft'
import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { TopNav } from '@/components/top-nav'
import { CommandPalette } from '@/components/command-palette'

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] })
const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'Firstlight, Prompt to PCBA',
  description:
    'Turn a natural-language hardware request into a fabrication-ready PCB through a fixed 4-stage pipeline with hard quality gates.',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  themeColor: '#0f0f0f',
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const nonce = (await headers()).get('x-start-nonce') ?? undefined
  return (
    <html
      lang="en"
      className={`bg-background ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {nonce && <script nonce={nonce} dangerouslySetInnerHTML={{ __html: START_SCRUB_SCRIPT }} />}
      </head>
      <body className="font-sans antialiased">
        {!nonce && <TopNav />}
        {!nonce && <CommandPalette />}
        {children}
        {!nonce && process.env.NODE_ENV === 'production' && process.env.VERCEL === '1' && <PrivateAnalytics />}
      </body>
    </html>
  )
}
