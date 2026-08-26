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
const STUB2_PORT = 39002;

process.env.DATABASE_PATH = join(dir, 'routes.db');
process.env.SESSION_SECRET = 'route-test-secret';
// NODE_ENV is set when spawning the server below, not here.

execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', env: process.env });

/** Minimal Jellyfin API surface used by the adapter. */
function startStubMediaServer(port = STUB_PORT, serverName = 'Stub Jellyfin', userId = 'srv-admin') {
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
    '/System/Info': { ServerName: serverName, Version: '10.9.0' },
    '/Users/Me': { Id: userId, Name: 'admin', Policy: { IsAdministrator: true } },
    '/Users/AuthenticateByName': {
      User: { Id: userId, Name: 'admin', Policy: { IsAdministrator: true } },
      AccessToken: 'user-access-token',
    },
    '/Users': [{ Id: userId, Name: 'admin', Policy: { IsAdministrator: true } }],
    '/Library/VirtualFolders': [
      { Name: 'Movies', ItemId: 'lib-movies', CollectionType: 'movies' },
      { Name: 'Shows', ItemId: 'lib-shows', CollectionType: 'tvshows' },
    ],
    '/Sessions': [
      {
        Id: 'sess-1',
        UserId: userId,
        UserName: 'admin',
        DeviceName: 'Living Room',
        RemoteEndPoint: '192.168.1.20:47204',
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
      const items = path.startsWith('/Users/') ? [library[0]] : library;
      // TotalRecordCount is what the library listing reads; Limit=0 returns only the count.
      body = { Items: (req.url ?? '').includes('Limit=0') ? [] : items, TotalRecordCount: items.length };
    }
    if (body === undefined && path.includes('/Images/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from([0xff, 0xd8, 0xff]));
      return;
    }
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: `stub has no route ${path}` }));
  });
  server.listen(port);
  return server;
}

