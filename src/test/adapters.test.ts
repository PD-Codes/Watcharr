import assert from 'node:assert/strict';
import { createAdapter } from '../server/adapters';
import { plexTranscodeReason } from '../server/adapters/plex';

/** Minimal fetch stub: maps a URL substring to a JSON payload. */
function stubFetch(routes: Record<string, unknown>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    assert.ok(key, `unexpected request: ${url}`);
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

async function testJellyfinSessions() {
  stubFetch({
    '/Sessions': [
      {
        Id: 's1',
        UserId: 'u1',
        UserName: 'alice',
        Client: 'Jellyfin Web',
        DeviceName: 'Living Room',
        PlayState: { PositionTicks: 6_000_000_000, IsPaused: true, PlayMethod: 'Transcode' },
        NowPlayingItem: {
          Id: 'i1',
          Name: 'Episode 1',
          SeriesName: 'Show',
          Type: 'Episode',
          RunTimeTicks: 12_000_000_000,
          Container: 'mkv',
          MediaStreams: [
            { Type: 'Video', Codec: 'HEVC', Width: 1920, Height: 1080, BitRate: 12_000_000 },
            { Type: 'Audio', Codec: 'EAC3' },
          ],
        },
        LastPlaybackCheckIn: '2026-08-23T10:00:00.000Z',
        TranscodingInfo: {
          Bitrate: 4_000_000,
          VideoCodec: 'H264',
          AudioCodec: 'AAC',
          Container: 'ts',
          Width: 1280,
          Height: 720,
          TranscodeReasons: ['VideoCodecNotSupported'],
        },
      },
      { Id: 's2', UserId: 'u2', UserName: 'bob' }, // idle session, must be dropped
    ],
  });

  const sessions = await createAdapter('jellyfin', 'http://jf:8096', 'tok').getSessions();
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], {
    sessionKey: 's1',
    serverUserId: 'u1',
    username: 'alice',
    itemId: 'i1',
    title: 'Episode 1',
    grandparentTitle: 'Show',
    mediaType: 'episode',
    state: 'paused',
    progressMs: 600_000,
    durationMs: 1_200_000,
    isTranscoding: true,
    bandwidthKbps: 4000,
    clientName: 'Jellyfin Web',
    deviceName: 'Living Room',
    playMethod: 'transcode',
    // While transcoding the delivered stream matters, not the source stream.
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'ts',
    width: 1280,
    height: 720,
    transcodeReason: 'VideoCodecNotSupported',
    audioChannels: undefined,
    subtitleCodec: undefined,
    // The source side of the same stream: what the file holds, before the re-encode above.
    // Both halves are reported so a stream panel can show "HEVC 1080p → H264 720p".
    sourceVideoCodec: 'hevc',
    sourceAudioCodec: 'eac3',
    sourceContainer: 'mkv',
    sourceHeight: 1080,
    sourceBitrateKbps: 12_000,
    terminateKey: 's1',
    remoteAddress: undefined,
    lastCheckInAt: new Date('2026-08-23T10:00:00.000Z'),
  });
}

async function testJellyfinHistoryFiltersBySince() {
  stubFetch({
    '/Items': {
      Items: [
        { Id: 'a', Name: 'Old', Type: 'Movie', Genres: ['Drama'], UserData: { LastPlayedDate: '2020-01-01T00:00:00Z' } },
        { Id: 'b', Name: 'New', Type: 'Movie', Genres: ['Comedy'], UserData: { LastPlayedDate: '2026-01-01T00:00:00Z' } },
        { Id: 'c', Name: 'Never played', Type: 'Movie' },
      ],
    },
  });

  const { entries: history, more } = await createAdapter('emby', 'http://emby:8096', 'tok').getHistory(
    'tok',
    'u1',
    new Date('2025-01-01T00:00:00Z'),
  );
  assert.deepEqual(history.map((h) => h.itemId), ['b']);
  assert.deepEqual(history[0].genres, ['Comedy']);
  assert.equal(more, false);
}

async function testJellyfinDirectPlayUsesSourceStreams() {
  stubFetch({
    '/Sessions': [
      {
        Id: 's3',
        UserId: 'u3',
        UserName: 'dave',
        Client: 'Jellyfin Android TV',
        DeviceName: 'Fire TV',
        PlayState: { PositionTicks: 0, IsPaused: false, PlayMethod: 'DirectPlay' },
        NowPlayingItem: {
          Id: 'i3',
          Name: 'Movie',
          Type: 'Movie',
          Container: 'MKV',
          MediaStreams: [
            { Type: 'Video', Codec: 'HEVC', Width: 3840, Height: 2160, BitRate: 40_000_000 },
            { Type: 'Audio', Codec: 'TrueHD' },
          ],
        },
      },
    ],
  });

  const [session] = await createAdapter('jellyfin', 'http://jf:8096', 'tok').getSessions();
  assert.equal(session.lastCheckInAt, undefined, 'absent check-in must stay undefined');
  assert.equal(session.playMethod, 'directplay');
  assert.equal(session.isTranscoding, false);
  assert.equal(session.videoCodec, 'hevc');
  assert.equal(session.container, 'mkv');
  assert.equal(session.height, 2160);
  assert.equal(session.bandwidthKbps, 40_000);
}

async function testPlexSessions() {
  stubFetch({
    '/status/sessions': {
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '42',
            title: 'Movie',
            type: 'movie',
            duration: 7_200_000,
            viewOffset: 1_800_000,
            User: { id: '7', title: 'carol' },
            Player: { state: 'playing', title: 'Shield', product: 'Plex for Android' },
            Session: { bandwidth: 8000 },
            Media: [
              {
                container: 'mp4',
                videoCodec: 'h264',
                audioCodec: 'aac',
                width: 1920,
                height: 1080,
                Part: [{ decision: 'transcode' }],
              },
            ],
            TranscodeSession: {
              videoDecision: 'transcode',
              audioDecision: 'copy',
              container: 'mkv',
              videoCodec: 'hevc',
            },
          },
        ],
      },
    },
  });

  const [session] = await createAdapter('plex', 'http://plex:32400', 'tok').getSessions();
  assert.equal(session.serverUserId, '7');
  assert.equal(session.isTranscoding, true);
  assert.equal(session.progressMs, 1_800_000);
  assert.equal(session.playMethod, 'transcode');
  assert.equal(session.clientName, 'Plex for Android');
  assert.equal(session.container, 'mkv');
  assert.equal(session.videoCodec, 'hevc');
  assert.equal(session.transcodeReason, 'VideoCodecNotSupported');
}

async function testPlexTranscodeReason() {
  const file = { container: 'mkv', videoCodec: 'h264', height: 2160 };
  assert.equal(plexTranscodeReason({ videoDecision: 'transcode', videoCodec: 'h264', height: 1080 }, file), 'VideoResolutionNotSupported');
  assert.equal(plexTranscodeReason({ videoDecision: 'transcode', videoCodec: 'h264', height: 2160 }, file), 'ContainerBitrateExceedsLimit');
  assert.equal(plexTranscodeReason({ videoDecision: 'copy', audioDecision: 'transcode' }, file), 'AudioCodecNotSupported');
  assert.equal(plexTranscodeReason({ videoDecision: 'copy', audioDecision: 'copy', subtitleDecision: 'burn' }, file), 'SubtitleCodecNotSupported');
  assert.equal(plexTranscodeReason({ videoDecision: 'copy', audioDecision: 'copy', container: 'ts' }, file), 'ContainerNotSupported');
  assert.equal(plexTranscodeReason({ videoDecision: 'copy', audioDecision: 'copy', container: 'mkv' }, file), undefined);
}

