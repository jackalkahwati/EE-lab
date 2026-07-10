/** @type {import('next').NextConfig} */
const nextConfig = {
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
