import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end smoke test: seeds a database, fakes a Jellyfin server, boots the built app
// and requests every route as a signed-in admin. Catches SQL dialect and render errors
// that a type check cannot see.

const dir = mkdtempSync(join(tmpdir(), 'watcharr-routes-'));
const APP_PORT = 3210;
const STUB_PORT = 39001;

process.env.DATABASE_PATH = join(dir, 'routes.db');
process.env.SESSION_SECRET = 'route-test-secret';
// NODE_ENV is set when spawning the server below, not here.

execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', env: process.env });

/** Minimal Jellyfin API surface used by the adapter. */
function startStubMediaServer() {
  const item = (id: string, name: string, type: string, year: number, genres: string[]) => ({
    Id: id,
    Name: name,
    Type: type,
    ProductionYear: year,
    Genres: genres,
    RunTimeTicks: 36_000_000_000,
    UserData: { LastPlayedDate: new Date().toISOString() },
  });

  const routes: Record<string, unknown> = {
    '/System/Info': { ServerName: 'Stub Jellyfin', Version: '10.9.0' },
    '/Users/Me': { Id: 'srv-admin', Name: 'admin', Policy: { IsAdministrator: true } },
    '/Users/AuthenticateByName': {
      User: { Id: 'srv-admin', Name: 'admin', Policy: { IsAdministrator: true } },
      AccessToken: 'user-access-token',
    },
    '/Users': [{ Id: 'srv-admin', Name: 'admin', Policy: { IsAdministrator: true } }],
    '/Sessions': [
      {
        Id: 'sess-1',
        UserId: 'srv-admin',
        UserName: 'admin',
        DeviceName: 'Living Room',
        PlayState: { PositionTicks: 6_000_000_000, IsPaused: false },
        NowPlayingItem: item('lib-1', 'Blade Runner', 'Movie', 1982, ['Sci-Fi']),
        TranscodingInfo: { Bitrate: 8_000_000 },
      },
    ],
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    let body: unknown = routes[path];
    if (body === undefined && path.endsWith('/Items')) {
      const library = [
        item('lib-1', 'Blade Runner', 'Movie', 1982, ['Sci-Fi']),
        item('lib-2', 'Arrival', 'Movie', 2016, ['Sci-Fi', 'Drama']),
        item('lib-3', 'Firefly', 'Series', 2002, ['Sci-Fi', 'Western']),
      ];
      // /Users/{id}/Items is the history endpoint and only reports what was played.
      body = { Items: path.startsWith('/Users/') ? [library[0]] : library };
    }
    if (body === undefined && path.includes('/Images/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from([0xff, 0xd8, 0xff]));
      return;
    }
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: `stub has no route ${path}` }));
  });
  server.listen(STUB_PORT);
  return server;
}

/** Fills in the data the pages render, for the user that just signed in. */
async function seedContent() {
  const { db } = await import('../db');
  const { playbackSessions, users, watchHistory, watchlist } = await import('../db/schema');

  const [admin] = await db.select().from(users);
  assert.ok(admin, 'login must have created the user row');
  assert.equal(admin.isAdmin, true, 'the media server admin flag must carry over');

  await db.insert(watchHistory).values([
    { userId: admin.id, itemId: 'lib-1', title: 'Blade Runner', mediaType: 'movie', year: 1982, genres: ['Sci-Fi'], watchedAt: new Date(), durationMs: 3_600_000 },
    { userId: admin.id, itemId: 'lib-3', title: 'Serenity', grandparentTitle: 'Firefly', mediaType: 'episode', year: 2002, genres: ['Sci-Fi', 'Western'], watchedAt: new Date(Date.now() - 86400000), durationMs: 2_700_000 },
    // A second episode of the same show: without it the episode list on /title/[label]
    // stays hidden and the per-episode detail page is never exercised.
    { userId: admin.id, itemId: 'lib-4', title: 'The Train Job', grandparentTitle: 'Firefly', mediaType: 'episode', year: 2002, genres: ['Sci-Fi', 'Western'], watchedAt: new Date(Date.now() - 172800000), durationMs: 2_640_000 },
  ]);

  await db.insert(watchlist).values({
    userId: admin.id,
    itemId: 'lib-2',
    title: 'Arrival',
    mediaType: 'movie',
    year: 2016,
  });

  await db.insert(playbackSessions).values([
    {
      sessionKey: 'sess-1',
      userId: admin.id,
      itemId: 'lib-1',
      title: 'Blade Runner',
      mediaType: 'movie',
      state: 'playing',
      progressMs: 600_000,
      durationMs: 3_600_000,
      clientName: 'Jellyfin Web',
      deviceName: 'Living Room',
      playMethod: 'transcode',
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'ts',
      width: 1280,
      height: 720,
      bitrateKbps: 8000,
      transcodeReason: 'VideoCodecNotSupported',
      startedAt: new Date(),
      lastSeenAt: new Date(),
      progressAt: new Date(),
    },
    {
      sessionKey: 'sess-old',
      userId: admin.id,
      itemId: 'lib-3',
      title: 'Serenity',
      grandparentTitle: 'Firefly',
      mediaType: 'episode',
      state: 'ended',
      progressMs: 2_400_000,
      durationMs: 2_700_000,
      clientName: 'Jellyfin Android TV',
      deviceName: 'Fire TV',
      playMethod: 'directplay',
      videoCodec: 'hevc',
      audioCodec: 'eac3',
      container: 'mkv',
      width: 1920,
      height: 1080,
      bitrateKbps: 12000,
      startedAt: new Date(Date.now() - 86400000),
      lastSeenAt: new Date(Date.now() - 86400000),
      progressAt: new Date(Date.now() - 86400000),
    },
  ]);

  return admin.id;
}