async function testPlexDirectPlay() {
  stubFetch({
    '/status/sessions': {
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '43',
            title: 'Movie',
            type: 'movie',
            User: { id: '8', title: 'erin' },
            Player: { state: 'playing', title: 'TV', product: 'Plex for Apple TV' },
            Media: [{ container: 'mkv', videoCodec: 'hevc', height: 2160, Part: [{ decision: 'directplay' }] }],
          },
        ],
      },
    },
  });

  const [session] = await createAdapter('plex', 'http://plex:32400', 'tok').getSessions();
  assert.equal(session.playMethod, 'directplay');
  assert.equal(session.isTranscoding, false);
  assert.equal(session.height, 2160);
}

/**
 * A show library needs three counts, a movie library one. Getting that wrong is invisible
 * in the UI — a missing season total just renders as a dash — so it is asserted here, and
 * the stub also proves no Season/Episode request is made for a movie library.
 */
async function testJellyfinLibraryCounts() {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.includes('/Library/VirtualFolders')) {
      return Response.json([
        { Name: 'Filme', ItemId: 'lib-movies', CollectionType: 'movies' },
        { Name: 'Serien', ItemId: 'lib-shows', CollectionType: 'tvshows' },
        // Music comes as one track count, never as titles with seasons.
        { Name: 'Hörspiele', ItemId: 'lib-music', CollectionType: 'music' },
        { Name: 'Fotos', ItemId: 'lib-photos', CollectionType: 'homevideos' },
      ]);
    }
    const totals: Record<string, number> = { 'Audio%2CAudioBook': 812, Movie: 2335, Series: 501, Season: 2023, Episode: 34214 };
    const type = Object.keys(totals).find((t) => url.includes(`IncludeItemTypes=${t}`));
    return Response.json({ TotalRecordCount: type ? totals[type] : 0 });
  }) as typeof fetch;

  const sections = await createAdapter('jellyfin', 'http://jf:8096', 'tok').getLibraries();
  assert.deepEqual(sections, [
    { id: 'lib-movies', name: 'Filme', mediaType: 'movie', itemCount: 2335, seasonCount: undefined, episodeCount: undefined },
    { id: 'lib-shows', name: 'Serien', mediaType: 'show', itemCount: 501, seasonCount: 2023, episodeCount: 34214 },
    { id: 'lib-music', name: 'Hörspiele', mediaType: 'audio', itemCount: 812 },
  ]);
  assert.ok(
    !asked.some((url) => url.includes('lib-movies') && url.includes('IncludeItemTypes=Season')),
    'a movie library must not be asked for seasons',
  );
}

/**
 * A rejected token has to be recognisable from the error object, not from its English
 * text: sync.ts drops the auth session on it.
 */
async function testUnauthorizedDetection() {
  const { apiFetch, isUnauthorized } = await import('../server/adapters/http');
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
  try {
    const error = await apiFetch('http://example.invalid/x').then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(isUnauthorized(error), 'a 401 must be detectable');
    assert.ok(!isUnauthorized(new Error('GET … failed: 500')), 'a 500 is not a token problem');
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * A library past the page size must come back whole. A single capped request used to drop
 * the tail without any sign of it, and the counts on the libraries page (which come from
 * the server's own total) then disagreed with the table built from the truncated list.
 */
async function testLibraryIsPaged() {
  const total = 5003;
  const page = <T>(start: number, limit: number, make: (n: number) => T): T[] =>
    Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => make(start + i));

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/Library/VirtualFolders') {
      return Response.json([{ Name: 'Movies', ItemId: 'lib', CollectionType: 'movies' }]);
    }
    if (url.searchParams.get('Limit') === '0') return Response.json({ TotalRecordCount: total });
    const items = page(Number(url.searchParams.get('StartIndex') ?? 0), Number(url.searchParams.get('Limit')), (n) => ({
      Id: `m${n}`,
      Name: `Movie ${n}`,
      Type: 'Movie',
    }));
    return Response.json({ Items: items });
  }) as typeof fetch;
  const jellyfin = await createAdapter('jellyfin', 'http://jf:8096', 'tok').getLibrary();
  assert.equal(jellyfin.length, total);
  assert.equal(new Set(jellyfin.map((i) => i.itemId)).size, total, 'no page is fetched twice');

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/library/sections') {
      return Response.json({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }] } });
    }
    const metadata = page(
      Number(url.searchParams.get('X-Plex-Container-Start') ?? 0),
      Number(url.searchParams.get('X-Plex-Container-Size')),
      (n) => ({ ratingKey: `m${n}`, title: `Movie ${n}`, type: 'movie' }),
    );
    return Response.json({ MediaContainer: { Metadata: metadata } });
  }) as typeof fetch;
  const plex = await createAdapter('plex', 'http://plex:32400', 'tok').getLibrary();
  assert.equal(plex.length, total);
  assert.equal(new Set(plex.map((i) => i.itemId)).size, total, 'no page is fetched twice');
}

/** Delta sync: only items changed since the cutoff, newest change first, plus each total. */
async function testPlexLibraryChanges() {
  const now = Math.floor(Date.now() / 1000);
  // 450 items, item n changed n minutes ago; Plex answers sorted by updatedAt desc.
  const all = Array.from({ length: 450 }, (_, n) => ({ ratingKey: `m${n}`, title: `Movie ${n}`, type: 'movie', updatedAt: now - n * 60 }));
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/library/sections') {
      return Response.json({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }] } });
    }
    asked.push(url.search);
    assert.equal(url.searchParams.get('sort'), 'updatedAt:desc');
    const start = Number(url.searchParams.get('X-Plex-Container-Start'));
    const size = Number(url.searchParams.get('X-Plex-Container-Size'));
    return Response.json({ MediaContainer: { totalSize: all.length, Metadata: all.slice(start, start + size) } });
  }) as typeof fetch;
  const plex = createAdapter('plex', 'http://plex:32400', 'tok');
  const result = await plex.getLibraryChanges!(new Date((now - 250 * 60) * 1000));
  assert.ok(result);
  assert.equal(result.changed.length, 251, 'everything changed at or after the cutoff');
  assert.equal(result.totals['1'], 450);
  assert.equal(asked.length, 2, 'stops at the first page that reaches older changes');
  const everything = await plex.getLibraryChanges!(new Date(0));
  assert.equal(everything?.changed.length, 450);
}

/**
 * plex.tv hands a valid token to every Plex account there is. Signing in must additionally
 * require that plex.tv lists this very server for the account, or any stranger could browse
 * the library through the app's admin token.
 */
