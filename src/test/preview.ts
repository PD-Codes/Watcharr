/**
 * Design preview harness: seeds a year of plausible watch data, fakes a Jellyfin
 * server and boots the built app so the UI can be looked at with realistic density.
 * Not a test — it stays running until interrupted.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'watcharr-preview-'));
const APP_PORT = 3311;
const STUB_PORT = 39011;
process.env.DATABASE_PATH = join(dir, 'preview.db');
process.env.SESSION_SECRET = 'preview-secret';

execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', env: process.env });

const TITLES: [string, string, number, string[]][] = [
  ['Blade Runner', 'movie', 1982, ['Sci-Fi', 'Noir']],
  ['Arrival', 'movie', 2016, ['Sci-Fi', 'Drama']],
  ['Dune: Part Two', 'movie', 2024, ['Sci-Fi', 'Adventure']],
  ['The Bear', 'episode', 2022, ['Comedy', 'Drama']],
  ['Severance', 'episode', 2022, ['Sci-Fi', 'Thriller']],
  ['Chernobyl', 'episode', 2019, ['Drama', 'History']],
  ['Heat', 'movie', 1995, ['Crime', 'Thriller']],
  ['Andor', 'episode', 2022, ['Sci-Fi', 'Drama']],
];
const SHOWS: Record<string, string> = {
  'The Bear': 'The Bear',
  Severance: 'Severance',
  Chernobyl: 'Chernobyl',
  Andor: 'Andor',
};
const CLIENTS = ['Jellyfin Web', 'Jellyfin Android TV', 'Infuse', 'Jellyfin iOS'];
const DEVICES = ['Living Room', 'Fire TV', 'iPad', 'Office'];

function startStub() {
  const item = (id: string, name: string, type: string, year: number, genres: string[]) => ({
    Id: id,
    Name: name,
    Type: type,
    ProductionYear: year,
    Genres: genres,
    RunTimeTicks: 36_000_000_000,
    UserData: { LastPlayedDate: new Date().toISOString() },
  });
  const library = TITLES.map(([n, t, y, g], i) =>
    item(`lib-${i}`, n, t === 'movie' ? 'Movie' : 'Series', y, g),
  );
  const routes: Record<string, unknown> = {
    '/System/Info': { ServerName: 'Projection Booth', Version: '10.9.0' },
    '/Users/Me': { Id: 'srv-admin', Name: 'admin', Policy: { IsAdministrator: true } },
    '/Users/AuthenticateByName': {
      User: { Id: 'srv-admin', Name: 'admin', Policy: { IsAdministrator: true } },
      AccessToken: 'user-access-token',
    },
    '/Users': [
      { Id: 'srv-admin', Name: 'admin', Policy: { IsAdministrator: true } },
      { Id: 'srv-mara', Name: 'mara', Policy: { IsAdministrator: false } },
      { Id: 'srv-jonas', Name: 'jonas', Policy: { IsAdministrator: false } },
    ],
    '/Sessions': [
      {
        Id: 'sess-1',
        UserId: 'srv-admin',
        UserName: 'admin',
        DeviceName: 'Living Room',
        PlayState: { PositionTicks: 21_000_000_000, IsPaused: false },
        NowPlayingItem: item('lib-2', 'Dune: Part Two', 'Movie', 2024, ['Sci-Fi', 'Adventure']),
        TranscodingInfo: { Bitrate: 12_000_000 },
      },
      {
        Id: 'sess-2',
        UserId: 'srv-mara',
        UserName: 'mara',
        DeviceName: 'iPad',
        PlayState: { PositionTicks: 4_000_000_000, IsPaused: true },
        NowPlayingItem: item('lib-4', 'Severance', 'Series', 2022, ['Sci-Fi', 'Thriller']),
      },
    ],
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    let body: unknown = routes[path];
    if (body === undefined && path.endsWith('/Items')) {
      body = { Items: path.startsWith('/Users/') ? library.slice(0, 4) : library };
    }
    if (body === undefined && path.includes('/Images/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from([0xff, 0xd8, 0xff]));
      return;
    }
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  });
  server.listen(STUB_PORT);
  return server;
}

/** Deterministic pseudo-randomness, so the preview looks the same on every run. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

async function seed() {
  const { db } = await import('../db');
  const { playbackSessions, users, watchHistory, watchlist } = await import('../db/schema');
  const [admin] = await db.select().from(users);
  if (!admin) throw new Error('login did not create a user');

  const [mara] = await db
    .insert(users)
    .values({ serverUserId: 'srv-mara', username: 'mara' })
    .returning();

  const rand = rng(42);
  const history = [];
  const sessions = [];
  // A year of viewing, denser at weekends and in the evening.
  for (let day = 364; day >= 0; day -= 1) {
    const date = new Date(Date.now() - day * 86_400_000);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const plays = rand() < (weekend ? 0.75 : 0.4) ? 1 + Math.floor(rand() * (weekend ? 3 : 2)) : 0;
    for (let p = 0; p < plays; p += 1) {
      const index = Math.floor(rand() * TITLES.length);
      const [title, type, year, genres] = TITLES[index];
      const at = new Date(date);
      at.setHours(18 + Math.floor(rand() * 5), Math.floor(rand() * 60), 0, 0);
      const durationMs = (type === 'movie' ? 95 : 42) * 60_000;
      const userId = rand() < 0.75 ? admin.id : mara.id;
      history.push({
        userId,
        itemId: `lib-${index}`,
        title: type === 'episode' ? `${title} · S1E${1 + Math.floor(rand() * 9)}` : title,
        grandparentTitle: SHOWS[title],
        mediaType: type,
        year,
        genres,
        watchedAt: at,
        durationMs,
      });
      const ci = Math.floor(rand() * CLIENTS.length);
      const transcoded = rand() < 0.35;
      sessions.push({
        sessionKey: `s-${day}-${p}`,
        userId,
        itemId: `lib-${index}`,
        title,
        grandparentTitle: SHOWS[title],
        mediaType: type,
        state: 'ended',
        progressMs: durationMs,
        durationMs,
        clientName: CLIENTS[ci],
        deviceName: DEVICES[ci],
        playMethod: transcoded ? 'transcode' : 'directplay',
        videoCodec: transcoded ? 'h264' : 'hevc',
        audioCodec: transcoded ? 'aac' : 'eac3',
        container: transcoded ? 'ts' : 'mkv',
        width: transcoded ? 1280 : 1920,
        height: transcoded ? 720 : 1080,
        bitrateKbps: transcoded ? 6000 : 14000,
        transcodeReason: transcoded ? 'VideoCodecNotSupported' : null,
        startedAt: at,
        lastSeenAt: at,
        progressAt: at,
      });
    }
  }
  await db.insert(watchHistory).values(history);
  await db.insert(playbackSessions).values(sessions);
  await db.insert(watchlist).values([
    { userId: admin.id, itemId: 'lib-6', title: 'Heat', mediaType: 'movie', year: 1995 },
    {
      userId: admin.id,
      itemId: 'lib-7',
      title: 'Andor',
      mediaType: 'series',
      year: 2022,
      status: 'watching',
    },
    {
      userId: admin.id,
      itemId: 'lib-1',
      title: 'Arrival',
      mediaType: 'movie',
      year: 2016,
      status: 'done',
    },
  ]);
  console.log(`seeded ${history.length} plays, ${sessions.length} sessions`);
}

async function waitFor(url: string) {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('server did not start');
}

async function main() {
  startStub();
  const app = spawn('node', ['.next/standalone/server.js'], {
    env: { ...process.env, PORT: String(APP_PORT), HOSTNAME: '127.0.0.1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${APP_PORT}`;
  await waitFor(`${base}/api/health`);

  await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverType: 'jellyfin',
      serverUrl: `http://127.0.0.1:${STUB_PORT}`,
      serverToken: 'stub',
    }),
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  await seed();

  console.log(`\nPREVIEW_URL=${base}`);
  console.log(`PREVIEW_COOKIE=${cookie}\n`);
  process.on('SIGINT', () => {
    app.kill();
    process.exit(0);
  });
}

void main();
