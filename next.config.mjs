/**
 * Sent with every response. No `script-src` on purpose: Next renders inline bootstrap
 * scripts per request, so a script policy needs a per-request nonce (and a browser to
 * try it in) — the directives below are the ones that cost nothing and cannot break a page.
 * The newsletter preview is a sandboxed `srcdoc` iframe, which these never apply to.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
  // `same-origin`, not `no-referrer`: with the latter a browser sends `Origin: null` on
  // same-origin POSTs, which the cross-site write check in src/proxy.ts would refuse.
  // It also keeps this host's name away from TMDB, which serves the posters directly.
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  // Every outbound link already opens with `noopener`; this closes the other direction.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // better-sqlite3 is a native module and must not be bundled by webpack.
  serverExternalPackages: ['better-sqlite3'],
  // Remote artwork is proxied through our own API, so no remote image hosts are needed.
  images: { unoptimized: true },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