/** Fills in the data the pages render, for the user that just signed in. */
async function seedContent() {
  const { db } = await import('../db');
  const { playbackSessions, users, watchHistory, watchlist } = await import('../db/schema');
  const { updateSettings } = await import('../server/config');

  // The suite must not reach out to GitHub. This also exercises the disabled branch of the
  // update check, which is what a deployment without outbound access sees.
  await updateSettings({ features: { updateCheck: false } });

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
      sessionKey: '1:sess-1',
      remoteAddress: '192.168.1.20',
      isLocal: true,
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
      sessionKey: '1:sess-old',
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
  // A second server, so "one server's data must not leak into another" is a real check.
  const stub2 = startStubMediaServer(STUB2_PORT, 'Stub Two', 'srv-two');

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
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    console.log(`${login.ok && cookie ? 'ok  ' : 'FAIL'} - POST /api/auth/login → ${login.status}`);
    if (!login.ok || !cookie) failures += 1;

    const userId = await seedContent();

    // Multi-server. The first sign-in claims the global admin role, so this account may
    // add the second server; everything below then checks the boundary between the two.
    {
      const addServer = (body: unknown, cookieHeader?: string) =>
        fetch(`${base}/api/admin/servers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          body: JSON.stringify(body),
        });

      const anonymous = await addServer({
        serverType: 'jellyfin',
        serverUrl: `http://127.0.0.1:${STUB2_PORT}`,
        serverToken: 'stub-token',
        label: 'Stub Two',
      });
      const anonymousOk = anonymous.status === 403;
      console.log(`${anonymousOk ? 'ok  ' : 'FAIL'} - add server anonymous → ${anonymous.status}`);
      if (!anonymousOk) failures += 1;

      const added = await addServer(
        {
          serverType: 'jellyfin',
          serverUrl: `http://127.0.0.1:${STUB2_PORT}`,
          serverToken: 'stub-token',
          label: 'Stub Two',
        },
        cookie,
      );
      const addedBody = (await added.json()) as { slug?: string };
      const addedOk = added.ok && addedBody.slug === 'stub-two';
      console.log(`${addedOk ? 'ok  ' : 'FAIL'} - add second server → ${added.status} ${addedBody.slug}`);
      if (!addedOk) failures += 1;

      // An unreachable server must be refused rather than stored and broken later.
      const dead = await addServer(
        {
          serverType: 'jellyfin',
          serverUrl: 'http://127.0.0.1:39999',
          serverToken: 'x',
          label: 'Dead',
        },
        cookie,
      );
      const deadOk = dead.status === 400;
      console.log(`${deadOk ? 'ok  ' : 'FAIL'} - unreachable server refused → ${dead.status}`);
      if (!deadOk) failures += 1;

      // With two servers the login screen has to offer a choice.
      const picker = await fetch(`${base}/login`);
      const pickerHtml = await picker.text();
      const pickerOk = pickerHtml.includes('Stub Two') && pickerHtml.includes('server=stub-jellyfin');
      console.log(`${pickerOk ? 'ok  ' : 'FAIL'} - login offers a server choice`);
      if (!pickerOk) failures += 1;

      // Artwork is per server: a slug must never reach a different server's API.
      const otherArt = await fetch(`${base}/api/art/stub-two/lib-1`, { headers: { Cookie: cookie } });
      const otherArtOk = otherArt.ok;
      console.log(`${otherArtOk ? 'ok  ' : 'FAIL'} - artwork resolves per server → ${otherArt.status}`);
      if (!otherArtOk) failures += 1;

      // Signing in on the second server must create a separate account, not reuse the
      // first one — the same media server user id can exist on both.
      const second = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'secret', serverId: 2 }),
      });
      const secondCookie = (second.headers.get('set-cookie') ?? '').split(';')[0];
      const { db } = await import('../db');
      const { users } = await import('../db/schema');
      const rows = await db.select().from(users);
      const separate = rows.length === 2 && rows.filter((u) => u.globalAdmin).length === 1;
      console.log(`${separate ? 'ok  ' : 'FAIL'} - second server creates its own account`);
      if (!separate) failures += 1;

      // The second account is an admin on its own server but not globally, so it must not
      // be able to touch server management.
      const notGlobal = await addServer(
        { serverType: 'jellyfin', serverUrl: `http://127.0.0.1:${STUB_PORT}`, serverToken: 'x' },
        secondCookie,
      );
      const notGlobalOk = notGlobal.status === 403;
      console.log(`${notGlobalOk ? 'ok  ' : 'FAIL'} - server admin cannot add servers → ${notGlobal.status}`);
      if (!notGlobalOk) failures += 1;

      // A server admin must not see accounts belonging to another server, and must not
      // be able to open one by guessing the id.
      const userList = await fetch(`${base}/admin/users`, { headers: { Cookie: secondCookie } });
      const userListHtml = await userList.text();
      // Checked by the link to the foreign account rather than by a column heading: the
      // client dictionary ships every UI string in the page payload, so searching the HTML
      // for a piece of interface text now finds it whether or not it was rendered.
      const listScoped = !userListHtml.includes('/admin/users/1"');
      console.log(`${listScoped ? 'ok  ' : 'FAIL'} - user list hides the other server's accounts`);
      if (!listScoped) failures += 1;

      const foreign = await fetch(`${base}/admin/users/1`, {
        headers: { Cookie: secondCookie },
        redirect: 'manual',
      });
      const foreignOk = foreign.status === 404;
      console.log(`${foreignOk ? 'ok  ' : 'FAIL'} - foreign user detail → ${foreign.status}`);
      if (!foreignOk) failures += 1;

      // Only a global admin may hand out the role, and never the last one.
      const grant = (cookieHeader: string, body: unknown) =>
        fetch(`${base}/api/admin/users/role`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
          body: JSON.stringify(body),
        });

      const notAllowed = await grant(secondCookie, { userId: 2, globalAdmin: true });
      const notAllowedOk = notAllowed.status === 403;
      console.log(`${notAllowedOk ? 'ok  ' : 'FAIL'} - server admin cannot grant → ${notAllowed.status}`);
      if (!notAllowedOk) failures += 1;

      const lastOne = await grant(cookie, { userId: 1, globalAdmin: false });
      const lastOneOk = lastOne.status === 400;
      console.log(`${lastOneOk ? 'ok  ' : 'FAIL'} - last global admin cannot step down → ${lastOne.status}`);
      if (!lastOneOk) failures += 1;

      const granted = await grant(cookie, { userId: 2, globalAdmin: true });
      const revoked = granted.ok && (await grant(cookie, { userId: 2, globalAdmin: false })).ok;
      console.log(`${revoked ? 'ok  ' : 'FAIL'} - a global admin can grant and revoke the role`);
      if (!revoked) failures += 1;

      // …and must not see the first server's plays in the server-wide statistics.
      const scoped = await fetch(`${base}/admin/stats`, { headers: { Cookie: secondCookie } });
      const scopedHtml = await scoped.text();
      const isolated = !scopedHtml.includes('Blade Runner');
      console.log(`${isolated ? 'ok  ' : 'FAIL'} - server admin does not see the other server`);
      if (!isolated) failures += 1;
    }

    const pages = [
      '/',
      '/watchlist',
      '/history',
      '/history?q=blade&type=movie&days=30',
      '/history?page=2',
      '/history?genre=Sci-Fi',
      '/history?weekday=0&hour=12',
      '/history?date=2024-01-01',
      '/sessions',
      '/?days=7&by=time',
      '/activity',
      '/stats',
      '/stats?days=7',
      '/stats?days=30&by=time',
      '/libraries',
      '/libraries?sort=duration&dir=asc',
      '/libraries?q=movies',
      '/suggestions',
      '/admin/activity',
      '/admin/users',
      `/admin/users/${userId}`,
      // Each tab runs its own queries, so one URL per tab is one code path per tab.
      `/admin/users/${userId}?tab=stats`,
      `/admin/users/${userId}?tab=history`,
      `/admin/users/${userId}?tab=streams`,
      `/admin/users/${userId}?tab=devices`,
      `/admin/users/${userId}?tab=sessions`,
      '/admin/stats',
      '/admin/stats?days=365',
      '/admin/stats?days=30&by=time',
      '/admin/graphs',
      '/admin/graphs?days=365',
      '/admin/streams',
      '/admin/streams?days=30&transcodes=1',
      '/admin/system',
      '/admin/config',
      '/admin/notifications',
      '/admin/newsletter',
      '/admin/security',
      '/profile',
      '/profile?tab=newsletter',
      '/profile?tab=sessions',
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
      '/api/admin/streams/export?days=30',
      '/api/library/export',
      '/api/art/stub-jellyfin/lib-1',
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
      '/api/art/stub-jellyfin/' + encodeURIComponent('../../System/Info?k='),
      '/api/art/stub-jellyfin/' + encodeURIComponent('../../Users'),
      '/api/art/stub-jellyfin/' + encodeURIComponent('lib-1?x=y'),
      // A slug that resolves to no server must not fall back to "the" server.
      '/api/art/no-such-server/lib-1',
      '/api/art/' + encodeURIComponent('../stub-jellyfin') + '/lib-1',
    ];
    for (const path of rejected) {
      const res = await fetch(base + path, { headers: { Cookie: cookie }, redirect: 'manual' });
      const ok = res.status === 400;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET ${path} rejected → ${res.status}`);
      if (!ok) failures += 1;
    }

    // Unauthenticated callers must not reach the proxy at all.
    {
      const res = await fetch(`${base}/api/art/stub-jellyfin/lib-1`, { redirect: 'manual' });
      const ok = res.status === 401;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET /api/art anonymous → ${res.status}`);
      if (!ok) failures += 1;
    }

    // Terminating a stream is the one destructive action in the app.
    {
      const terminate = (init: RequestInit) =>
        fetch(`${base}/api/admin/sessions/terminate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...init,
        });

      const anonymous = await terminate({ body: JSON.stringify({ sessionKey: '1:sess-1' }) });
      const anonymousOk = anonymous.status === 403;
      console.log(`${anonymousOk ? 'ok  ' : 'FAIL'} - POST terminate anonymous → ${anonymous.status}`);
      if (!anonymousOk) failures += 1;

      const missing = await terminate({
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({}),
      });
      const missingOk = missing.status === 400;
      console.log(`${missingOk ? 'ok  ' : 'FAIL'} - POST terminate without a key → ${missing.status}`);
      if (!missingOk) failures += 1;

      // A stored session key that is not currently live must not be terminable.
      const stale = await terminate({
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ sessionKey: '1:not-a-live-session' }),
      });
      const staleOk = stale.status === 404;
      console.log(`${staleOk ? 'ok  ' : 'FAIL'} - POST terminate for a dead session → ${stale.status}`);
      if (!staleOk) failures += 1;
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
      ['/admin/stats', ['Top lists', 'By watch time', 'Users with plays', 'Clients']],
      ['/admin/stats?by=time', ['Top lists', 'Titles', 'Genres']],
      ['/stats?by=time', ['Top lists', 'By plays']],
      ['/admin/system', ['Watcharr version', 'update check disabled']],
      ['/admin/transcoding', ['Direct play', 'VideoCodecNotSupported', 'H264', 'TS', '720p']],
      ['/admin/clients', ['Jellyfin Web', 'Jellyfin Android TV', 'Fire TV', 'Clients per user']],
      ['/admin/activity', ['Jellyfin Web', 'Transcode', 'Streams per hour', 'Bandwidth per hour']],
      ['/wrapped', ['Your Year in Review', 'Your year in days', 'Most plays of the year']],
      ['/sessions', ['Now playing', 'Blade Runner', 'scrub-fill', 'Recently watched']],
      // The dashboard: server-wide tiles, library sizes and the newest arrivals.
      ['/', ['Most watched movies', 'Most popular TV shows', 'Most active platforms']],
      ['/', ['Library statistics', 'Recently added', 'added-strip']],
      ['/', ['Blade Runner', 'Firefly']],
      ['/stats', ['When you watch', 'Binge record', 'Library explored', 'How your streams were delivered', 'area-line']],
      ['/history', ['Genres', 'Export CSV', 'genre=Sci-Fi']],
      ['/activity', ['Now playing']],
      // The library list is a table now: one row per library with its counts and usage.
      ['/libraries', ['Last streamed', 'Watch time', 'Never started', 'sort=plays']],
      ['/libraries', ['Movies', 'Shows']],
      // LAN/WAN needs no lookup and no key, so it has to show up unconditionally.
      ['/admin/activity', ['Remote streams', 'LAN']],
      // Drill-downs: every one of these is a link a reader is told to click.
      ['/title/Firefly', ['Episodes you watched', 'Serenity', 'The Train Job', '/item/lib-3']],
      ['/item/lib-3', ['Every play', 'Firefly', 'Serenity']],
      ['/stats', ['/history?date=', 'weekday=', 'genre=Sci-Fi']],
      ['/wrapped', ['/history?date=']],
      // The deep link out to the media server's own UI.
      ['/suggestions', ['Open in', `127.0.0.1:${STUB_PORT}/web/index.html#/details?id=`]],
      // Mobile chrome and the palette have to be in the markup, not only in CSS.
      ['/', ['bottomnav', 'appbar', 'search-trigger']],
      // Tautulli parity: the graphs and the stream history behind them.
      ['/admin/graphs', ['Daily play count', 'Plays by hour of day', 'Plays by platform']],
      ['/admin/graphs', ['How streams were delivered', 'Direct play', 'Transcode', 'LAN']],
      ['/admin/streams', ['Player', 'Delivery', 'Transcodes only', 'Jellyfin Web']],
      // Both halves of a transcode, which is the whole point of the source columns.
      ['/admin/streams', ['HEVC 1080p', 'H264 720p']],
      ['/api/admin/streams/export', ['Source video', 'Transcode reason']],
      ['/api/library/export', ['File size (MB)', 'Last played']],
      // Tabs are URLs, so each one has to render its own content.
      [`/admin/users/${userId}?tab=streams`, ['How streams were delivered']],
      [`/admin/users/${userId}?tab=devices`, ['Players', 'Addresses']],
      ['/profile', ['Language']],
      // The field name is what the settings API reads, so a rename here breaks the toggle
      // silently — the dictionary in the payload makes label text useless as a check.
      ['/admin/config', ['monitorNewAddressAlert']],
      // An episode is reachable from the lists, not only from its show.
      ['/history', ['/item/lib-3']],
      ['/sessions', ['/item/lib-3']],
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

    // The language is a database column, so switching it has to change what the server
    // renders — not merely what a cookie says. Switched back afterwards so the checks
    // above stay valid whichever order anything runs in.
    {
      const setLocale = (locale: string | null) =>
        fetch(`${base}/api/profile/locale`, {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        });

      await setLocale('de-DE');
      const german = await fetch(`${base}/history`, { headers: { Cookie: cookie } }).then((r) =>
        r.text(),
      );
      const germanOk =
        german.includes('lang="de-DE"') && german.includes('Verlauf') && !german.includes('>History<');
      console.log(`${germanOk ? 'ok  ' : 'FAIL'} - /history renders in German after the switch`);
      if (!germanOk) failures += 1;

      await setLocale(null);
      const english = await fetch(`${base}/history`, { headers: { Cookie: cookie } }).then((r) =>
        r.text(),
      );
      const englishOk = english.includes('lang="en-US"') && english.includes('Export CSV');
      console.log(`${englishOk ? 'ok  ' : 'FAIL'} - /history falls back to the default locale`);
      if (!englishOk) failures += 1;
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
    stub2.close();
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
