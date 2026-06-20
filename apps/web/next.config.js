/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@taporder/types'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
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
