# One place for the Node version; release.yml passes the value from pyproject.toml as a build-arg
# so the published image and the CI toolchain cannot drift apart.
ARG NODE_VERSION=26.13.1

# Debian (glibc) rather than Alpine: better-sqlite3 ships prebuilds for musl as well, so that is
# not the reason. Debian stays because it is what the app is tested on and it avoids musl-specific
# surprises in DNS resolution and the native module; the cost is a larger image.
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

FROM node:${NODE_VERSION}-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Becomes next.config.mjs `deploymentId`, which tells open tabs that the server was replaced.
# release.yml passes one. A local `docker build` without it gets a unique id here: the
# standalone server keeps the configuration of this build (unlike `next start`, which reads
# next.config.mjs again), so the id cannot drift between build and start, and the version
# alone, which is next.config.mjs's fallback, would stay the same across two local builds.
ARG WATCHARR_BUILD_ID
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN WATCHARR_BUILD_ID="${WATCHARR_BUILD_ID:-local-$(date +%s)}" npm run build

FROM node:${NODE_VERSION}-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_PATH=/app/data/watcharr.db
# Docker sets HOSTNAME to the container id and Next's standalone server binds to it, so
# without this it listens on the container's bridge address only and the healthcheck
# (localhost:3000) never gets an answer.
ENV HOSTNAME=0.0.0.0
# Next exits 143 on SIGTERM, which Portainer shows as a crash; instrumentation.ts exits 0 instead.
ENV NEXT_MANUAL_SIG_HANDLE=1
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
# Same probe as docker-compose.yml, so a plain `docker run` is monitored too. 127.0.0.1, not
# localhost: the server listens on IPv4 only. ?live=1 checks the app and its database but not
# the media servers, whose outage is not the container's fault. start_period covers migrations,
# the pre-upgrade backup and a start-up VACUUM, which take minutes on a big database; the first
# success still marks the container healthy right away.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health?live=1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run before the server starts; already applied files are skipped. `exec` makes node
# PID 1: a plain `sh -c a && b` keeps the shell as PID 1, which ignores SIGTERM, so every stop or
# restart ended in a SIGKILL after 10 s and left the SQLite WAL unclosed.
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node server.js"]
