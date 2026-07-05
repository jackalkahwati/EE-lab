/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  // HTML must never be browser-cached (stale documents hide content updates
  // and can reference dead chunk files). Hashed assets stay cacheable.
  async headers() {
    return [
      {
        source: '/((?!_next/|media/).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
