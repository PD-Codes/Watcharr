<div align="center">

# Watcharr

**Self-hosted companion app for a single Plex, Jellyfin or Emby server.**

Watchlist · history · live activity · statistics · suggestions · year in review

[![CI](https://github.com/PD-Codes/watcharr/actions/workflows/ci.yml/badge.svg)](https://github.com/PD-Codes/watcharr/actions/workflows/ci.yml)
[![Release](https://github.com/PD-Codes/watcharr/actions/workflows/release.yml/badge.svg)](https://github.com/PD-Codes/watcharr/actions/workflows/release.yml)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![Container](https://img.shields.io/badge/ghcr.io-pd--codes%2Fwatcharr-2496ed?logo=docker&logoColor=white)](https://github.com/PD-Codes/watcharr/pkgs/container/watcharr)

</div>

---

## ⚠️ Not part of the \*arr stack

**Watcharr is not affiliated with, endorsed by, or derived from Servarr or any \*arr
application** — Sonarr, Radarr, Lidarr, Readarr, Prowlarr, Bazarr and the rest are separate
projects by separate people. The name simply rhymes.

Watcharr does not download, index, request, rename or manage anything. It reads from one
media server you already run and shows you what was watched on it. If you are looking for
request management, use [Overseerr](https://overseerr.dev/) or
[Jellyseerr](https://github.com/Fallenbagel/jellyseerr).

---

## What it is

You already run a media server. It knows exactly what everyone watched, for how long, on
what device and whether it had to transcode — and it shows you almost none of it. Watcharr
is a small companion app that sits next to it and answers those questions, for regular users
and for the admin, without asking anyone to create yet another account.

- **One server per deployment.** Plex *or* Jellyfin *or* Emby, chosen once during setup.
- **No password system.** People sign in with their media server account. The server's admin
  flag becomes the app's admin role.
- **One container, one file.** SQLite, no separate database service, no Redis, no queue.
- **Everything drills down.** A number, a genre, a day in the heatmap, an hour in the week
  grid and every title lead to the plays behind them, down to the individual episode.

### For users

| | |
|---|---|
| **Watchlist** | Search the library, mark titles as planned / watching / done. Plex watchlists are synced where the server exposes them. |
| **History** | Every play, filterable by search, type, period, genre, day, weekday and hour. Exportable as CSV. |
| **Activity** | What is playing right now, with progress, timecode and transcode state. |
| **Statistics** | Watch time, plays, streaks, active days, records, daily and monthly activity, top genres, titles, devices, peak hours, a weekday × hour grid, a 365-day film-strip heatmap, plus how your own streams were delivered (direct play vs. transcode, codecs, resolutions, bitrates). |
| **Suggestions** | Derived from your own history — genres, decades, formats — and optionally enriched with TMDB "similar titles". Each card links to the title page and out to the media server. |
| **Wrapped** | A year in review: totals, first and last play of the year, top genres and titles, a calendar of the year, weekday crown, devices. |
| **Search** | <kbd>⌘K</kbd> / <kbd>Ctrl</kbd>+<kbd>K</kbd> over watched titles, the library and (for admins) users. |

### For admins

| | |
|---|---|
| **All activity** | Every live stream on the server: user, title, client, device, bandwidth, transcode reason. |
| **Server statistics** | Server-wide totals, most watched content, user leaderboard, peak times. |
| **Transcoding** | Direct play share, transcode reasons, video codecs, containers, resolutions, bitrate distribution. |
| **Clients** | Sessions and watch time per client, per device and per user. |
| **Users** | All server users with a per-user drilldown into their stats and history. |
| **System** | Media server reachability, API health, sync status. |
| **Configuration** | Server URL and token, optional TMDB key, feature toggles. |

Transcoding and client statistics are recorded from live sessions, so they start empty on a
fresh install and fill up as people watch. History-based statistics are backfilled from the
media server on the first sync and are complete immediately.

### Interface

Graphite throughout, with one rule: **amber only ever means "playing" or "this is data"**.
Nothing decorative is amber. Charts are inline SVG rendered on the server — no charting
library, no client-side data fetching, no CDN. Dark and light schemes, full keyboard access,
`prefers-reduced-motion` respected, and a layout that is built for a phone rather than
merely surviving on one: a Material navigation bar, a modal drawer, thumb-sized targets and
horizontally scrollable charts.

---

## Requirements

- A running **Plex**, **Jellyfin** or **Emby** server that this app can reach over HTTP(S)
- **Docker** with Compose v2 — *or* **Node.js 22+** if you would rather run it directly
- ~100 MB disk for the image, plus a few MB per year of watch history

Watcharr makes no outbound connections of its own. It talks to your media server, to
`plex.tv` if you use Plex sign-in, and to TMDB only if you configure an API key.

---

## Installation

### Docker Compose (recommended)

```bash
mkdir watcharr && cd watcharr
curl -O https://raw.githubusercontent.com/PD-Codes/watcharr/main/docker-compose.yml

# SESSION_SECRET signs session cookies and encrypts media server tokens at rest.
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env

docker compose up -d
```

`docker compose up -d` pulls the published image from `ghcr.io/pd-codes/watcharr:latest`.
To build this checkout instead, use `docker compose up -d --build`.

Pin a version in production so an upgrade is something you decide to do:

```bash
echo "WATCHARR_TAG=1.0.0" >> .env
docker compose up -d
```

### Plain Docker

```bash
docker run -d \
  --name watcharr \
  -p 3000:3000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e DATABASE_PATH=/app/data/watcharr.db \
  -v watcharr-data:/app/data \
  --restart unless-stopped \
  ghcr.io/pd-codes/watcharr:latest
```

Available tags: `latest`, `1`, `1.0`, `1.0.0`. Images are published for
`linux/amd64` and `linux/arm64`, so a Raspberry Pi or an ARM NAS works without changes.

### From source

```bash
git clone https://github.com/PD-Codes/watcharr.git
cd watcharr

cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env

# --ignore-scripts skips a needless native rebuild of better-sqlite3, which ships
# prebuilt binaries for linux/macOS/Windows on x64 and arm64. Without it you need
# Python and a C++ toolchain for no benefit.
npm ci --ignore-scripts
npm run build
npm start
```

Database migrations are applied automatically on every start — `npm run dev`, `npm start`
and the container all run them first. There is no separate migration step to remember.

---

## Configuration

Everything except these few variables is configured in the app itself, on the admin
configuration page.

| Variable | Default | What it does |
|---|---|---|
| `SESSION_SECRET` | *(required)* | Signs session cookies and derives the key that encrypts media server tokens at rest. Generate with `openssl rand -hex 32`. **Changing it invalidates every stored token and signs everyone out.** |
| `DATABASE_PATH` | `./data/watcharr.db` | SQLite file. The container defaults to `/app/data/watcharr.db`; keep that path on a volume. |
| `APP_URL` | `http://localhost:3000` | Public base URL of this deployment. Used for the Plex sign-in callback. |
| `PORT` | `3000` | Port the server listens on. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | *(unset)* | Set to `0` **only** if your media server uses a self-signed certificate. It disables certificate checking process-wide. |

---

## First run

Open <http://localhost:3000>. The setup wizard runs once and asks for three things: the
server type, the server URL and an admin API token.

<details>
<summary><strong>Jellyfin</strong> — Dashboard → API Keys</summary>

1. Sign in to Jellyfin as an administrator.
2. Go to **Dashboard → Advanced → API Keys** and press **+**.
3. Name it `Watcharr` and copy the generated key.
4. Server URL is the same one you use in the browser, for example
   `http://192.168.1.10:8096`. Do not include a trailing path.

</details>

<details>
<summary><strong>Emby</strong> — Settings → API Keys</summary>

1. Sign in to Emby as an administrator.
2. Go to **Settings → Advanced → API Keys** and create a new key named `Watcharr`.
3. Server URL is for example `http://192.168.1.10:8096`.

</details>

<details>
<summary><strong>Plex</strong> — the X-Plex-Token of the server owner</summary>

1. Open any library item in Plex Web, choose **⋮ → Get Info → View XML**.
2. The URL of the XML page ends in `&X-Plex-Token=…` — that value is your token.
   ([Plex's own instructions](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/))
3. Server URL is your Plex Media Server address, for example `http://192.168.1.10:32400`.
4. Make sure `APP_URL` is set to the URL people will actually open, otherwise the PIN
   sign-in flow returns them to the wrong place.

</details>

After setup, everyone else signs in with their own media server account:

- **Plex** — the plex.tv PIN flow. Approve the code, come back, done.
- **Jellyfin / Emby** — their normal username and password, verified by the server.

Watcharr never stores a password. The token the media server hands back is encrypted and
kept server-side; the browser only ever gets a signed session id.

---

## Behind a reverse proxy

Set `APP_URL` to the public URL and forward to port 3000. The app sets no cookies that need
a subpath, but it does expect to live at the root of whatever host it is served from.

<details>
<summary>Caddy</summary>

```caddy
watcharr.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

</details>

<details>
<summary>nginx</summary>

```nginx
server {
    listen 443 ssl http2;
    server_name watcharr.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

</details>

---

## Updating

```bash
docker compose pull && docker compose up -d
```

Migrations run on start; already-applied files are skipped. Take a backup first if you are
crossing a major version — see below.

Watch [Releases](https://github.com/PD-Codes/watcharr/releases) for what changed. Versioning
is semantic: a major bump means something needs your attention.

## Backup

Everything lives in one SQLite file. Stop the container, copy it, start it again:

```bash
docker compose stop
docker run --rm -v watcharr-data:/data -v "$PWD:/backup" busybox \
  tar czf /backup/watcharr-backup.tar.gz -C /data .
docker compose start
```

Copying the file while the app is running can catch it mid-write; SQLite runs in WAL mode,
so the `-wal` and `-shm` sidecars belong in the backup too. The command above takes the
whole directory, which covers them.

Your `SESSION_SECRET` is part of the backup in the sense that the database is useless
without it — stored media server tokens are encrypted with a key derived from it. Keep it
somewhere safe and separate.

---

## Security

- No local password store. Authentication is delegated to the media server, and its admin
  flag is the only source of the admin role.
- Media server tokens are encrypted at rest (AES-256-GCM) with a key derived from
  `SESSION_SECRET`.
- Session cookies carry a signed random id and nothing else; sessions live server-side and
  expired ones are cleaned up on sign-in.
- Artwork is proxied through `/api/art/[itemId]` so a token never reaches a browser. The
  proxy enforces a session, an allowlist on the item id, an origin match against the
  configured server, an `image/*` response type and an upstream timeout.
- Login and Plex PIN polling are rate limited.
- `/api/health` reports database and media server health and backs the container
  healthcheck.

Found something? Please open a
[security advisory](https://github.com/PD-Codes/watcharr/security/advisories/new) rather
than a public issue.

---

## Development

```bash
npm ci --ignore-scripts
npm run dev          # applies migrations, then starts the dev server on :3000

npm run typecheck
npm test             # adapters, suggestion scoring, migrations, aggregate SQL, encryption
npm run test:routes  # builds, boots the app against a stub media server, requests every route
npm run preview      # the app against the same stub, seeded with a year of deterministic plays
```

Every suite creates its own throwaway SQLite file and, where needed, a fake Jellyfin server.
Nothing has to be running alongside. `npm run preview` (port 3311) exists for design work,
because empty charts say nothing about layout and density.

### Layout

```
src/db/schema.ts          Schema: users, watchlist, watch_history, playback_sessions,
                          auth_sessions, suggestions_cache, app_config
scripts/migrate.mjs       Applies drizzle/*.sql on start, tracked in a _migrations table

src/server/adapters/      The only place that knows a media server API
  types.ts                MediaServerAdapter — the interface every backend implements
  jellyfin.ts             Covers Jellyfin AND Emby (only the auth header differs)
  plex.ts                 Including the PIN OAuth flow
src/server/config.ts      Single-row deployment configuration + adapter factory
src/server/session.ts     Server-side sessions
src/server/crypto.ts      AES-256-GCM for tokens at rest
src/server/sync.ts        Throttled history / activity / watchlist sync
src/server/stats.ts       History aggregates, per user or server-wide
src/server/playback.ts    Session aggregates: clients, codecs, transcoding
src/server/history.ts     Filter building for the history page and the CSV export
src/server/deeplink.ts    Link into the media server's own web UI
src/server/scoring.ts     Pure suggestion heuristic (no server-only, unit tested)

src/components/           Charts, the Beam (now playing), tooltip, icons, palette
src/app/(app)/            User and admin pages, navigation, per-item detail
src/app/api/              Auth, setup, artwork proxy, search, CSV export, health
src/i18n/                 Translations — en-US only in v1, ready for more
```

**Rule:** nothing outside `src/server/adapters/` talks to a media server API. Adding a
backend means implementing `MediaServerAdapter` and registering it in `index.ts`.

### Releasing

The version in [`pyproject.toml`](pyproject.toml) is the only trigger. This is not a Python
project — the file exists so that one obvious, human-editable place decides what gets
published.

1. Raise `version` in `pyproject.toml` **and** `package.json` (the workflow refuses to
   publish when they disagree).
2. Merge to `main`.

[`.github/workflows/release.yml`](.github/workflows/release.yml) then runs the test suite,
builds `linux/amd64` and `linux/arm64` images, pushes them to `ghcr.io/pd-codes/watcharr`
as `<version>`, `<major>.<minor>`, `<major>` and `latest`, and creates the matching git tag
and GitHub release. A version that is already tagged is skipped, so re-runs and reverts
cannot publish twice. A version containing a hyphen (`1.1.0-rc1`) is published as a
pre-release and never becomes `latest`.

---

## Contributing

Issues and pull requests are welcome. Please run `npm run typecheck`, `npm test` and
`npm run test:routes` before opening a PR — CI runs all three anyway, and the route suite
catches the render and SQL-dialect mistakes a type check cannot see.

Code comments are written in English and explain *why*, not *what*. The UI language is
US English.

---

## License

Copyright (C) 2026 PD-Codes

This program is free software: you can redistribute it and/or modify it under the terms of
the **GNU General Public License, version 3** or (at your option) any later version, as
published by the Free Software Foundation.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
See the [GNU General Public License](LICENSE) for more details.

## Acknowledgements

Plex, Jellyfin and Emby are trademarks of their respective owners. Watcharr is an
independent project and is not affiliated with any of them, nor with TMDB, nor — as noted
at the top — with the \*arr / Servarr projects. Optional metadata is provided by
[TMDB](https://www.themoviedb.org/); this product uses the TMDB API but is not endorsed or
certified by TMDB.
