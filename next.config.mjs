/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // better-sqlite3 is a native module and must not be bundled by webpack.
  serverExternalPackages: ['better-sqlite3'],
  // Remote artwork is proxied through our own API, so no remote image hosts are needed.
  images: { unoptimized: true },
};

export default nextConfig;
