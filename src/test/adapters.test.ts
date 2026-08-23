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

async function main() {
  for (const test of [
  testJellyfinSessions,
  testJellyfinDirectPlayUsesSourceStreams,
  testJellyfinHistoryFiltersBySince,
  testPlexSessions,
  testPlexDirectPlay,
]) {
    await test();
    console.log(`ok - ${test.name}`);
  }
}

void main();