async function testPlexSignInRequiresServerAccess() {
  const { isUnauthorized } = await import('../server/adapters/http');
  const serve = (resources: unknown) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('plex.tv/api/v2/user')) return Response.json({ id: 9, username: 'frank' });
      if (url.includes('plex.tv/api/v2/resources')) return Response.json(resources);
      if (url === 'http://plex:32400/') {
        return Response.json({ MediaContainer: { machineIdentifier: 'abc', myPlexUsername: 'owner' } });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
  };
  const plex = createAdapter('plex', 'http://plex:32400', 'admin-token');

  serve([{ clientIdentifier: 'other-server' }, { clientIdentifier: 'abc' }]);
  const user = await plex.getUser('user-token');
  assert.equal(user.username, 'frank');
  assert.equal(user.isAdmin, false);

  // Admin detection: plex.tv's `owned` flag wins; the name match is a case-insensitive fallback.
  serve([{ clientIdentifier: 'abc', owned: true }]);
  assert.equal((await plex.getUser('user-token')).isAdmin, true, 'the owned flag makes the owner an admin');
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('plex.tv/api/v2/user')) return Response.json({ id: 9, username: 'Frank', email: 'f@x.io' });
    if (url.includes('plex.tv/api/v2/resources')) return Response.json([{ clientIdentifier: 'abc', owned: false }]);
    return Response.json({ MediaContainer: { machineIdentifier: 'abc', myPlexUsername: 'FRANK' } });
  }) as typeof fetch;
  assert.equal((await plex.getUser('user-token')).isAdmin, true, 'case differences do not hide the owner');
  serve([{ clientIdentifier: 'abc', owned: false }]);
  assert.equal((await plex.getUser('user-token')).isAdmin, false, 'a shared user is no admin');

  for (const resources of [[{ clientIdentifier: 'other-server' }], [], { error: 'nope' }]) {
    serve(resources);
    const denied = await plex.getUser('user-token').then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(isUnauthorized(denied), `an account without this server is refused (${JSON.stringify(resources)})`);
  }
}

/**
 * The configured URL is the public plex.direct address and the router has no NAT loopback:
 * every request to it times out. The adapter must find another route through plex.tv instead
 * of locking everybody out, and must never settle on an address that is a different server.
 * With DNS rebind protection on the router the LAN plex.direct name does not resolve either,
 * so the bare LAN address over http is the way in; the system check reports that detour.
 */
async function testPlexFindsAnotherRoute() {
  const { resetPlexRoutes, plexRoute, routeCandidates, plainLanRoute } = await import('../server/adapters/plexroute');
  const { evaluateDoctor } = await import('../server/doctor-core');
  const { isStrained, resetStrain } = await import('../server/strain');
  resetPlexRoutes();
  resetStrain();
  const hash = '8e0d3c002fd24bf1a524df4328908c15';
  const configured = `https://46-1-2-3.${hash}.plex.direct:16415`;
  const resources = [
    { clientIdentifier: 'someone-else', provides: 'server', connections: [{ uri: 'http://10.0.0.9:32400', local: true }] },
    {
      clientIdentifier: 'abc',
      provides: 'server',
      owned: true,
      connections: [
        { uri: 'https://relay.plex.direct:8443', relay: true },
        { uri: configured, address: '46.1.2.3', port: 16415, local: false },
        { uri: `https://192-168-1-5.${hash}.plex.direct:32400`, address: '192.168.1.5', port: 32400, local: true },
        // A plain-http connection entry, as servers with secure connections "preferred" list them.
        { uri: 'http://192.168.1.5:32400', address: '192.168.1.5', port: 32400, local: true, protocol: 'http' },
      ],
    },
  ];

  assert.deepEqual(routeCandidates(resources, configured), {
    machineId: 'abc',
    urls: [configured, `https://192-168-1-5.${hash}.plex.direct:32400`, 'http://192.168.1.5:32400', 'https://relay.plex.direct:8443'],
  }, 'configured first, then the LAN (plex.direct, then bare), public, relay last — for an https URL too');
  assert.deepEqual(routeCandidates(resources, 'http://192.168.1.4:32400'), {
    machineId: 'abc',
    urls: [
      'http://192.168.1.4:32400',
      `https://192-168-1-5.${hash}.plex.direct:32400`,
      'http://192.168.1.5:32400',
      configured,
      'https://relay.plex.direct:8443',
    ],
  }, 'configured first, then LAN (with the bare address), public, relay last');
  assert.equal(routeCandidates(resources, 'http://unknown:32400')?.machineId, 'abc',
    'with one owned server an unmatched URL still finds it');
  assert.equal(routeCandidates({ error: 'x' }, configured), null);

  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const requested: string[] = [];
  let lanMachine = 'abc';
  const leaked: string[] = [];
  let dead = configured;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    const sent = new Headers(init?.headers);
    if (url.endsWith('/identity') && sent.has('X-Plex-Token')) leaked.push(url);
    if (url.startsWith(dead)) throw timeout();
    if (url.includes('plex.tv/api/v2/resources')) return Response.json(resources);
    if (url.includes('192-168-1-5')) throw new TypeError('fetch failed'); // DNS rebind protection
    if (url === 'http://192.168.1.5:32400/identity') return Response.json({ MediaContainer: { machineIdentifier: lanMachine } });
    if (url === 'https://relay.plex.direct:8443/identity') return Response.json({ MediaContainer: { machineIdentifier: 'abc' } });
    if (url.endsWith('/')) return Response.json({ MediaContainer: { friendlyName: 'Stream Server', version: '1.41' } });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const warn = console.warn;
  console.warn = () => {};
  try {
    const plex = createAdapter('plex', configured, 'admin-token');
    const health = await plex.ping();
    assert.equal(health.ok, true, 'the first request already succeeds through the detour');
    assert.equal(plexRoute(configured), 'http://192.168.1.5:32400',
      'no NAT loopback and a LAN plex.direct name that does not resolve: the bare LAN address, before the relay');
    assert.equal(isStrained(configured), false, 'a dead route is not reported as an overloaded server');
    requested.length = 0;
    await plex.ping();
    assert.deepEqual(requested, ['http://192.168.1.5:32400/'], 'later requests go straight to the detour');

    // Works, but the admin token now crosses the LAN in the clear: the system check says so.
    assert.equal(plainLanRoute(configured), 'http://192.168.1.5:32400');
    const base = {
      secretIsPlaceholder: false, appUrlSet: true, tmdbConfigured: true, emailChannel: false,
      newsletterEnabled: false, timezoneSet: true,
      backup: { autoEnabled: false, intervalHours: 24, lastAutoAt: null, newestAt: Date.now() },
      disk: { freeBytes: null, dbBytes: 0 }, downServers: [], pendingMigrations: 0, updateAvailable: null,
      importInterrupted: false, restorePending: false,
    };
    const plain = evaluateDoctor({ ...base, plexPlainRoutes: [`Plex → ${plainLanRoute(configured)}`] }).find((c) => c.id === 'plexPlain');
    assert.equal(plain?.level, 'warn', 'plain http to a bare address is a warning');
    assert.match(String(plain?.params?.routes), /http:\/\/192\.168\.1\.5:32400/);
    assert.equal(evaluateDoctor({ ...base, plexPlainRoutes: [] }).find((c) => c.id === 'plexPlain')?.level, 'ok');
    assert.equal(evaluateDoctor(base).find((c) => c.id === 'plexPlain'), undefined, 'no Plex server, no check');

    // The server moved on the LAN, and the admin had configured its old private http address.
    resetPlexRoutes();
    dead = 'http://192.168.1.4:32400';
    const lan = createAdapter('plex', dead, 'admin-token');
    assert.equal((await lan.ping()).ok, true);
    assert.equal(plexRoute(dead), 'http://192.168.1.5:32400', 'the LAN beats the relay');
    assert.deepEqual(leaked, [], 'probes never carry the admin token: a listed LAN address may be a stranger here');
    assert.equal(plainLanRoute('http://192.168.1.5:32400'), null, 'a configured plain URL is the admin\'s own choice');

    // Another server answering on that LAN address must not be taken for this one.
    resetPlexRoutes();
    lanMachine = 'not-abc';
    await lan.ping();
    assert.equal(plexRoute(dead), 'https://relay.plex.direct:8443', 'a foreign machine identifier is refused');
    assert.equal(plainLanRoute(dead), null, 'the relay is https: nothing to report');
  } finally {
    console.warn = warn;
    resetPlexRoutes();
    resetStrain();
  }
}

