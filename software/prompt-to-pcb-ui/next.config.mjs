import path from 'node:path'
import { fileURLToPath } from 'node:url'

const betaSystemFonts = process.env.FL_ASTRA_BETA === '1'
const sourceRoot = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // `next build` and `next dev` share `.next` by default, so a build run while
  // someone is using the dev server clobbers its state. Set NEXT_DIST_DIR to
  // build into a scratch dir instead (e.g. NEXT_DIST_DIR=.next-build npm run
  // build). Unset -> normal `.next`, so deploy/deploy.sh is unaffected.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // This bare internal alias is outside tsconfig's @/* mapping, whose Next
  // resolver otherwise wins before webpack aliases. Both bundlers agree.
  webpack(config) {
    config.resolve.alias['firstlight-app-fonts$'] = path.join(sourceRoot,
      betaSystemFonts ? 'lib/app-fonts-system.ts' : 'lib/app-fonts.ts')
    return config
  },
  turbopack: {
    resolveAlias: {
      'firstlight-app-fonts': betaSystemFonts ? './lib/app-fonts-system.ts' : './lib/app-fonts.ts',
    },
  },
  // netlistsvg + its elkjs dep are CommonJS bundles that break under webpack;
  // keep them external so /api/schematic require()s them at runtime (works).
  serverExternalPackages: ['netlistsvg', 'elkjs'],
  images: {
    unoptimized: true,
  },
  // Serverless deploys (Vercel) only bundle files a route provably imports.
  // /api/runs reads run artifacts off disk at request time, so include them
  // explicitly or run history comes back empty in production.
  outputFileTracingIncludes: {
    '/api/runs': ['./public/runs/**', './public/data/**'],
    '/api/schematic': ['./public/runs/**', './lib/schematic-skin.svg'],
  },
  // HTML documents must never be browser-cached: chunk filenames change every
  // build, and a stale document pointing at deleted chunks throws
  // "SyntaxError: Unexpected token '<'" (HTML served where JS was expected).
  // Hashed /_next/static assets stay immutable-cacheable as usual.
  // /compose2 was the preview route that became the primary /compose page
  // (2026-07-09). Keep old links/bookmarks working.
  async redirects() {
    return [
      { source: '/compose2', destination: '/compose', permanent: true },
    ]
  },
  async headers() {
    return [
      {
        source: '/((?!_next/|api/).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ]
  },
}

export default nextConfig
