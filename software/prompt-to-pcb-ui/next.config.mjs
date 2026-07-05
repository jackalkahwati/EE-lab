/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Serverless deploys (Vercel) only bundle files a route provably imports.
  // /api/runs reads run artifacts off disk at request time, so include them
  // explicitly or run history comes back empty in production.
  outputFileTracingIncludes: {
    '/api/runs': ['./public/runs/**', './public/data/**'],
  },
  // HTML documents must never be browser-cached: chunk filenames change every
  // build, and a stale document pointing at deleted chunks throws
  // "SyntaxError: Unexpected token '<'" (HTML served where JS was expected).
  // Hashed /_next/static assets stay immutable-cacheable as usual.
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