/** The address a session is attributed to must not carry the client's source port. */
async function testEndpointAddress() {
  const { endpointAddress } = await import('../server/adapters/jellyfin');
  assert.equal(endpointAddress('10.0.0.5:52344'), '10.0.0.5');
  assert.equal(endpointAddress('10.0.0.5'), '10.0.0.5');
  assert.equal(endpointAddress('[fe80::1]:52344'), 'fe80::1');
  assert.equal(endpointAddress('fe80::1'), 'fe80::1');
  // The same client seen through the IPv4-mapped notation must not become a second row.
  assert.equal(endpointAddress('::ffff:10.0.0.5'), '10.0.0.5');
  assert.equal(endpointAddress(undefined), undefined);
}


/** Owner is local account 1 on the server; history needs that id and carries no durations. */
async function testPlexHistoryUsesLocalAccountAndEnriches() {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.pathname + url.search);
    if (url.pathname === '/accounts') {
      return Response.json({ MediaContainer: { Account: [{ id: 0, name: '' }, { id: 1, name: 'Owner' }, { id: 77, name: 'Pat' }] } });
    }
    if (url.pathname === '/status/sessions/history/all') {
      if (!asked.some((u) => u.includes('accountID=77'))) {
        assert.equal(url.searchParams.get('accountID'), '1', 'the owner is looked up under the local id');
      }
      return Response.json({
        MediaContainer: {
          Metadata: [
            { ratingKey: '10', grandparentRatingKey: '5', title: 'Ep', grandparentTitle: 'Show', type: 'episode', viewedAt: 1_700_000_000 },
            { ratingKey: '11', title: 'Film', type: 'movie', viewedAt: 1_700_000_100 },
          ],
        },
      });
    }
    if (url.pathname === '/library/metadata/10') return Response.json({ MediaContainer: { Metadata: [{ ratingKey: '10', title: 'Ep', duration: 1_800_000 }] } });
    if (url.pathname === '/library/metadata/5') return Response.json({ MediaContainer: { Metadata: [{ ratingKey: '5', title: 'Show', Genre: [{ tag: 'Drama' }] }] } });
    if (url.pathname === '/library/metadata/11') return Response.json({ MediaContainer: { Metadata: [{ ratingKey: '11', title: 'Film', year: 1999, duration: 6_000_000, Genre: [{ tag: 'Sci-Fi' }] }] } });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const plex = createAdapter('plex', 'http://plex-history:32400', 'tok');
  const { entries: rows } = await plex.getHistory('tok', '987654', undefined, 'owner');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].durationMs, 1_800_000);
  assert.deepEqual(rows[0].genres, ['Drama'], 'an episode takes its genres from the show');
  assert.equal(rows[1].year, 1999);
  assert.equal(rows[1].durationMs, 6_000_000);
  // A shared user's plex.tv id is already the local id and is used as it is.
  const hits = asked.length;
  await plex.getHistory('tok', '77', undefined, 'pat');
  assert.ok(asked.slice(hits).some((u) => u.includes('accountID=77')));
}

async function testPlexListUsersReadsXml() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('plex.tv/api/users')) {
      return new Response(
        '<MediaContainer><User id="77" title="Pat &amp; Co" email="p@x.io" thumb="http://t/1"/><User id="78" title="Lee"/></MediaContainer>',
        { status: 200, headers: { 'Content-Type': 'text/xml' } },
      );
    }
    if (url.includes('plex.tv/api/v2/user')) return Response.json({ id: 9, username: 'Owner', email: 'o@x.io' });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const list = await createAdapter('plex', 'http://plex-users:32400', 'tok').listUsers();
  assert.deepEqual(list.map((u) => [u.serverUserId, u.username, u.isAdmin]), [
    ['9', 'Owner', true],
    ['77', 'Pat & Co', false],
    ['78', 'Lee', false],
  ]);
  assert.equal(list[1].email, 'p@x.io');
  const full = await createAdapter('plex', 'http://plex-users:32400', 'tok').listUsersWithCompleteness?.();
  assert.equal(full?.complete, true, 'friends from plex.tv plus the owner are the whole list');
}

async function testPlexPartialUserListIsNotComplete() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('plex.tv/api/users')) return new Response('down', { status: 503 });
    if (url.includes('plex.tv/api/v2/user')) return Response.json({ id: 9, username: 'Owner', email: 'o@x.io' });
    if (url.includes('/accounts')) {
      return Response.json({ MediaContainer: { Account: [{ id: 0, name: '' }, { id: 1, name: 'Owner' }, { id: 77, name: 'Pat' }] } });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const roster = await createAdapter('plex', 'http://plex-partial:32400', 'tok').listUsersWithCompleteness?.();
  assert.ok(roster);
  assert.deepEqual(roster.users.map((u) => u.serverUserId), ['9', '77'], 'falls back to the account table');
  // The fallback only names people who have streamed: reading it as complete would sign out
  // every shared user who has not.
  assert.equal(roster.complete, false);
}

/**
 * plex.tv answered, but with nobody: indistinguishable from a token that lost its plex.tv
 * rights. Read as complete it would sign out every shared user at the next roster sync.
 */
async function testPlexEmptyFriendListIsNotComplete() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('plex.tv/api/users')) return new Response('<MediaContainer size="0"></MediaContainer>', { status: 200 });
    if (url.includes('plex.tv/api/v2/user')) return Response.json({ id: 9, username: 'Owner', email: 'o@x.io' });
    if (url.includes('/accounts')) {
      return Response.json({ MediaContainer: { Account: [{ id: 1, name: 'Owner' }, { id: 77, name: 'Pat' }] } });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const roster = await createAdapter('plex', 'http://plex-empty:32400', 'tok').listUsersWithCompleteness?.();
  assert.ok(roster);
  assert.deepEqual(roster.users.map((u) => u.serverUserId), ['9', '77'], 'the account table stands in');
  assert.equal(roster.complete, false, 'an empty friends list never makes the roster complete');
}

