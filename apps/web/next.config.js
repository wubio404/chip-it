/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@taporder/types'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
  // Next's built-in gzip middleware wraps EVERY response it serves, including
  // ones proxied via rewrites() below — and gzip is fundamentally a buffering
  // operation (it needs enough bytes to build a compressed block before
  // flushing). For the admin panel's SSE stream (/api-proxy/admin/.../stream),
  // that turned small, infrequent event writes into multi-second buffered
  // bursts: curl without Accept-Encoding got sub-second delivery, curl
  // --compressed (matching a real browser's default headers) never received
  // the event within 30s. Disabling compression here is safe in production
  // too — the deployed PWA is hosted on Vercel, whose edge network compresses
  // responses independently of this app-level setting (per Vercel's docs).
  compress: false,
  // Proxy /api-proxy/* → API server (avoids browser CORS on cross-port calls).
  // Client components call /api-proxy/orders etc. (same origin);
  // Next.js server forwards to the API server-to-server.
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
    return [
      {
        source: '/api-proxy/:path*',
        destination: `${apiUrl}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