async function waitForServer(url: string, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`server did not come up at ${url}`);
}

async function main() {
  const stub = startStubMediaServer();

  const app = spawn('node', ['.next/standalone/server.js'], {
    env: { ...process.env, PORT: String(APP_PORT), HOSTNAME: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  app.stdout.on('data', (d) => logs.push(String(d)));
  app.stderr.on('data', (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${APP_PORT}`;
  let failures = 0;

  try {
    await waitForServer(`${base}/api/health`);

    // A fresh deployment must land on the setup wizard.
    const beforeSetup = await fetch(`${base}/`, { redirect: 'manual' });
    const toSetup = beforeSetup.headers.get('location')?.includes('/setup');
    console.log(`${toSetup ? 'ok  ' : 'FAIL'} - unconfigured / redirects to /setup`);
    if (!toSetup) failures += 1;

    const setup = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverType: 'jellyfin',
        serverUrl: `http://127.0.0.1:${STUB_PORT}`,
        serverToken: 'stub-token',
      }),
    });
    console.log(`${setup.ok ? 'ok  ' : 'FAIL'} - POST /api/setup → ${setup.status}`);
    if (!setup.ok) failures += 1;

    const rerun = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverType: 'plex', serverUrl: 'http://evil', serverToken: 'x' }),
    });
    console.log(`${rerun.status === 409 ? 'ok  ' : 'FAIL'} - setup cannot be run twice → ${rerun.status}`);
    if (rerun.status !== 409) failures += 1;

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    });
    const setCookie = login.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0];
    console.log(`${login.ok && cookie ? 'ok  ' : 'FAIL'} - POST /api/auth/login → ${login.status}`);
    if (!login.ok || !cookie) failures += 1;

    // A Secure cookie is discarded by browsers over plain HTTP, and the app is reached
    // over plain HTTP in most self-hosted setups. Getting this wrong produces a login that
    // answers 200 and then bounces back to /login with no error anywhere — so the flag has
    // to follow the actual scheme. Node's fetch does not enforce Secure, which is exactly
    // why this needs asserting rather than trusting the rest of the suite to notice.
    {
      const plain = !/;\s*Secure/i.test(setCookie);
      console.log(`${plain ? 'ok  ' : 'FAIL'} - session cookie is not Secure over plain HTTP`);
      if (!plain) failures += 1;

      const behindProxy = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
        body: JSON.stringify({ username: 'admin', password: 'secret' }),
      });
      const secure = /;\s*Secure/i.test(behindProxy.headers.get('set-cookie') ?? '');
      console.log(`${secure ? 'ok  ' : 'FAIL'} - session cookie is Secure behind an https proxy`);
      if (!secure) failures += 1;
    }

    const userId = await seedContent();

    const pages = [
      '/',
      '/watchlist',
      '/history',
      '/history?q=blade&type=movie&days=30',
      '/history?page=2',
      '/history?genre=Sci-Fi',
      '/history?weekday=0&hour=12',
      '/history?date=2024-01-01',
      '/activity',
      '/stats',
      '/stats?days=7',
      '/suggestions',
      '/admin/activity',
      '/admin/users',
      `/admin/users/${userId}`,
      '/admin/stats',
      '/admin/stats?days=365',
      '/admin/system',
      '/admin/config',
      '/admin/transcoding',
      '/admin/transcoding?days=all',
      '/admin/clients',
      '/wrapped',
      '/title/Blade%20Runner',
      '/title/Firefly',
      '/title/Firefly?scope=server',
      '/item/lib-1',
      '/item/lib-3',
      '/item/lib-3?scope=server',
      '/api/health',
      '/api/library/search?q=arr',
      '/api/search?q=fire',
      '/api/history/export?type=episode',
      '/api/art/lib-1',
    ];

    for (const path of pages) {
      const res = await fetch(base + path, { headers: { Cookie: cookie }, redirect: 'manual' });
      const ok = res.status < 400;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET ${path} → ${res.status}`);
      if (!ok) failures += 1;
    }

    // The artwork proxy must not let the item id steer the upstream request:
    // dot segments are normalised away by fetch and would otherwise reach arbitrary
    // media server endpoints, with the admin token attached on Plex.
    const rejected = [
      '/api/art/' + encodeURIComponent('../../System/Info?k='),
      '/api/art/' + encodeURIComponent('../../Users'),
      '/api/art/' + encodeURIComponent('lib-1?x=y'),
    ];
    for (const path of rejected) {
      const res = await fetch(base + path, { headers: { Cookie: cookie }, redirect: 'manual' });
      const ok = res.status === 400;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET ${path} rejected → ${res.status}`);
      if (!ok) failures += 1;
    }

    // Unauthenticated callers must not reach the proxy at all.
    {
      const res = await fetch(`${base}/api/art/lib-1`, { redirect: 'manual' });
      const ok = res.status === 401;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET /api/art/lib-1 anonymous → ${res.status}`);
      if (!ok) failures += 1;
    }

    // A 200 alone would not prove the data actually rendered.
    const contentChecks: [string, string[]][] = [
      ['/stats', ['Watch time', 'Sci-Fi', 'Daily activity']],
      ['/watchlist', ['Arrival']],
      ['/history', ['Blade Runner', 'Firefly']],
      ['/admin/users', ['admin']],
      ['/suggestions', ['Arrival']],
      ['/admin/system', ['Stub Jellyfin']],
      ['/stats', ['Busiest day', 'By weekday', 'data-tip']],
      ['/title/Firefly', ['Recent plays', 'Devices', 'Watch time']],
      ['/admin/stats', ['Most watch time', 'Users with plays']],
      ['/admin/transcoding', ['Direct play', 'VideoCodecNotSupported', 'H264', 'TS', '720p']],
      ['/admin/clients', ['Jellyfin Web', 'Jellyfin Android TV', 'Fire TV', 'Clients per user']],
      ['/admin/activity', ['Jellyfin Web', 'Transcode']],
      ['/wrapped', ['Your Year in Review', 'Your year in days', 'Most plays of the year']],
      ['/', ['Now playing', 'Blade Runner', 'scrub-fill', 'Recently watched']],
      ['/stats', ['When you watch', 'Binge record', 'Library explored', 'How your streams were delivered', 'area-line']],
      ['/history', ['Genres', 'Export CSV', 'genre=Sci-Fi']],
      ['/activity', ['Now playing']],
      // Drill-downs: every one of these is a link a reader is told to click.
      ['/title/Firefly', ['Episodes you watched', 'Serenity', 'The Train Job', '/item/lib-3']],
      ['/item/lib-3', ['Every play', 'Firefly', 'Serenity']],
      ['/stats', ['/history?date=', 'weekday=', 'genre=Sci-Fi']],
      ['/wrapped', ['/history?date=']],
      // The deep link out to the media server's own UI.
      ['/suggestions', ['Open in', `127.0.0.1:${STUB_PORT}/web/index.html#/details?id=`]],
      // Mobile chrome and the palette have to be in the markup, not only in CSS.
      ['/', ['bottomnav', 'appbar', 'search-trigger']],
    ];
    for (const [path, needles] of contentChecks) {
      const html = await fetch(base + path, { headers: { Cookie: cookie } }).then((r) => r.text());
      const missing = needles.filter((needle) => !html.includes(needle));
      console.log(`${missing.length === 0 ? 'ok  ' : 'FAIL'} - ${path} renders ${needles.join(', ')}`);
      if (missing.length) {
        failures += 1;
        console.log(`      missing: ${missing.join(', ')}`);
      }
    }

    // Pages that must stay reachable without a session.
    for (const path of ['/login', '/setup']) {
      const res = await fetch(base + path, { redirect: 'manual' });
      const ok = res.status < 400;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET ${path} (anonymous) → ${res.status}`);
      if (!ok) failures += 1;
    }

    // Watchlist mutations.
    const add = await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'lib-3', title: 'Firefly', mediaType: 'series', year: 2002 }),
    });
    const patch = await fetch(`${base}/api/watchlist`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'lib-3', status: 'watching' }),
    });
    const del = await fetch(`${base}/api/watchlist?itemId=lib-3`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    for (const [label, res] of [['POST', add], ['PATCH', patch], ['DELETE', del]] as const) {
      const ok = res.ok;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - ${label} /api/watchlist → ${res.status}`);
      if (!ok) failures += 1;
    }

    // Unauthenticated access must not leak admin data.
    // A title without any recorded play must 404 rather than render an empty page.
    const missing = await fetch(`${base}/title/Nope`, { headers: { Cookie: cookie } });
    console.log(`${missing.status === 404 ? 'ok  ' : 'FAIL'} - unknown title → ${missing.status}`);
    if (missing.status !== 404) failures += 1;

    // notFound() is reachable from four routes; it must render this app's 404,
    // not the stock Next.js one.
    const nf = await fetch(`${base}/title/Does%20Not%20Exist`, { headers: { Cookie: cookie } });
    const nfBody = await nf.text();
    const styled404 = nf.status === 404 && nfBody.includes('Nothing here');
    console.log(`${styled404 ? 'ok  ' : 'FAIL'} - 404 renders the app's own screen`);
    if (!styled404) failures += 1;

    // Same trap as /title: /item calls notFound(), so it must not gain a loading.tsx.
    const missingItem = await fetch(`${base}/item/nope-404`, { headers: { Cookie: cookie } });
    console.log(`${missingItem.status === 404 ? 'ok  ' : 'FAIL'} - unknown item → ${missingItem.status}`);
    if (missingItem.status !== 404) failures += 1;

    // The export is the only route that answers with something other than HTML or JSON.
    const csv = await fetch(`${base}/api/history/export`, { headers: { Cookie: cookie } });
    const csvBody = await csv.text();
    const csvOk =
      csv.headers.get('content-type')?.startsWith('text/csv') === true &&
      csvBody.startsWith('Watched,Title,Episode') &&
      csvBody.includes('Blade Runner');
    console.log(`${csvOk ? 'ok  ' : 'FAIL'} - /api/history/export returns CSV`);
    if (!csvOk) failures += 1;

    // The palette is useless if it cannot find a title the user has actually watched.
    const search = await fetch(`${base}/api/search?q=fire`, { headers: { Cookie: cookie } });
    const searchBody = (await search.json()) as { results: { label: string }[] };
    const foundFirefly = searchBody.results.some((r) => r.label === 'Firefly');
    console.log(`${foundFirefly ? 'ok  ' : 'FAIL'} - /api/search finds a watched title`);
    if (!foundFirefly) failures += 1;

    for (const path of ['/api/search?q=fire', '/api/history/export']) {
      const res = await fetch(base + path, { redirect: 'manual' });
      const ok = res.status === 401;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET ${path} anonymous → ${res.status}`);
      if (!ok) failures += 1;
    }

    const guarded = await fetch(`${base}/admin/users`, { redirect: 'manual' });
    const redirected = guarded.status === 307 || guarded.status === 302 || guarded.status >= 400;
    console.log(`${redirected ? 'ok  ' : 'FAIL'} - /admin/users without session → ${guarded.status}`);
    if (!redirected) failures += 1;

    const serverErrors = logs.join('').match(/SqliteError|Error:/g) ?? [];
    console.log(`${serverErrors.length === 0 ? 'ok  ' : 'FAIL'} - no server side errors logged`);
    if (serverErrors.length) {
      failures += 1;
      console.log(logs.join('').slice(-3000));
    }
  } finally {
    // Wait for the child to exit: on Windows it still holds the SQLite file
    // (and its WAL sidecars) until then, which makes the cleanup below fail.
    const exited = once(app, 'exit');
    app.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    stub.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (err) {
      // A leftover temp directory must not turn a passing run into a failure.
      console.log(`warn - could not remove ${dir}: ${(err as Error).message}`);
    }
  }

  assert.equal(failures, 0, `${failures} route checks failed`);
  console.log('all route checks passed');
  process.exit(0);
}

void main();