async function testPlexSocketFiltersFrames() {
  const socket = createAdapter('plex', 'http://plex:32400', 'tok').liveSocket?.();
  const relevant = socket?.relevant;
  assert.ok(relevant);
  const frame = (type: string) => JSON.stringify({ NotificationContainer: { type } });
  assert.equal(relevant(frame('playing')), true);
  assert.equal(relevant(frame('transcodeSession.update')), true);
  assert.equal(relevant(frame('timeline')), false);
  assert.equal(relevant(frame('activity')), false);
  assert.equal(relevant('not json'), true, 'unreadable frames still ring the doorbell');
}

/** A Plex history endpoint that honours sort, paging and `viewedAt>` the way Plex does. */
function plexHistoryServer(plays: { ratingKey: string; viewedAt: number }[], opts: { unpaged?: boolean } = {}) {
  const asked: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/accounts') return Response.json({ MediaContainer: { Account: [{ id: 1, name: 'Owner' }] } });
    if (url.pathname === '/status/sessions/history/all') {
      asked.push(url);
      const after = Number(url.searchParams.get('viewedAt>') ?? -Infinity);
      const desc = url.searchParams.get('sort') === 'viewedAt:desc';
      const matching = plays
        .filter((p) => opts.unpaged || p.viewedAt > after)
        .sort((a, b) => (desc ? b.viewedAt - a.viewedAt : a.viewedAt - b.viewedAt));
      const start = Number(url.searchParams.get('X-Plex-Container-Start'));
      const size = Number(url.searchParams.get('X-Plex-Container-Size'));
      const metadata = (opts.unpaged ? matching : matching.slice(start, start + size)).map((p) => ({
        ratingKey: p.ratingKey,
        title: `Title ${p.ratingKey}`,
        type: 'movie',
        viewedAt: p.viewedAt,
      }));
      return Response.json({ MediaContainer: { totalSize: opts.unpaged ? undefined : matching.length, Metadata: metadata } });
    }
    const key = /^\/library\/metadata\/(.+)$/.exec(url.pathname)?.[1];
    if (key) return Response.json({ MediaContainer: { Metadata: [{ ratingKey: key, title: key, duration: 60_000 }] } });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return asked;
}

/**
 * Oldest first, page after page, up to a cap per call — and `more` when the cap was hit. The
 * newest-first cap this replaced lost every play past it for good, because the next call only
 * asks for plays newer than the newest one stored.
 */
async function testPlexHistoryPagesAscending() {
  const base = 1_600_000_000;
  // 6200 plays of 20 titles (few metadata lookups); plays 4999 and 5000 share one second.
  const plays = Array.from({ length: 6200 }, (_, i) => ({ ratingKey: String(100 + (i % 20)), viewedAt: base + i * 60 - (i === 5000 ? 60 : 0) }));
  const asked = plexHistoryServer(plays);
  const plex = createAdapter('plex', 'http://plex-paging:32400', 'tok');

  const first = await plex.getHistory('tok', '1', undefined, 'owner');
  assert.equal(asked.length, 10, 'ten pages per call, no more');
  assert.ok(asked.every((u) => u.searchParams.get('sort') === 'viewedAt:asc'), 'oldest first');
  assert.deepEqual(asked.map((u) => Number(u.searchParams.get('X-Plex-Container-Start'))), [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500]);
  assert.equal(first.more, true, 'the cap was hit, so there is more');
  assert.equal(first.entries[0].watchedAt.getTime(), base * 1000, 'starts at the oldest play');
  assert.equal(first.entries.length, 4999, 'the play sharing the last second is left for the next call');
  assert.equal(first.entries[0].durationMs, 60_000, 'durations come from the metadata lookups');

  asked.length = 0;
  const since = first.entries[first.entries.length - 1].watchedAt;
  const second = await plex.getHistory('tok', '1', since, 'owner');
  assert.equal(asked[0].searchParams.get('viewedAt>'), String(since.getTime() / 1000));
  assert.equal(second.more, false);
  assert.equal(asked.length, 3, 'stops at the last, short page');
  const all = [...first.entries, ...second.entries].map((e) => e.watchedAt.getTime());
  assert.equal(all.length, 6200, 'together every play, none twice — the tie included');
  assert.equal(new Set(all).size, 6199, 'only the two plays of one second share a timestamp');
}

/** Every title not seen before costs a metadata read; one call may only make so many. */
async function testPlexHistoryLimitsLookups() {
  const plays = Array.from({ length: 1500 }, (_, i) => ({ ratingKey: String(10_000 + i), viewedAt: 1_600_000_000 + i }));
  const asked = plexHistoryServer(plays);
  const plex = createAdapter('plex', 'http://plex-lookups:32400', 'tok');
  const first = await plex.getHistory('tok', '1', undefined, 'owner');
  assert.equal(asked.length, 2, 'stops once the lookup budget is spent');
  assert.equal(first.more, true);
  // The newest second of a capped call always waits for the next one (it may have a twin
  // just past the cap), so 999 here and 501 there.
  assert.equal(first.entries.length, 999);
  const second = await plex.getHistory('tok', '1', first.entries[998].watchedAt, 'owner');
  assert.equal(second.entries.length, 501);
  assert.equal(second.more, false);
}

/** A server ignoring the page size: one answer, sorted and cut at what a call may carry. */
async function testPlexHistoryIgnoredPageSize() {
  const plays = Array.from({ length: 7000 }, (_, i) => ({ ratingKey: String(200 + (i % 10)), viewedAt: 1_600_000_000 + (6999 - i) * 60 }));
  const asked = plexHistoryServer(plays, { unpaged: true });
  const page = await createAdapter('plex', 'http://plex-unpaged:32400', 'tok').getHistory('tok', '1', undefined, 'owner');
  assert.equal(asked.length, 1, 'no second request to a server that sent everything');
  assert.equal(page.entries.length, 4999, 'cut at the cap, its last second left for the next call');
  assert.equal(page.more, true);
  assert.equal(page.entries[0].watchedAt.getTime(), 1_600_000_000_000, 'the oldest plays come first');
  // The same server, asked from the newest returned play on: nothing older comes back in.
  const next = await createAdapter('plex', 'http://plex-unpaged:32400', 'tok').getHistory('tok', '1', page.entries[4998].watchedAt, 'owner');
  assert.ok(next.entries.every((e) => e.watchedAt > page.entries[4998].watchedAt), 'filtered client-side as well');
  assert.equal(next.entries.length, 2001, 'everything newer, not the oldest 5000 cut first and then filtered away');
  assert.equal(next.more, false);

  // Far past the first cut: filtering after cutting left nothing, with `more` set, for good.
  const late = new Date((1_600_000_000 + 6000 * 60) * 1000);
  const tail = await createAdapter('plex', 'http://plex-unpaged:32400', 'tok').getHistory('tok', '1', late, 'owner');
  assert.equal(tail.entries.length, 999, 'the 999 plays after the cursor arrive');
  assert.equal(tail.more, false, 'and nothing is left over');
  assert.equal(tail.entries[0].watchedAt.getTime(), late.getTime() + 60_000);
}

