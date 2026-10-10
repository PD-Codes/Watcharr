import assert from 'node:assert/strict';
import { createAdapter } from '../server/adapters';

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

  const history = await createAdapter('emby', 'http://emby:8096', 'tok').getHistory(
    'tok',
    'u1',
    new Date('2025-01-01T00:00:00Z'),
  );
  assert.deepEqual(history.map((h) => h.itemId), ['b']);
  assert.deepEqual(history[0].genres, ['Comedy']);
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
            TranscodeSession: { videoDecision: 'transcode', audioDecision: 'copy', container: 'mkv' },
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
  assert.equal(session.videoCodec, 'h264');
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
  const rows = await plex.getHistory('tok', '987654', undefined, 'owner');
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

async function main() {
  for (const test of [
  testUnauthorizedDetection,
  testEndpointAddress,
  testLibraryIsPaged,
  testPlexSignInRequiresServerAccess,
  testJellyfinSessions,
  testJellyfinDirectPlayUsesSourceStreams,
  testJellyfinHistoryFiltersBySince,
  testJellyfinLibraryCounts,
  testPlexSessions,
  testPlexDirectPlay,
  testPlexHistoryUsesLocalAccountAndEnriches,
  testPlexListUsersReadsXml,
  testPlexSocketFiltersFrames,
]) {
    await test();
    console.log(`ok - ${test.name}`);
  }
}

void main();
