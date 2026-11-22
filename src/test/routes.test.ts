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

  // A second, ordinary account whose policy shares only the movie library: what a person
  // without admin rights may see is checked against it.
  const viewerId = `${userId}-viewer`;
  const viewer = { Id: viewerId, Name: 'viewer', Policy: { IsAdministrator: false } };
  // Quick Connect answers "not yet" once, then "approved": the login page has to poll.
  let quickConnectPolls = 0;

  const routes: Record<string, unknown> = {
    '/System/Info': { ServerName: serverName, Version: '10.9.0' },
    '/Users/Me': { Id: userId, Name: 'admin', Policy: { IsAdministrator: true } },
    '/Users/AuthenticateByName': {
      User: { Id: userId, Name: 'admin', Policy: { IsAdministrator: true } },
      AccessToken: 'user-access-token',
    },
    '/Users': [{ Id: userId, Name: 'admin', Policy: { IsAdministrator: true } }],
    // What getUserSectionIds() reads: the policy, and the views as its fallback.
    [`/Users/${userId}`]: { Id: userId, Name: 'admin', Policy: { IsAdministrator: true, EnableAllFolders: true, EnabledFolders: [] } },
    [`/Users/${viewerId}`]: {
      ...viewer,
      Policy: { IsAdministrator: false, EnableAllFolders: false, EnabledFolders: ['lib-movies'] },
    },
    [`/Users/${userId}/Views`]: {
      Items: [
        { Id: 'lib-movies', Name: 'Movies', CollectionType: 'movies' },
        { Id: 'lib-shows', Name: 'Shows', CollectionType: 'tvshows' },
      ],
    },
    // Quick Connect, already authorized: initiate, poll once, sign in as the admin.
    '/QuickConnect/Enabled': true,
    '/QuickConnect/Initiate': { Secret: 'stub-qc-secret', Code: '424242', Authenticated: false },
    '/Users/AuthenticateWithQuickConnect': {
      User: { Id: userId, Name: 'admin', Policy: { IsAdministrator: true } },
      AccessToken: 'user-access-token',
    },
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

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    let request = '';
    for await (const chunk of req) request += chunk;
    let body: unknown = routes[path];
    if (path === '/Users/AuthenticateByName' && (JSON.parse(request || '{}') as { Username?: string }).Username === 'viewer') {
      body = { User: viewer, AccessToken: 'viewer-access-token' };
    }
    if (path === '/QuickConnect/Connect') {
      quickConnectPolls += 1;
      body = { Secret: 'stub-qc-secret', Code: '424242', Authenticated: quickConnectPolls > 1 };
    }
    if (body === undefined && path.endsWith('/Items')) {
      const library = [
        item('lib-1', 'Blade Runner', 'Movie', 1982, ['Sci-Fi']),
        item('lib-2', 'Arrival', 'Movie', 2016, ['Sci-Fi', 'Drama']),
        item('lib-3', 'Firefly', 'Series', 2002, ['Sci-Fi', 'Western']),
      ];
      // Each library lists its own titles, so a library someone may not open is a real set
      // of titles that must stay out of their pages.
      const parent = new URL(req.url ?? '', 'http://stub').searchParams.get('ParentId');
      const inLibrary = parent === 'lib-movies' ? library.slice(0, 2) : parent === 'lib-shows' ? library.slice(2) : library;
      // /Users/{id}/Items is the history endpoint and only reports what was played.
      const items = path.startsWith('/Users/') ? [library[0]] : inLibrary;
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

/**
 * The Plex watchlist in both directions, in this process against a faked plex.tv: the stub above
 * is a Jellyfin, and a real Plex sign-in needs plex.tv. Runs after the app has exited, on the same
 * database file. Returns the number of failed checks.
 *
 * The route is called directly; next/headers is replaced by a cookie jar, which is all getSession()
 * and createSession() need from a request.
 */
async function watchlistPushChecks(): Promise<number> {
  const Module = require('node:module') as { _load: (request: string, ...rest: unknown[]) => unknown };
  const jar = new Map<string, string>();
  const load = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'next/headers') {
      return {
        cookies: async () => ({
          get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
          set: (name: string, value: string) => void jar.set(name, value),
          delete: (name: string) => void jar.delete(name),
        }),
        headers: async () => new Headers(),
      };
    }
    return load.call(this, request, ...rest);
  };

  const calls: { method: string; url: string; token: string | null }[] = [];
  let watchlistReply: unknown[] = [];
  // Per plex.tv token, for the background round: a list, or how plex.tv answers instead.
  const watchlistOf = new Map<string, unknown[] | 'refused' | 'unreachable'>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get('X-Plex-Token');
    calls.push({ method: init?.method ?? 'GET', url: url.href, token });
    if (url.host === 'plex-push.test:32400' && url.pathname === '/library/metadata/123') {
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: '123', title: 'Heat', type: 'movie', guid: 'plex://movie/5d776825880197001ec967c6' }] } });
    }
    // The read before the writes: both go to discover.provider.plex.tv.
    if (url.pathname.endsWith('/library/sections/watchlist/all')) {
      const own = watchlistOf.get(token ?? '');
      if (own === 'refused') return new Response('Unauthorized', { status: 401 });
      if (own === 'unreachable') throw new TypeError('fetch failed');
      return Response.json({ MediaContainer: { Metadata: own ?? watchlistReply } });
    }
    if (url.host === 'discover.provider.plex.tv') return new Response(null, { status: 200 });
    return new Response('not faked', { status: 404 });
  }) as typeof fetch;

  let failures = 0;
  const report = (label: string, ok: boolean) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} - watchlist sync: ${label}`);
    if (!ok) failures += 1;
  };
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 50 && !until(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  try {
    const { and, eq, inArray } = await import('drizzle-orm');
    const { db } = await import('../db');
    const { appConfig, watchlist } = await import('../db/schema');
    const { encryptSecret } = await import('../server/crypto');
    const { updateSettings } = await import('../server/config');
    const { createSession, getSession } = await import('../server/session');
    const { syncWatchlist } = await import('../server/sync');
    const route = await import('../app/api/watchlist/route');

    const [server] = await db
      .insert(appConfig)
      .values({ serverType: 'plex', serverUrl: 'http://plex-push.test:32400', serverToken: encryptSecret('admin-token'), label: 'Plex Push', slug: 'plex-push' })
      .returning();
    const user = await createSession(server.id, { serverUserId: 'plex-friend', username: 'friend', isAdmin: false }, 'friend-plex-tv-token');
    const json = { 'Content-Type': 'application/json' };
    const add = (itemId: string, title: string) =>
      route.POST(new Request('http://app/api/watchlist', { method: 'POST', headers: json, body: JSON.stringify({ itemId, title, mediaType: 'movie', year: 1995 }) }));
    const puts = () => calls.filter((c) => c.method === 'PUT');

    const added = await add('123', 'Heat');
    await settle(() => puts().length > 0);
    report(
      'adding sends the title to plex.tv with the person\'s own token',
      added.ok && puts().length === 1 &&
        puts()[0].url === 'https://discover.provider.plex.tv/actions/addToWatchlist?ratingKey=5d776825880197001ec967c6' &&
        puts()[0].token === 'friend-plex-tv-token',
    );

    // Back from plex.tv under its global id: the same title, so no second row.
    watchlistReply = [
      { ratingKey: '5d776825880197001ec967c6', title: 'Heat', type: 'movie', year: 1995 },
      { ratingKey: '5d77000000000000000000aa', title: 'Ronin', type: 'movie', year: 1998 },
    ];
    await syncWatchlist((await getSession())!);
    const rows = await db.select().from(watchlist).where(eq(watchlist.userId, user.id));
    report(
      'a pushed title comes back from plex.tv without a duplicate',
      rows.length === 2 && rows.filter((r) => r.title === 'Heat').length === 1 && rows.some((r) => r.title === 'Ronin' && r.source === 'plex'),
    );
    report(
      'the watchlist is read from discover.provider.plex.tv with the person\'s own token',
      calls.some((c) => c.url.startsWith('https://discover.provider.plex.tv/library/sections/watchlist/all?') && c.token === 'friend-plex-tv-token'),
    );

    calls.length = 0;
    const removed = await route.DELETE(new Request('http://app/api/watchlist?itemId=123', { method: 'DELETE' }));
    await settle(() => puts().length > 0);
    report('removing takes it off plex.tv too', removed.ok && puts().some((c) => c.url.includes('/actions/removeFromWatchlist?ratingKey=5d776825880197001ec967c6')));

    // The background round: everybody whose plex.tv token is kept, not only whoever opens a page.
    // Rows written straight away, so the cookie jar keeps the friend's session.
    {
      const { authSessions, plexTokens, users } = await import('../db/schema');
      const { sessionHandle } = await import('../server/session');
      const { syncStoredWatchlists } = await import('../server/sync');
      const keptFor = async (userId: number) =>
        (await db.select().from(plexTokens).where(eq(plexTokens.userId, userId))).length;
      report('a Plex sign-in keeps the plex.tv token beyond the session', (await keptFor(user.id)) === 1);

      const kept = async (name: string, ageMs: number) => {
        const [person] = await db.insert(users).values({ serverId: server.id, serverUserId: `plex-${name}`, username: name }).returning();
        await db.insert(plexTokens).values({
          userId: person.id,
          token: encryptSecret(`${name}-plex-tv-token`),
          updatedAt: new Date(Date.now() - ageMs),
        });
        return person;
      };
      const rowsOf = async (userId: number) => db.select().from(watchlist).where(eq(watchlist.userId, userId));

      // Most recently kept first: the refused token is asked before the neighbor's.
      const neighbor = await kept('neighbor', 60_000);
      const refused = await kept('refused', 30_000);
      // Signed in as well: a refused token in the background must not end that session.
      await db.insert(authSessions).values({
        id: sessionHandle('refused-cookie'),
        userId: refused.id,
        serverToken: encryptSecret('refused-plex-tv-token'),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      watchlistOf.set('neighbor-plex-tv-token', [{ ratingKey: '5d77000000000000000000bb', title: 'Thief', type: 'movie', year: 1981 }]);
      watchlistOf.set('refused-plex-tv-token', 'refused');
      calls.length = 0;
      await syncStoredWatchlists();
      const mirrored = await rowsOf(neighbor.id);
      report(
        'the background round mirrors somebody without any session',
        mirrored.length === 1 && mirrored[0].title === 'Thief' && mirrored[0].source === 'plex',
      );
      const sessionsLeft = (await db.select().from(authSessions).where(eq(authSessions.userId, refused.id))).length;
      report('a token plex.tv refuses is forgotten, its owner stays signed in', (await keptFor(refused.id)) === 0 && sessionsLeft === 1);
      report('whoever synced a moment ago is not asked again', !calls.some((c) => c.token === 'friend-plex-tv-token'));

      // plex.tv unreachable for the most recent one: the round ends there.
      const later = await kept('later', 20_000);
      const unreachable = await kept('unreachable', 10_000);
      watchlistOf.set('later-plex-tv-token', [{ ratingKey: '5d77000000000000000000cc', title: 'Manhunter', type: 'movie', year: 1986 }]);
      watchlistOf.set('unreachable-plex-tv-token', 'unreachable');
      calls.length = 0;
      await syncStoredWatchlists();
      report(
        'an unreachable plex.tv ends the round instead of being asked for everybody',
        calls.some((c) => c.token === 'unreachable-plex-tv-token') &&
          !calls.some((c) => c.token === 'later-plex-tv-token') &&
          (await rowsOf(later.id)).length === 0 &&
          (await keptFor(unreachable.id)) === 1,
      );
      // Their tokens, sessions and rows go with them (cascade), so the checks after this see the friend only.
      await db.delete(users).where(inArray(users.id, [neighbor.id, refused.id, later.id, unreachable.id]));
    }

    // Switched off, the lists stay separate.
    await updateSettings({ features: { watchlistSync: false } });
    calls.length = 0;
    const quiet = await add('124', 'Collateral');
    await new Promise((resolve) => setTimeout(resolve, 200));
    report('with the watchlist sync off nothing is sent', quiet.ok && calls.length === 0);
    await db.delete(watchlist).where(and(eq(watchlist.userId, user.id)));
  } catch (error) {
    console.log(`FAIL - watchlist sync checks threw: ${(error as Error).stack ?? error}`);
    failures += 1;
  } finally {
    globalThis.fetch = realFetch;
    Module._load = load;
  }
  return failures;
}

/**
 * The read-only watchlist against a faked Plex server, in this process like the check above
 * (the HTTP stub is a Jellyfin). A row pulled from plex.tv carries plex.tv's global id; a tool
 * working on the server only knows ratingKeys, so it must come out under the library's key.
 * Returns the number of failed checks.
 */
async function watchlistApiPlexChecks(): Promise<number> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.host !== 'plex-api.test:32400') return new Response('not faked', { status: 404 });
    if (url.pathname === '/') {
      return Response.json({ MediaContainer: { machineIdentifier: 'plex-api-machine', friendlyName: 'Plex API', version: '1.42.0' } });
    }
    if (url.pathname === '/library/sections') {
      return Response.json({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }] } });
    }
    if (url.pathname === '/library/sections/1/all') {
      return Response.json({
        MediaContainer: {
          Metadata: [
            { ratingKey: '456', title: 'Ronin', type: 'movie', year: 1998, guid: 'plex://movie/5d77000000000000000000aa' },
            { ratingKey: '789', title: 'Le Samouraï', type: 'movie', year: 1967, guid: 'com.plexapp.agents.imdb://tt0062229?lang=en' },
          ],
        },
      });
    }
    return new Response('not faked', { status: 404 });
  }) as typeof fetch;

  let failures = 0;
  const report = (label: string, ok: boolean) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} - /api/v1/watchlist on Plex: ${label}`);
    if (!ok) failures += 1;
  };

  try {
    const { db } = await import('../db');
    const { appConfig, users, watchlist } = await import('../db/schema');
    const { encryptSecret } = await import('../server/crypto');
    const { rotateApiKey, updateSettings } = await import('../server/config');
    const route = await import('../app/api/v1/watchlist/route');

    const [server] = await db
      .insert(appConfig)
      .values({ serverType: 'plex', serverUrl: 'http://plex-api.test:32400', serverToken: encryptSecret('admin-token'), label: 'Plex API', slug: 'plex-api' })
      .returning();
    const [anna] = await db.insert(users).values({ serverId: server.id, serverUserId: 'plex-api-anna', username: 'anna' }).returning();
    await db.insert(watchlist).values([
      { userId: anna.id, itemId: '5d77000000000000000000aa', title: 'Ronin', mediaType: 'movie', year: 1998, source: 'plex' },
      { userId: anna.id, itemId: '5d7700000000000000000bbb', title: 'Le Samouraï', mediaType: 'movie', year: 1967, source: 'plex' },
      { userId: anna.id, itemId: '5d7700000000000000000ddd', title: 'Thief', mediaType: 'movie', year: 1981, source: 'plex' },
      { userId: anna.id, itemId: '123', title: 'Heat', mediaType: 'movie', year: 1995 },
    ]);

    const key = await rotateApiKey();
    const res = await route.GET(new Request('http://app/api/v1/watchlist?server=plex-api', { headers: { 'x-api-key': key } }));
    const body = (await res.json()) as { items: { itemId: string; title: string; source: string; server: { type: string; machineIdentifier: string | null } }[] };
    const byTitle = new Map(body.items.map((item) => [item.title, item]));
    report('a title from plex.tv comes out under the library ratingKey', byTitle.get('Ronin')?.itemId === '456');
    report('a legacy-agent item is found by its title', byTitle.get('Le Samouraï')?.itemId === '789');
    report('a title the library does not have keeps its plex.tv id', byTitle.get('Thief')?.itemId === '5d7700000000000000000ddd');
    report('a local key stays as it is', byTitle.get('Heat')?.itemId === '123' && byTitle.get('Heat')?.source === 'local');
    report(
      "carries the server's machineIdentifier",
      body.items.length === 4 && body.items.every((item) => item.server.type === 'plex' && item.server.machineIdentifier === 'plex-api-machine'),
    );
    await updateSettings({ apiKey: null });
  } catch (error) {
    console.log(`FAIL - watchlist API checks threw: ${(error as Error).stack ?? error}`);
    failures += 1;
  } finally {
    globalThis.fetch = realFetch;
  }
  return failures;
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

    // Setup needs the one-time token from the log: without it, a stranger could claim a fresh instance.
    const noToken = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverType: 'jellyfin', serverUrl: `http://127.0.0.1:${STUB_PORT}`, serverToken: 'stub-token' }),
    });
    console.log(`${noToken.status === 401 ? 'ok  ' : 'FAIL'} - setup without the log token is refused → ${noToken.status}`);
    if (noToken.status !== 401) failures += 1;
    const printed = logs.join('').match(/setup token:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];

    const setup = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverType: 'jellyfin',
        serverUrl: `http://127.0.0.1:${STUB_PORT}`,
        serverToken: 'stub-token',
        setupToken: printed,
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

    // No admin exists yet, so a wrong setup token must stop the sign-in.
    const badToken = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret', setupToken: 'ZZZZ-ZZZZ' }),
    });
    console.log(`${badToken.status === 401 && !badToken.headers.get('set-cookie') ? 'ok  ' : 'FAIL'} - a wrong setup token refuses the sign-in → ${badToken.status}`);
    if (badToken.status !== 401) failures += 1;

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    console.log(`${login.ok && cookie ? 'ok  ' : 'FAIL'} - POST /api/auth/login → ${login.status}`);
    if (!login.ok || !cookie) failures += 1;

    const userId = await seedContent();

    // Admin access without the media server: the code only ever appears in the log, works
    // once, and signs in as the existing global admin.
    {
      const page = await fetch(`${base}/adminlogin`);
      console.log(`${page.ok ? 'ok  ' : 'FAIL'} - GET /adminlogin anonymous → ${page.status}`);
      if (!page.ok) failures += 1;

      const redeem = (code: string) =>
        fetch(`${base}/api/auth/admin-recovery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
      const guessed = await redeem('AAAAA-AAAAA-AAAAA-AAAAA');
      const guessedOk = guessed.status === 401 && !guessed.headers.get('set-cookie');
      console.log(`${guessedOk ? 'ok  ' : 'FAIL'} - a code nobody requested signs no one in → ${guessed.status}`);
      if (!guessedOk) failures += 1;

      const asked = await fetch(`${base}/api/auth/admin-recovery/request`, { method: 'POST' });
      const code = logs.join('').match(/adminlogin\?token=([A-Z0-9]{20})/g)?.pop()?.split('=')[1] ?? '';
      console.log(`${asked.ok && code ? 'ok  ' : 'FAIL'} - the requested code is printed to the log → ${asked.status}`);
      if (!asked.ok || !code) failures += 1;

      const used = await redeem(code);
      const recoveryCookie = (used.headers.get('set-cookie') ?? '').split(';')[0];
      const adminPage = await fetch(`${base}/admin/servers`, { headers: { Cookie: recoveryCookie }, redirect: 'manual' });
      const usedOk = used.ok && !!recoveryCookie && adminPage.status === 200;
      console.log(`${usedOk ? 'ok  ' : 'FAIL'} - the code signs in as the global admin → ${used.status}, /admin/servers ${adminPage.status}`);
      if (!usedOk) failures += 1;

      const again = await redeem(code);
      console.log(`${again.status === 401 ? 'ok  ' : 'FAIL'} - a code works only once → ${again.status}`);
      if (again.status !== 401) failures += 1;
    }

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

      // Looked up, not assumed to be 2: every sign-in is an upsert, and SQLite's AUTOINCREMENT
      // spends an id on an upsert that only updates (the /adminlogin check above signs in again).
      const secondId = rows.find((u) => u.serverId !== rows.find((r) => r.globalAdmin)?.serverId)?.id ?? -1;
      const granted = await grant(cookie, { userId: secondId, globalAdmin: true });
      const revoked = granted.ok && (await grant(cookie, { userId: secondId, globalAdmin: false })).ok;
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
      '/history?days=1e9',
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
      '/admin/import',
      '/admin/backups',
      '/admin/caches',
      '/admin/doctor',
      '/admin/security',
      '/profile',
      '/profile?tab=sessions',
      '/notifications',
      '/admin/transcoding',
      '/admin/transcoding?days=all',
      '/admin/clients',
      '/wrapped',
      '/wrapped/story',
      '/pick',
      '/pick?type=movie&length=quick',
      '/screen',
      '/screen/me',
      '/screen/server',
      '/wrapped?view=server',
      '/wrapped/story?view=server',
      '/stats?days=7',
      '/admin/stats?days=365',
      '/api/wrapped/card',
      '/title/Blade%20Runner',
      '/title/Firefly',
      '/title/Firefly?scope=server',
      '/item/lib-1',
      '/item/lib-3',
      '/item/lib-3?scope=server',
      '/api/health',
      '/api/health?live=1',
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

    // Library shares. "viewer" is no admin, and the stub's policy shares only the movie
    // library with them: the show library, its titles and its artwork must not reach them
    // anywhere — not as a page, not in a file, not in a search.
    {
      const signIn = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'viewer', password: 'secret', serverId: 1 }),
      });
      const viewerCookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0];
      const get = (path: string) => fetch(base + path, { headers: { Cookie: viewerCookie }, redirect: 'manual' });
      const [shows, movies, list, exported, exportedShows, found, foundShow, palette, art, ownArt, hiddenTitle, shownTitle, home] =
        await Promise.all([
          get('/libraries/lib-shows'),
          get('/libraries/lib-movies'),
          get('/libraries').then((r) => r.text()),
          get('/api/library/export').then((r) => r.text()),
          get('/api/library/export?sectionId=lib-shows').then((r) => r.text()),
          get('/api/library/search?q=arr').then((r) => r.json() as Promise<{ items: { title: string }[] }>),
          get('/api/library/search?q=fire').then((r) => r.json() as Promise<{ items: { title: string }[] }>),
          get('/api/search?q=fire').then((r) => r.json() as Promise<{ results: { label: string }[] }>),
          get('/api/art/stub-jellyfin/lib-3'),
          get('/api/art/stub-jellyfin/lib-1'),
          get('/title/Firefly'),
          get('/title/Arrival'),
          get('/').then((r) => r.text()),
        ]);
      const checks: [string, boolean][] = [
        ['viewer signs in', signIn.ok && !!viewerCookie],
        [`a library that is not shared → 404 (${shows.status})`, shows.status === 404],
        [`a shared library opens (${movies.status})`, movies.status === 200],
        ['the library table lists only the shared library', list.includes('/libraries/lib-movies') && !list.includes('/libraries/lib-shows')],
        ['the CSV export holds no title of the hidden library', exported.includes('Arrival') && !exported.includes('Firefly')],
        ['exporting the hidden library by id yields nothing', !exportedShows.includes('Firefly')],
        ['library search finds shared titles', found.items.some((i) => i.title === 'Arrival')],
        ['library search hides the rest', foundShow.items.length === 0],
        ['the palette offers no hidden title', !palette.results.some((r) => r.label === 'Firefly')],
        [`artwork of a hidden title → 403 (${art.status})`, art.status === 403],
        [`artwork of a shared title (${ownArt.status})`, ownArt.status === 200],
        [`an unwatched hidden title is a 404 (${hiddenTitle.status})`, hiddenTitle.status === 404],
        [`an unwatched shared title has its page (${shownTitle.status})`, shownTitle.status === 200],
        ['the dashboard names only the shared library', home.includes('/libraries/lib-movies') && !home.includes('/libraries/lib-shows') && !home.includes('Firefly')],
      ];
      for (const [label, ok] of checks) {
        console.log(`${ok ? 'ok  ' : 'FAIL'} - library shares: ${label}`);
        if (!ok) failures += 1;
      }
    }

    // Jellyfin Quick Connect: the code is shown, polled until approved, then signs in like a
    // password would. The secret stays on the server, and only the browser that started the
    // request may collect it.
    {
      const loginPage = await fetch(`${base}/login?server=stub-jellyfin`).then((r) => r.text());
      const offered = loginPage.includes('qc-divider');
      console.log(`${offered ? 'ok  ' : 'FAIL'} - the login page offers Quick Connect where Jellyfin has it on`);
      if (!offered) failures += 1;

      const start = await fetch(`${base}/api/auth/quickconnect/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: 1 }),
      });
      const started = (await start.json()) as Record<string, unknown>;
      const binding = (start.headers.get('set-cookie') ?? '').split(';')[0];
      const startOk =
        start.ok && started.code === '424242' && typeof started.expiresAt === 'number' &&
        binding.startsWith('watcharr_quickconnect=') && !JSON.stringify(started).includes('stub-qc-secret');
      console.log(`${startOk ? 'ok  ' : 'FAIL'} - Quick Connect start: code, expiry, bound to the browser, no secret → ${start.status}`);
      if (!startOk) failures += 1;

      const check = (cookieHeader?: string) =>
        fetch(`${base}/api/auth/quickconnect/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
          body: '{}',
        });
      const stranger = await check();
      const forged = await check('watcharr_quickconnect=guessed.0000000000000000000000000000000000000000000000000000000000000000');
      const strangerOk = stranger.status === 400 && forged.status === 400 && !stranger.headers.get('set-cookie')?.includes('watcharr_session');
      console.log(`${strangerOk ? 'ok  ' : 'FAIL'} - another browser cannot poll the sign-in → ${stranger.status}/${forged.status}`);
      if (!strangerOk) failures += 1;

      const first = await check(binding);
      const firstBody = (await first.json()) as { pending?: boolean };
      console.log(`${first.ok && firstBody.pending ? 'ok  ' : 'FAIL'} - Quick Connect is pending until approved → ${first.status}`);
      if (!first.ok || !firstBody.pending) failures += 1;

      const second = await check(binding);
      const secondBody = (await second.json()) as { ok?: boolean };
      const session = second.headers.getSetCookie().find((c) => c.startsWith('watcharr_session='))?.split(';')[0] ?? '';
      const cleared = second.headers.getSetCookie().some((c) => c.startsWith('watcharr_quickconnect=;') || /^watcharr_quickconnect=(;|$)/.test(c));
      const signedIn = session ? (await fetch(`${base}/watchlist`, { headers: { Cookie: session }, redirect: 'manual' })).status : 0;
      const approvedOk = second.ok && secondBody.ok === true && !!session && cleared && signedIn === 200;
      console.log(`${approvedOk ? 'ok  ' : 'FAIL'} - an approved code signs in and the binding is cleared → ${second.status}, /watchlist ${signedIn}`);
      if (!approvedOk) failures += 1;

      const reused = await check(binding);
      console.log(`${reused.status === 410 ? 'ok  ' : 'FAIL'} - a redeemed request cannot sign in twice → ${reused.status}`);
      if (reused.status !== 410) failures += 1;

      const cancel = await fetch(`${base}/api/auth/quickconnect`, { method: 'DELETE' });
      console.log(`${cancel.ok ? 'ok  ' : 'FAIL'} - cancelling a sign-in → ${cancel.status}`);
      if (!cancel.ok) failures += 1;
    }

    // The healthcheck endpoint tells a stranger only whether the app is up; the detail
    // (server names, versions) is for signed-in admins.
    {
      const anonymous = (await fetch(`${base}/api/health`).then((r) => r.json())) as Record<string, unknown>;
      const admin = (await fetch(`${base}/api/health`, { headers: { Cookie: cookie } }).then((r) => r.json())) as {
        mediaServers?: unknown[];
      };
      const ok =
        JSON.stringify(Object.keys(anonymous)) === '["ok"]' && Array.isArray(admin.mediaServers);
      console.log(`${ok ? 'ok  ' : 'FAIL'} - /api/health detail is for admins only`);
      if (!ok) failures += 1;
    }

    // The backup is streamed from a temporary copy; what arrives must be a whole SQLite file.
    {
      const res = await fetch(`${base}/api/admin/backup`, { headers: { Cookie: cookie } });
      const bytes = Buffer.from(await res.arrayBuffer());
      const ok =
        res.status === 200 &&
        bytes.subarray(0, 15).toString() === 'SQLite format 3' &&
        // Next drops Content-Length from route handler responses (16.4.1 and later), so "whole"
        // is read from the file itself: page size times page count, both in the SQLite header.
        (bytes.readUInt16BE(16) === 1 ? 65536 : bytes.readUInt16BE(16)) * bytes.readUInt32BE(28) === bytes.length;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET /api/admin/backup streams a SQLite file → ${res.status}, ${bytes.length} bytes`);
      if (!ok) failures += 1;
    }

    // Confirmation mails go to addresses the caller picks, so they are capped per account.
    {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await fetch(`${base}/api/newsletter`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ email: `stranger${i}@example.org` }),
        });
        statuses.push(res.status);
      }
      const ok = statuses.slice(0, 5).every((status) => status !== 429) && statuses[5] === 429;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - confirmation mails are rate limited per account → ${statuses.join(', ')}`);
      if (!ok) failures += 1;
    }

    // "Sync users" goes through the roster: a second run finds everybody and creates nobody.
    {
      const sync = () => fetch(`${base}/api/admin/users/sync`, { method: 'POST', headers: { Cookie: cookie } });
      const first = await sync();
      const second = await sync();
      const again = second.status === 200 ? ((await second.json()) as { imported?: number }).imported : null;
      const ok = first.status === 200 && again === 0;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - syncing users twice creates no duplicates → ${first.status}, ${again}`);
      if (!ok) failures += 1;
    }

    // Ops endpoints: stored backups download whole, names cannot leave the folder, and an
    // admin can preview another user read-only and leave again.
    {
      const make = await fetch(`${base}/api/admin/backups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ action: 'create' }),
      });
      const created = (await make.json()) as { backup?: { name: string } };
      const stored = created.backup
        ? await fetch(`${base}/api/admin/backup?name=${encodeURIComponent(created.backup.name)}`, { headers: { Cookie: cookie } })
        : null;
      const stolen = await fetch(`${base}/api/admin/backup?name=..%2Froutes.db`, { headers: { Cookie: cookie } });
      const anonymousCaches = await fetch(`${base}/api/admin/caches`);
      const caches = await fetch(`${base}/api/admin/caches`, { headers: { Cookie: cookie } });
      const ok =
        make.status === 200 &&
        stored?.status === 200 &&
        Buffer.from(await stored.arrayBuffer()).subarray(0, 15).toString() === 'SQLite format 3' &&
        stolen.status === 404 &&
        anonymousCaches.status === 403 &&
        caches.status === 200;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - backups: create, download by name, no path escape, caches are admin-only`);
      if (!ok) failures += 1;
    }

    {
      const { db } = await import('../db');
      const { users } = await import('../db/schema');
      const [viewee] = await db.insert(users).values({ serverId: 1, serverUserId: 'viewee', username: 'viewee' }).returning();
      const json = { 'Content-Type': 'application/json', Cookie: cookie };
      const start = await fetch(`${base}/api/admin/view-as`, { method: 'POST', headers: json, body: JSON.stringify({ userId: viewee.id }) });
      const viewCookie = `${cookie}; ${(start.headers.get('set-cookie') ?? '').split(';')[0]}`;
      const page = await fetch(`${base}/`, { headers: { Cookie: viewCookie } }).then((r) => r.text());
      const write = await fetch(`${base}/api/watchlist`, { method: 'POST', headers: { ...json, Cookie: viewCookie }, body: '{}' });
      const adminPage = await fetch(`${base}/admin/users`, { headers: { Cookie: viewCookie }, redirect: 'manual' });
      const self = await fetch(`${base}/api/admin/view-as`, { method: 'POST', headers: json, body: JSON.stringify({ userId: 0 }) });
      const leave = await fetch(`${base}/api/admin/view-as`, { method: 'DELETE', headers: { ...json, Cookie: viewCookie } });
      const after = await fetch(`${base}/`, { headers: { Cookie: cookie } }).then((r) => r.text());
      const ok =
        start.status === 200 &&
        page.includes('preview-pill') && page.includes('viewee') &&
        write.status === 403 &&
        adminPage.status >= 300 && adminPage.status < 400 && // viewee is no admin: the admin pages are gone
        self.status === 404 &&
        leave.status === 200 &&
        !after.includes('preview-pill');
      console.log(`${ok ? 'ok  ' : 'FAIL'} - admin preview: banner, read-only, no admin pages, exit (${start.status}/${write.status}/${adminPage.status}/${self.status})`);
      if (!ok) failures += 1;
    }

    // Custom badges are global-admin work and show up on the profile shelf; deleting a person
    // takes the data with it, but never an admin, yourself, or someone out of reach.
    {
      const { db } = await import('../db');
      const { users, watchHistory, playbackSessions } = await import('../db/schema');
      const json = { 'Content-Type': 'application/json', Cookie: cookie };
      const badge = await fetch(`${base}/api/admin/badges`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'Scary Night', description: 'Horror after dark', icon: '\u{1F47B}', metric: 'plays', filter: 'genre', filterValue: 'Horror', tiers: '1, 5' }),
      });
      const rejected = await fetch(`${base}/api/admin/badges`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'x', metric: 'plays', tiers: 'nope' }) });
      const page = await fetch(`${base}/admin/badges`, { headers: { Cookie: cookie } }).then((r) => r.text());
      const profile = await fetch(`${base}/profile`, { headers: { Cookie: cookie } }).then((r) => r.text());
      const created = (await badge.json()) as { id?: number };
      const edited = await fetch(`${base}/api/admin/badges`, {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ id: created.id, name: 'Scary Dawn', description: '', icon: '\u{1F47B}', metric: 'hours', filter: 'none', filterValue: '', tiers: '2, 8' }),
      });
      const editedPage = await fetch(`${base}/admin/badges?edit=${created.id}`, { headers: { Cookie: cookie } }).then((r) => r.text());
      const editMissing = await fetch(`${base}/api/admin/badges`, { method: 'PATCH', headers: json, body: JSON.stringify({ id: 999999, name: 'x', metric: 'plays', tiers: '1' }) });
      const removeBadge = await fetch(`${base}/api/admin/badges`, { method: 'DELETE', headers: json, body: JSON.stringify({ id: created.id }) });
      const anonymousBadge = await fetch(`${base}/api/admin/badges`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

      const [gone] = await db.insert(users).values({ serverId: 1, serverUserId: 'gone', username: 'gone-user' }).returning();
      await db.insert(watchHistory).values({ userId: gone.id, itemId: 'x', title: 'X', mediaType: 'movie', watchedAt: new Date(), durationMs: 1000 });
      await db.insert(playbackSessions).values({ sessionKey: '1:gone', userId: gone.id, itemId: 'x', title: 'X', mediaType: 'movie', state: 'ended', startedAt: new Date(), lastSeenAt: new Date() });
      const [adminRow] = await db.select().from(users).where((await import('drizzle-orm')).eq(users.globalAdmin, true));
      const self = await fetch(`${base}/api/admin/users/delete`, { method: 'POST', headers: json, body: JSON.stringify({ userId: adminRow.id }) });
      const removed = await fetch(`${base}/api/admin/users/delete`, { method: 'POST', headers: json, body: JSON.stringify({ userId: gone.id }) });
      const again = await fetch(`${base}/api/admin/users/delete`, { method: 'POST', headers: json, body: JSON.stringify({ userId: gone.id }) });
      const left = await db.select().from(watchHistory).where((await import('drizzle-orm')).eq(watchHistory.userId, gone.id));
      const streams = await db.select().from(playbackSessions).where((await import('drizzle-orm')).eq(playbackSessions.sessionKey, '1:gone'));
      const ok =
        badge.status === 200 && rejected.status === 400 && anonymousBadge.status === 403 && removeBadge.status === 200 &&
        page.includes('Scary Night') && profile.includes('Level') &&
        edited.status === 200 && editedPage.includes('Scary Dawn') && editedPage.includes('2, 8') && editMissing.status === 404 &&
        self.status === 400 && removed.status === 200 && again.status === 404 && left.length === 0 && streams.length === 0;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - custom badges + deleting a person (${badge.status}/${rejected.status}/${self.status}/${removed.status}/${again.status}, ${left.length}+${streams.length} left)`);
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
      // The reason is matched as a rendered bar label: the raw token also sits in the
      // dictionary payload of every page, so its mere presence proves nothing.
      ['/admin/transcoding', ['Direct play', 'class="bar-label">Video codec not supported<', 'H264', 'TS', '720p']],
      // Per user and per device are tabs now; the device names live behind the second one.
      ['/admin/clients', ['Jellyfin Web', 'Jellyfin Android TV', 'Clients per user']],
      ['/admin/clients?tab=device', ['Fire TV', 'Clients per device']],
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
      // The pages added with the redesign: each has to render its own markup, not only answer 200.
      ['/pick', ['Pick something for me', 'pick-stage']],
      ['/wrapped/story', ['Your year, as a story']],
      ['/screen', ['Lobby display']],
      ['/screen/me', ['Lobby display']],
      // The server's year: its own heading, the switch back, and the people ranking.
      ['/wrapped?view=server', ['the year in review', 'view=server', 'Who watched most']],
      ['/', ['skip-link', 'live-pill']],
      // The deep link out to the media server's own UI.
      ['/suggestions', ['Open in', `127.0.0.1:${STUB_PORT}/web/index.html#/details?id=`]],
      // Mobile chrome and the palette have to be in the markup, not only in CSS.
      ['/', ['bottomnav', 'appbar', 'search-trigger']],
      // Tautulli parity: the graphs and the stream history behind them.
      ['/admin/graphs', ['Daily play count', 'Plays by hour of day', 'Plays by platform']],
      ['/admin/graphs', ['How streams were delivered', 'Direct play', 'Transcode', 'LAN']],
      ['/admin/streams', ['Player', 'Delivery', 'Transcodes only', 'Jellyfin Web']],
      // Newsletter libraries are keyed by server, so two servers cannot share a checkbox.
      ['/admin/newsletter', ['name="library.1:lib-movies"']],
      // Both halves of a transcode, which is the whole point of the source columns.
      ['/admin/streams', ['HEVC 1080p', 'H264 720p']],
      ['/api/admin/streams/export', ['Source video', 'Transcode reason']],
      ['/api/library/export', ['File size (MB)', 'Last played']],
      // Tabs are URLs, so each one has to render its own content.
      [`/admin/users/${userId}?tab=streams`, ['How streams were delivered']],
      [`/admin/users/${userId}?tab=devices`, ['Players', 'Addresses']],
      ['/profile', ['Language']],
      // The event checkboxes are named after the keys the API reads back, so a rename
      // there breaks saving silently — the dictionary in the payload makes labels useless.
      ['/notifications', ['event.playback.start', 'name="email"']],
      // The field name is what the settings API reads, so a rename here breaks the toggle
      // silently — the dictionary in the payload makes label text useless as a check.
      ['/admin/config', ['monitorNewAddressAlert']],
      // The library condition is only worth anything if the form offers real libraries:
      // the value is the section key the matcher compares against, not a display name.
      ['/admin/notifications', ['condition.libraries', 'value="1:lib-movies"', 'Movies']],
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

    // Period filters are one-tap segment links, not a select with an apply button.
    {
      const html = await fetch(`${base}/admin/stats?days=7`, { headers: { Cookie: cookie } }).then((r) => r.text());
      const ok = !html.includes('<select name="days"') && /<a [^>]*href="\/admin\/stats\?days=30&amp;by=[a-z]+"/.test(html) &&
        /<a [^>]*class="on"[^>]*aria-current="true"[^>]*>|<a [^>]*aria-current="true"[^>]*class="on"/.test(html);
      console.log(`${ok ? 'ok  ' : 'FAIL'} - /admin/stats?days=7 offers segment links, no <select name="days">`);
      if (!ok) failures += 1;
    }

    // A page number that is no number, or past the end, is clamped rather than an error or an
    // empty page.
    {
      const clamped = [
        '/admin/clients?tab=device&page=abc',
        '/watchlist?page=99',
        '/admin/security?page=2',
        '/admin/notifications?page=2',
        '/admin/newsletter?page=2',
        '/profile?tab=sessions&page=99',
      ];
      for (const path of clamped) {
        const res = await fetch(base + path, { headers: { Cookie: cookie }, redirect: 'manual' });
        const ok = res.status === 200;
        console.log(`${ok ? 'ok  ' : 'FAIL'} - GET ${path} (page clamped) → ${res.status}`);
        if (!ok) failures += 1;
      }
      // Clamped to the last page, so the one watchlist entry is still on it.
      const last = await fetch(`${base}/watchlist?page=99`, { headers: { Cookie: cookie } }).then((r) => r.text());
      console.log(`${last.includes('Arrival') ? 'ok  ' : 'FAIL'} - /watchlist?page=99 shows the last page`);
      if (!last.includes('Arrival')) failures += 1;
    }

    // The own devices tab lists the players from this person's streams.
    {
      const html = await fetch(`${base}/profile?tab=devices`, { headers: { Cookie: cookie } }).then((r) => r.text());
      const ok = html.includes('<td>Fire TV</td>') && html.includes('<td>Jellyfin Android TV</td>');
      console.log(`${ok ? 'ok  ' : 'FAIL'} - /profile?tab=devices renders the devices`);
      if (!ok) failures += 1;
    }

    // The admin navigation opens the group of the page you are on and keeps the others closed.
    {
      const html = await fetch(`${base}/admin/stats`, { headers: { Cookie: cookie } }).then((r) => r.text());
      const heads = html.match(/<button[^>]*class="nav-group-head[^"]*"[^>]*>/g) ?? [];
      const current = heads.filter((tag) => /class="nav-group-head current"/.test(tag));
      const others = heads.filter((tag) => !/class="nav-group-head current"/.test(tag));
      const ok =
        current.length > 0 && others.length > 0 &&
        current.every((tag) => tag.includes('aria-expanded="true"')) &&
        others.every((tag) => tag.includes('aria-expanded="false"'));
      console.log(`${ok ? 'ok  ' : 'FAIL'} - admin nav: the page's group is expanded, the others are not (${current.length}/${others.length})`);
      if (!ok) failures += 1;
    }

    // The colour scheme is stored per account and rendered on <html> by the server.
    {
      const setTheme = (theme: unknown, cookieHeader?: string) =>
        fetch(`${base}/api/profile/theme`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
          body: JSON.stringify({ theme }),
        });
      const htmlTag = async () =>
        (await fetch(`${base}/watchlist`, { headers: { Cookie: cookie } }).then((r) => r.text())).match(/<html[^>]*>/)?.[0] ?? '';
      const light = await setTheme('light', cookie);
      const lightTag = await htmlTag();
      const system = await setTheme('system', cookie);
      const systemTag = await htmlTag();
      const invalid = await setTheme('purple', cookie);
      const anonymous = await setTheme('light');
      const ok =
        light.status === 200 && lightTag.includes('data-theme="light"') &&
        system.status === 200 && !systemTag.includes('data-theme=') &&
        invalid.status === 400 && anonymous.status === 401;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - POST /api/profile/theme: light/system/invalid/anonymous → ${light.status}/${system.status}/${invalid.status}/${anonymous.status}`);
      if (!ok) failures += 1;
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

      // API errors follow the same setting: German text, the code unchanged.
      const refused = await fetch(`${base}/api/watchlist`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const refusedBody = (await refused.json()) as { error?: string; code?: string };
      const errorOk =
        refused.status === 400 && refusedBody.code === 'missing-fields' &&
        refusedBody.error === 'Die Angaben „itemId“ und „title“ werden benötigt.';
      console.log(`${errorOk ? 'ok  ' : 'FAIL'} - a 4xx answers in German with a code → ${refused.status} ${refusedBody.code}: ${refusedBody.error}`);
      if (!errorOk) failures += 1;

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

    // The redesign's pages are behind the session like every other page. The manifest and
    // the icons are the exception: a browser fetches them without any cookie.
    for (const path of ['/pick', '/screen', '/wrapped/story']) {
      const res = await fetch(base + path, { redirect: 'manual' });
      const ok = res.status === 307;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET ${path} anonymous → ${res.status}`);
      if (!ok) failures += 1;
    }
    for (const path of ['/manifest.webmanifest', '/icon/any-192', '/apple-icon']) {
      const res = await fetch(base + path, { redirect: 'manual' });
      const ok = res.status === 200;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET ${path} (anonymous) → ${res.status}`);
      if (!ok) failures += 1;
    }
    {
      const res = await fetch(`${base}/api/wrapped/card`, { redirect: 'manual' });
      const ok = res.status === 401;
      console.log(`${ok ? 'ok  ' : 'FAIL'} - GET /api/wrapped/card anonymous → ${res.status}`);
      if (!ok) failures += 1;
    }

    // The share card is the one CPU-heavy endpoint: a signed-in person gets a handful per
    // minute, then 429, so a loop in a browser tab cannot pin a core.
    {
      const codes: number[] = [];
      for (let i = 0; i < 9; i++) {
        codes.push((await fetch(`${base}/api/wrapped/card`, { headers: { Cookie: cookie } })).status);
      }
      const ok = codes[0] === 200 && codes.includes(429);
      console.log(`${ok ? 'ok  ' : 'FAIL'} - /api/wrapped/card is rate limited → ${codes.join(',')}`);
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

    // The proxy refuses a write that a browser marks as cross-site, even with a valid session,
    // and lets the same page's own writes through.
    {
      const attempt = (headers: Record<string, string>) =>
        fetch(`${base}/api/watchlist?itemId=lib-3`, { method: 'DELETE', headers: { Cookie: cookie, ...headers } });
      const evil = await attempt({ Origin: 'http://evil.example' });
      const crossSite = await attempt({ 'Sec-Fetch-Site': 'cross-site' });
      const same = await attempt({ Origin: base, 'Sec-Fetch-Site': 'same-origin' });
      const ok = evil.status === 403 && crossSite.status === 403 && same.status === 200;
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} - cross-site writes are refused, same-origin ones pass → ${evil.status}/${crossSite.status}/${same.status}`,
      );
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

    // A period that is not one of the offered ones means "all time", not an empty list.
    const wild = await fetch(`${base}/api/history/export?days=1e9`, { headers: { Cookie: cookie } });
    const wildOk = (await wild.text()).includes('Blade Runner');
    console.log(`${wildOk ? 'ok  ' : 'FAIL'} - /api/history/export?days=1e9 falls back to all time`);
    if (!wildOk) failures += 1;

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

    // The public API is the one part of this app a stranger can reach without a session,
    // so the checks are: closed until a key exists, closed to the wrong key, and open to
    // the right one — in that order, because the first two are what protect the third.
    {
      for (const path of ['/api/v1/activity', '/api/v1/stats', '/api/v1/history', '/api/v1/watchlist']) {
        const off = await fetch(base + path);
        const ok = off.status === 403;
        console.log(`${ok ? 'ok  ' : 'FAIL'} - GET ${path} without a key configured → ${off.status}`);
        if (!ok) failures += 1;
      }

      const issued = await fetch(`${base}/api/admin/apikey`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      const { key } = (await issued.json()) as { key?: string };
      console.log(`${key ? 'ok  ' : 'FAIL'} - a global admin can issue an API key`);
      if (!key) failures += 1;

      const wrong = await fetch(`${base}/api/v1/activity`, { headers: { 'x-api-key': 'nope' } });
      console.log(`${wrong.status === 401 ? 'ok  ' : 'FAIL'} - a wrong key → ${wrong.status}`);
      if (wrong.status !== 401) failures += 1;

      const activity = await fetch(`${base}/api/v1/activity`, {
        headers: { 'x-api-key': key ?? '' },
      });
      const body = (await activity.json()) as {
        streamCount?: number;
        sessions?: { title: string }[];
      };
      const served =
        activity.status === 200 && (body.sessions ?? []).some((s) => s.title === 'Blade Runner');
      console.log(`${served ? 'ok  ' : 'FAIL'} - /api/v1/activity serves the live session`);
      if (!served) failures += 1;

      // Also accepted in the query string, because some dashboards can only be given a URL.
      const viaQuery = await fetch(`${base}/api/v1/stats?apikey=${encodeURIComponent(key ?? '')}`);
      const stats = (await viaQuery.json()) as { totals?: { plays?: number } };
      const statsOk = viaQuery.status === 200 && (stats.totals?.plays ?? 0) > 0;
      console.log(`${statsOk ? 'ok  ' : 'FAIL'} - /api/v1/stats accepts the key as a parameter`);
      if (!statsOk) failures += 1;

      // The watchlist, for a tool that must leave alone what somebody still wants to watch.
      {
        const json = { Cookie: cookie, 'Content-Type': 'application/json' };
        const add = (itemId: string, title: string, year: number) =>
          fetch(`${base}/api/watchlist`, { method: 'POST', headers: json, body: JSON.stringify({ itemId, title, mediaType: 'movie', year }) });
        await add('wl-planned', 'Arrival', 2016);
        await add('wl-done', 'Sicario', 2015);
        await fetch(`${base}/api/watchlist`, { method: 'PATCH', headers: json, body: JSON.stringify({ itemId: 'wl-done', status: 'done' }) });

        type Listed = { count: number; items: { itemId: string; year: unknown; addedAt: unknown; server: Record<string, unknown> }[] };
        const listed = async (query = '') => {
          const res = await fetch(`${base}/api/v1/watchlist${query}`, { headers: { 'x-api-key': key ?? '' } });
          const body = (await res.json()) as Listed;
          return { res, body, ids: body.items.map((item) => item.itemId) };
        };
        const check = (label: string, ok: boolean) => {
          console.log(`${ok ? 'ok  ' : 'FAIL'} - /api/v1/watchlist ${label}`);
          if (!ok) failures += 1;
        };

        const anonymous = await fetch(`${base}/api/v1/watchlist`);
        check(`without a key → ${anonymous.status}`, anonymous.status === 401);

        const plain = await listed();
        const mine = plain.body.items.find((item) => item.itemId === 'wl-planned');
        check(
          'lists planned and watching by default, not done',
          plain.res.status === 200 && plain.body.count === plain.body.items.length && plain.ids.includes('wl-planned') && !plain.ids.includes('wl-done'),
        );
        check('is never cached', plain.res.headers.get('cache-control') === 'no-store');
        check(
          'answers with the agreed fields and nothing else',
          !!mine &&
            Object.keys(mine).sort().join() === 'addedAt,itemId,mediaType,server,source,status,title,user,year' &&
            Object.keys(mine.server).sort().join() === 'label,machineIdentifier,slug,type' &&
            mine.server.type === 'jellyfin' && mine.server.machineIdentifier === null &&
            mine.year === 2016 && typeof mine.addedAt === 'string' && !Number.isNaN(Date.parse(String(mine.addedAt))),
        );

        const all = await listed('?status=planned,watching,done');
        check(
          '?status= widens it, newest first',
          all.ids.includes('wl-planned') && all.ids.includes('wl-done') && all.ids.indexOf('wl-done') < all.ids.indexOf('wl-planned'),
        );
        const bogus = await listed('?status=bogus');
        check('an unknown status falls back to the default', bogus.ids.includes('wl-planned') && !bogus.ids.includes('wl-done'));

        const slug = String(mine?.server.slug ?? '');
        const narrowed = [
          ['?user=admin', true],
          ['?user=nobody', false],
          [`?server=${encodeURIComponent(slug)}`, true],
          ['?server=no-such-server', false],
          ['?type=movie,bogus', true],
          ['?type=show', false],
        ] as const;
        for (const [query, expected] of narrowed) {
          const { ids } = await listed(query);
          check(`${query} ${expected ? 'keeps' : 'drops'} the entry`, ids.includes('wl-planned') === expected);
        }

        for (const itemId of ['wl-planned', 'wl-done']) {
          await fetch(`${base}/api/watchlist?itemId=${itemId}`, { method: 'DELETE', headers: { Cookie: cookie } });
        }
      }

      // Turned off again so nothing after this runs against an open API.
      await fetch(`${base}/api/admin/apikey`, { method: 'DELETE', headers: { Cookie: cookie } });
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
    failures += await watchlistPushChecks();
    failures += await watchlistApiPlexChecks();
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