/** A Jellyfin /Users/{id}/Items that sorts by DatePlayed and pages like the real one. */
function jellyfinHistoryServer(items: { Id: string; at?: number }[]) {
  const asked: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url);
    assert.match(url.pathname, /^\/Users\/u1\/Items$/);
    const sorted = [...items].sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
    if (url.searchParams.get('SortOrder') === 'Descending') sorted.reverse();
    const start = Number(url.searchParams.get('StartIndex'));
    const limit = Number(url.searchParams.get('Limit'));
    return Response.json({
      TotalRecordCount: items.length,
      Items: sorted.slice(start, start + limit).map((i) => ({
        Id: i.Id,
        Name: i.Id,
        Type: 'Episode',
        UserData: i.at === undefined ? {} : { LastPlayedDate: new Date(i.at).toISOString() },
      })),
    });
  }) as typeof fetch;
  return asked;
}

/**
 * Jellyfin keeps no play log, only "last played" per item, and cannot filter by it. The usual
 * sync is still one request; a backlog is continued oldest first from just after `since`.
 */
async function testJellyfinHistoryPages() {
  const base = Date.UTC(2024, 0, 1);
  const items = [
    ...Array.from({ length: 8000 }, (_, i) => ({ Id: `e${i}`, at: base + i * 60_000 })),
    ...Array.from({ length: 5 }, (_, i) => ({ Id: `undated${i}` })), // marked played, never played
  ];
  const asked = jellyfinHistoryServer(items);
  const jf = createAdapter('jellyfin', 'http://jf-history:8096', 'tok');
  const at = (n: number) => new Date(base + n * 60_000);

  const recent = await jf.getHistory('tok', 'u1', at(7990));
  assert.equal(asked.length, 1, 'a few new plays cost one request');
  assert.equal(asked[0].searchParams.get('SortOrder'), 'Descending');
  assert.deepEqual(recent.entries.map((e) => e.itemId).sort(), ['e7991', 'e7992', 'e7993', 'e7994', 'e7995', 'e7996', 'e7997', 'e7998', 'e7999']);
  assert.equal(recent.more, false);

  asked.length = 0;
  const backlog = await jf.getHistory('tok', 'u1', at(1999));
  assert.equal(backlog.more, true, 'more than one call carries');
  assert.equal(backlog.entries.length, 4999, 'the newest instant waits for the next call');
  assert.equal(backlog.entries[0].itemId, 'e2000', 'continues right after since, oldest first');
  assert.equal(backlog.entries[4998].itemId, 'e6998');
  const pages = asked.filter((u) => u.searchParams.get('Limit') === '500' && u.searchParams.get('SortOrder') === 'Ascending');
  assert.equal(pages.length, 10, 'ten pages per call');
  assert.ok(asked.length < 1 + 10 + 20, 'finding the start costs a handful of one-item requests');

  const rest = await jf.getHistory('tok', 'u1', backlog.entries[4998].watchedAt);
  assert.equal(rest.more, false);
  assert.deepEqual([rest.entries[0].itemId, rest.entries.length], ['e6999', 1001]);

  // The first sync: everything, oldest first, the never-played items left out.
  const first = await jf.getHistory('tok', 'u1', undefined);
  assert.equal(first.entries[0].itemId, 'e0');
  assert.equal(first.more, true);
}

/**
 * A failed library request must fail the whole listing. Returning [] (or half a list) made
 * library.ts replace its good copy with nothing until the next refresh; thrown, it keeps it.
 */
async function testJellyfinLibraryThrowsOnError() {
  let inFlight = 0;
  let peak = 0;
  let failOn = '';
  const asked: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(url);
    if (url.pathname === '/Library/VirtualFolders') {
      return Response.json([
        { Name: 'Movies', ItemId: 'lib-movies', CollectionType: 'movies' },
        { Name: 'Shows', ItemId: 'lib-shows', CollectionType: 'tvshows' },
      ]);
    }
    assert.ok(init?.signal, 'every request carries a timeout');
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    if (failOn && url.search.includes(failOn)) return new Response('boom', { status: 500 });
    if (url.searchParams.get('Limit') === '0') return Response.json({ TotalRecordCount: 3 });
    return Response.json({ Items: [{ Id: `${url.searchParams.get('ParentId')}-1`, Name: 'x', Type: 'Movie' }] });
  }) as typeof fetch;
  const jf = createAdapter('jellyfin', 'http://jf-lib:8096', 'tok');

  const items = await jf.getLibrary();
  assert.deepEqual(items.map((i) => [i.itemId, i.sectionId]), [['lib-movies-1', 'lib-movies'], ['lib-shows-1', 'lib-shows']]);
  assert.equal(peak, 1, 'one library after the other');
  assert.ok(asked.filter((u) => u.pathname === '/Items').every((u) => u.searchParams.get('Limit') === '1000'), '1000-item pages');

  failOn = 'ParentId=lib-shows';
  const { isPartialLibrary } = await import('../server/adapters');
  const partial = await jf.getLibrary().then(
    () => null,
    (error: unknown) => error,
  );
  if (!isPartialLibrary(partial)) throw new Error(`one failed library: the others still arrive, flagged as partial (${partial})`);
  assert.deepEqual(partial.failedSections, ['lib-shows']);
  assert.deepEqual(partial.items.map((i) => i.sectionId), ['lib-movies']);
  assert.match(partial.message, /500/);
  await assert.rejects(() => jf.getLibraries(), /500/, 'a failed count is not a zero');
  failOn = 'ParentId=lib-';
  await assert.rejects(
    () => jf.getLibrary(),
    (error: unknown) => !isPartialLibrary(error) && /500/.test(String(error)),
    'every library failed: a plain failure, nothing to keep',
  );
  globalThis.fetch = (async () => new Response('down', { status: 500 })) as typeof fetch;
  await assert.rejects(() => jf.getLibrary(), 'no library list, no empty result either');
}

/**
 * "Mixed movies and shows" libraries (Jellyfin: no CollectionType, Emby: "mixed") are listed
 * per library like the others: asked without a parent, their titles had no library at all.
 */
async function testJellyfinMixedLibraries() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/Library/VirtualFolders') {
      return Response.json([
        { Name: 'Movies', ItemId: 'lib-movies', CollectionType: 'movies' },
        { Name: 'Home', ItemId: 'lib-mixed' },
        { Name: 'Emby mixed', ItemId: 'lib-emby', CollectionType: 'mixed' },
        { Name: 'Music', ItemId: 'lib-music', CollectionType: 'music' },
        { Name: 'Collections', ItemId: 'lib-sets', CollectionType: 'boxsets' },
      ]);
    }
    if (url.pathname.startsWith('/Users/')) {
      return Response.json({ Id: 'u1', Name: 'u', Policy: { EnableAllFolders: true } });
    }
    if (url.searchParams.get('Limit') === '0') return Response.json({ TotalRecordCount: 2 });
    return Response.json({ Items: [{ Id: `${url.searchParams.get('ParentId')}-1`, Name: 'x', Type: 'Movie' }] });
  }) as typeof fetch;
  const jf = createAdapter('jellyfin', 'http://jf-mixed:8096', 'tok');
  const items = await jf.getLibrary();
  assert.deepEqual(items.map((i) => i.sectionId), ['lib-movies', 'lib-mixed', 'lib-emby'], 'each mixed library is a section of its own');
  const sections = await jf.getLibraries();
  assert.deepEqual(
    sections.map((s) => [s.id, s.mediaType]),
    [['lib-movies', 'movie'], ['lib-mixed', 'mixed'], ['lib-emby', 'mixed'], ['lib-music', 'audio']],
  );
  assert.deepEqual(
    await jf.getUserSectionIds!('', 'u1'),
    ['lib-movies', 'lib-mixed', 'lib-emby', 'lib-music'],
    'and a person with access to them may see their titles',
  );
}

