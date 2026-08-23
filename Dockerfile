# better-sqlite3 is the only native dependency. Since v12 it ships prebuilt binaries for
# linux/darwin/win × x64/arm64 inside its own npm tarball — but it also ships a binding.gyp,
# and npm compiles any package that has one. That compile needs Python and a C++ toolchain,
# neither of which is in a slim image, which is exactly how this build used to fail.
#
# --ignore-scripts skips that pointless rebuild and the loader falls back to the bundled
# prebuild. better-sqlite3 is the only package here with an install script, so nothing else
# loses anything. Debian rather than Alpine because the prebuilds are glibc.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/watcharr.db
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts
# No separate COPY for better-sqlite3: Next's output tracing already puts the package and
# its prebuilds into .next/standalone. Verified by booting the assembled runner and hitting
# /api/health — if that ever stops holding, the server dies on the first query, not later.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
# Migrations run before the server starts; already applied files are skipped.
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