/**
 * Owner detection: `owned` from plex.tv, else the account the server is signed into, matched
 * by username or email. Never by `title`, which anyone can set to the owner's address.
 */
async function testPlexOwnerDetection() {
  const serve = (me: Record<string, unknown>, owned?: boolean) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('plex.tv/api/v2/user')) return Response.json({ id: 9, ...me });
      if (url.includes('plex.tv/api/v2/resources')) return Response.json([{ clientIdentifier: 'abc', owned }]);
      return Response.json({ MediaContainer: { machineIdentifier: 'abc', myPlexUsername: 'Owner@Example.com' } });
    }) as typeof fetch;
  };
  const plex = createAdapter('plex', 'http://plex-owner:32400', 'admin-token');
  serve({ username: 'friend', title: 'owner@example.com' });
  assert.equal((await plex.getUser('t')).isAdmin, false, 'a display name copied from the owner proves nothing');
  serve({ username: 'friend', title: 'owner@example.com' }, false);
  assert.equal((await plex.getUser('t')).isAdmin, false);
  serve({ username: 'owner', email: 'owner@example.com' });
  assert.equal((await plex.getUser('t')).isAdmin, true, 'myPlexUsername is the email: matched case-insensitively');
  serve({ username: 'someone', email: 'x@example.com' }, true);
  assert.equal((await plex.getUser('t')).isAdmin, true, 'owned alone is enough');
  serve({ username: '', email: '' });
  assert.equal((await plex.getUser('t')).isAdmin, false, 'empty names never match');
}

/** Which libraries a person may see, in the id format getLibraries() reports. */
async function testUserSectionIds() {
  const { supportsUserSections } = await import('../server/adapters');
  // Plex: the server answers with the server token plex.tv issued this very user.
  let resources: unknown = [{ clientIdentifier: 'abc', accessToken: 'server-token-for-frank' }];
  const tokens: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.href.startsWith('https://plex.tv/api/v2/resources')) {
      assert.equal(new Headers(init?.headers).get('X-Plex-Token'), 'user-plex-tv-token');
      return Response.json(resources);
    }
    if (url.pathname === '/') return Response.json({ MediaContainer: { machineIdentifier: 'abc' } });
    if (url.pathname === '/library/sections') {
      const token = new Headers(init?.headers).get('X-Plex-Token') ?? '';
      tokens.push(token);
      const shared = [
        { key: '1', type: 'movie', title: 'Movies' },
        { key: '7', type: 'artist', title: 'Music' },
        { key: '9', type: 'photo', title: 'Photos' },
      ];
      return Response.json({ MediaContainer: { Directory: token === 'server-token-for-frank' ? shared : [] } });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const plex = createAdapter('plex', 'http://plex-sections:32400', 'admin-token');
  assert.ok(supportsUserSections(plex));
  assert.deepEqual(await plex.getUserSectionIds!('user-plex-tv-token', '42'), ['1', '7'], 'shared sections, as getLibraries lists them');
  assert.deepEqual(tokens, ['server-token-for-frank'], 'asked with the user\'s server token, never the admin token');
  resources = [{ clientIdentifier: 'other' }];
  assert.deepEqual(await plex.getUserSectionIds!('user-plex-tv-token', '42'), [], 'no access to this server: nothing');
  resources = [{ clientIdentifier: 'abc' }];
  assert.equal(await plex.getUserSectionIds!('user-plex-tv-token', '42'), null, 'no server token: cannot tell');
  assert.equal(await plex.getUserSectionIds!('', '42'), null, 'no user token: cannot tell');

  // Jellyfin/Emby: the policy, matched against every notation of a library id.
  let user: unknown = { Id: 'u2', Name: 'kim', Policy: { EnableAllFolders: false, EnabledFolders: ['LIB-MOVIES'] } };
  let views: unknown = { Items: [] };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/Library/VirtualFolders') {
      return Response.json([
        { Name: 'Movies', ItemId: 'lib-movies', CollectionType: 'movies', Guid: '0b1c2d3e-0000-0000-0000-000000000001' },
        { Name: 'Shows', ItemId: 'lib-shows', CollectionType: 'tvshows', Guid: '0b1c2d3e-0000-0000-0000-000000000002' },
        { Name: 'Photos', ItemId: 'lib-photos', CollectionType: 'homevideos' },
      ]);
    }
    if (url.pathname === '/Users/u2') return Response.json(user);
    if (url.pathname === '/Users/u2/Views') return Response.json(views);
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const jf = createAdapter('jellyfin', 'http://jf-sections:8096', 'tok');
  assert.deepEqual(await jf.getUserSectionIds!('', 'u2'), ['lib-movies']);
  user = { Id: 'u2', Policy: { EnableAllFolders: true, EnabledFolders: [] } };
  assert.deepEqual(await jf.getUserSectionIds!('', 'u2'), ['lib-movies', 'lib-shows'], 'all, among the listed libraries');
  user = { Id: 'u2', Policy: { EnableAllFolders: false, EnabledFolders: ['0b1c2d3e000000000000000000000002', 'lib-photos'] } };
  assert.deepEqual(await createAdapter('emby', 'http://emby-sections:8096', 'tok').getUserSectionIds!('', 'u2'), ['lib-shows'],
    'a policy naming the library by its Guid, dashes or not');
  user = { Id: 'u2', Policy: { EnableAllFolders: false, EnabledFolders: ['999'] } };
  views = { Items: [{ Id: 'lib-shows' }, { Id: 'some-grouped-view' }] };
  assert.deepEqual(await jf.getUserSectionIds!('', 'u2'), ['lib-shows'], 'unknown policy ids: the views stand in');
  views = { Items: [{ Id: 'some-grouped-view' }] };
  assert.equal(await jf.getUserSectionIds!('', 'u2'), null, 'nothing matches anywhere: cannot tell');
  user = { Id: 'u2', Policy: {} };
  assert.equal(await jf.getUserSectionIds!('', 'u2'), null);
}

/** Jellyfin Quick Connect, mapped to the shape of a password login; Emby has none. */
async function testJellyfinQuickConnect() {
  const { supportsQuickConnect } = await import('../server/adapters');
  let enabled = true;
  let authorized = false;
  const devices: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    devices.push(/DeviceId="([^"]*)"/.exec(auth)?.[1] ?? '');
    assert.match(auth, /Token=""/, 'no token is sent on any Quick Connect call');
    if (url.pathname === '/QuickConnect/Enabled') return Response.json(enabled);
    if (url.pathname === '/QuickConnect/Initiate') {
      assert.equal(init?.method, 'POST');
      if (!enabled) return new Response('"Quick connect is disabled"', { status: 401 });
      return Response.json({ Secret: 's3cr3t', Code: '123456', Authenticated: false });
    }
    if (url.pathname === '/QuickConnect/Connect') {
      if (url.searchParams.get('secret') !== 's3cr3t') return new Response('"Unknown secret"', { status: 404 });
      return Response.json({ Secret: 's3cr3t', Code: '123456', Authenticated: authorized });
    }
    if (url.pathname === '/Users/AuthenticateWithQuickConnect') {
      assert.deepEqual(JSON.parse(String(init?.body)), { Secret: 's3cr3t' });
      if (!authorized) return new Response('not authorized', { status: 401 });
      return Response.json({ User: { Id: 'u9', Name: 'robin', Policy: { IsAdministrator: true } }, AccessToken: 'qc-token' });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const jf = createAdapter('jellyfin', 'http://jf-qc:8096', 'admin-token');
  assert.ok(supportsQuickConnect(jf));
  assert.equal(await jf.quickConnectEnabled!(), true);
  const request = await jf.initiateQuickConnect!();
  assert.ok(request);
  assert.equal(request.code, '123456');
  assert.equal(request.secret, 's3cr3t');
  assert.notEqual(request.deviceId, 'watcharr-server', 'never the shared server device');
  assert.equal(await jf.quickConnectState!(request), 'pending');
  await assert.rejects(() => jf.authenticateQuickConnect!(request), 'not yet authorized');
  authorized = true;
  assert.equal(await jf.quickConnectState!(request), 'authorized');
  assert.deepEqual(await jf.authenticateQuickConnect!(request), {
    user: { serverUserId: 'u9', username: 'robin', isAdmin: true, avatarUrl: undefined },
    token: 'qc-token',
  });
  assert.equal(await jf.quickConnectState!({ ...request, secret: 'gone' }), 'expired');
  assert.ok(devices.slice(1).every((d) => d === request.deviceId), 'one device from initiation to token');
  const again = await jf.initiateQuickConnect!();
  assert.notEqual(again?.deviceId, request.deviceId, 'every sign-in its own device');

  enabled = false;
  assert.equal(await jf.quickConnectEnabled!(), false);
  assert.equal(await jf.initiateQuickConnect!(), null, 'switched off: not available, not an error');

  const emby = createAdapter('emby', 'http://emby-qc:8096', 'admin-token');
  assert.equal(supportsQuickConnect(emby), false);
  assert.equal(await emby.quickConnectEnabled!(), false);
  assert.equal(await emby.initiateQuickConnect!(), null);
  assert.equal(supportsQuickConnect(createAdapter('plex', 'http://plex-qc:32400', 't')), false);
}

/** Watchlist writes go to plex.tv by the global id; a local ratingKey is resolved first. */
async function testPlexWatchlistWrite() {
  const { supportsWatchlistWrite } = await import('../server/adapters');
  const { plexGlobalId } = await import('../server/adapters/plex');
  assert.equal(plexGlobalId('plex://movie/5d776825880197001ec967c6'), '5d776825880197001ec967c6');
  assert.equal(plexGlobalId('com.plexapp.agents.imdb://tt0083658?lang=en'), undefined);

  const calls: { method: string; url: string; token: string | null }[] = [];
  let fail = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get('X-Plex-Token');
    calls.push({ method: init?.method ?? 'GET', url: url.href, token });
    if (url.pathname === '/library/metadata/123') {
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: '123', title: 'Heat', type: 'movie', guid: 'plex://movie/5d776825880197001ec967c6' }] } });
    }
    if (url.pathname === '/library/metadata/456') {
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: '456', title: 'Ep', type: 'episode', guid: 'plex://episode/5d9c0000000000000000000a', grandparentGuid: 'plex://show/5d9c0000000000000000000b' }] } });
    }
    if (url.pathname === '/library/metadata/789') {
      return Response.json({ MediaContainer: { Metadata: [{ ratingKey: '789', title: 'Old', type: 'movie', guid: 'com.plexapp.agents.imdb://tt0113277?lang=en' }] } });
    }
    if (url.host === 'discover.provider.plex.tv') {
      if (fail) return new Response('nope', { status: 401 });
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const plex = createAdapter('plex', 'http://plex-watchlist:32400', 'admin-token');
  assert.ok(supportsWatchlistWrite(plex));
  assert.equal(supportsWatchlistWrite(createAdapter('jellyfin', 'http://jf:8096', 't')), false);

  await plex.addToWatchlist!('user-plex-tv-token', '123');
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.token]), [
    ['GET', 'http://plex-watchlist:32400/library/metadata/123', 'admin-token'],
    ['PUT', 'https://discover.provider.plex.tv/actions/addToWatchlist?ratingKey=5d776825880197001ec967c6', 'user-plex-tv-token'],
  ], 'resolved with the admin token, written with the user\'s plex.tv token');

  calls.length = 0;
  await plex.removeFromWatchlist!('user-plex-tv-token', '5d776825880197001ec967c6');
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ['PUT', 'https://discover.provider.plex.tv/actions/removeFromWatchlist?ratingKey=5d776825880197001ec967c6'],
  ], 'an id as getWatchlist reports it needs no lookup');

  calls.length = 0;
  await plex.addToWatchlist!('t', '456');
  assert.ok(calls[1].url.endsWith('ratingKey=5d9c0000000000000000000b'), 'an episode stands for its show');
  await plex.addToWatchlist!('t', 'plex://movie/5d776825880197001ec967c6');
  assert.ok(calls.at(-1)!.url.endsWith('ratingKey=5d776825880197001ec967c6'));

  await assert.rejects(() => plex.addToWatchlist!('t', '789'), /plex:\/\/ guid/, 'a legacy agent match cannot be listed');
  fail = true;
  await assert.rejects(() => plex.removeFromWatchlist!('t', '5d776825880197001ec967c6'), /401/, 'HTTP errors reach the caller');
}

async function main() {
  for (const test of [
  testUnauthorizedDetection,
  testEndpointAddress,
  testLibraryIsPaged,
  testPlexLibraryChanges,
  testPlexSignInRequiresServerAccess,
  testPlexFindsAnotherRoute,
  testJellyfinSessions,
  testJellyfinDirectPlayUsesSourceStreams,
  testJellyfinHistoryFiltersBySince,
  testJellyfinLibraryCounts,
  testPlexSessions,
  testPlexTranscodeReason,
  testPlexDirectPlay,
  testPlexHistoryUsesLocalAccountAndEnriches,
  testPlexListUsersReadsXml,
  testPlexPartialUserListIsNotComplete,
  testPlexEmptyFriendListIsNotComplete,
  testPlexSocketFiltersFrames,
  testPlexHistoryPagesAscending,
  testPlexHistoryLimitsLookups,
  testPlexHistoryIgnoredPageSize,
  testJellyfinHistoryPages,
  testJellyfinLibraryThrowsOnError,
  testJellyfinMixedLibraries,
  testPlexOwnerDetection,
  testUserSectionIds,
  testJellyfinQuickConnect,
  testPlexWatchlistWrite,
]) {
    await test();
    console.log(`ok - ${test.name}`);
  }
}

void main();
