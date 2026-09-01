import { createHash } from 'node:crypto';
import { apiFetch, joinUrl } from './http';
import { normalise } from '../net';
import type {
  AuthResult,
  HistoryEntry,
  LibraryItem,
  LibrarySection,
  PlayMethod,
  LoginCredentials,
  MediaServerAdapter,
  MediaServerUser,
  PlaybackSession,
  ServerType,
} from './types';

const CLIENT = 'Watcharr';
const VERSION = '0.1.0';

/**
 * Jellyfin and Emby tie an access token to the pair (Client, DeviceId). A single shared
 * device id therefore means every new login replaces the previous account's token: that
 * user's Watcharr session keeps working — it is stored locally — while every background
 * request on their behalf starts answering 401. One device per identity avoids it.
 */
const SERVER_DEVICE_ID = 'watcharr-server';

function deviceIdFor(identity: string): string {
  return `watcharr-${createHash('sha1').update(identity).digest('hex').slice(0, 16)}`;
}

type JfUser = {
  Id: string;
  Name: string;
  PrimaryImageTag?: string;
  Policy?: { IsAdministrator?: boolean };
};

type JfItem = {
  Id: string;
  Name: string;
  SeriesName?: string;
  Type?: string;
  ProductionYear?: number;
  Genres?: string[];
  RunTimeTicks?: number;
  DateCreated?: string;
  UserData?: { LastPlayedDate?: string };
  MediaSources?: JfMediaSource[];
};

type JfMediaStream = {
  Type?: string;
  Codec?: string;
  Width?: number;
  Height?: number;
  BitRate?: number;
  Channels?: number;
};

type JfMediaSource = {
  Size?: number;
  Container?: string;
  Bitrate?: number;
  MediaStreams?: JfMediaStream[];
};

type JfSession = {
  Id: string;
  UserId: string;
  UserName: string;
  Client?: string;
  DeviceName?: string;
  RemoteEndPoint?: string;
  NowPlayingItem?: JfItem & {
    RunTimeTicks?: number;
    Container?: string;
    MediaStreams?: JfMediaStream[];
  };
  PlayState?: { PositionTicks?: number; IsPaused?: boolean; PlayMethod?: string };
  LastPlaybackCheckIn?: string;
  LastActivityDate?: string;
  TranscodingInfo?: {
    Bitrate?: number;
    VideoCodec?: string;
    AudioCodec?: string;
    Container?: string;
    Width?: number;
    Height?: number;
    TranscodeReasons?: string[];
  };
};

const ticksToMs = (ticks?: number) => Math.round((ticks ?? 0) / 10_000);

/**
 * RemoteEndPoint is an endpoint, not an address: it carries the client's source port
 * ("10.0.0.5:52344", IPv6 bracketed as "[::1]:52344"). The port is noise on screen and
 * makes both the LAN check and the geo lookup miss, so only the address is kept.
 *
 * Reuses net.ts's normalise(), which additionally unwraps the IPv4-mapped IPv6 form
 * ("::ffff:10.0.0.5"): Jellyfin reports the same client in both notations depending on how
 * it was reached, and without unwrapping, one device becomes two rows in the address list.
 */
export function endpointAddress(value?: string): string | undefined {
  return normalise(value ?? '') || undefined;
}

/** Jellyfin reports "DirectPlay" / "DirectStream" / "Transcode". */
function toPlayMethod(value?: string): PlayMethod | undefined {
  const normalised = value?.toLowerCase();
  if (normalised === 'transcode') return 'transcode';
  if (normalised === 'directstream') return 'directstream';
  if (normalised === 'directplay') return 'directplay';
  return undefined;
}

/**
 * Jellyfin and Emby share the same API surface (Emby is the upstream of the Jellyfin fork).
 * Only the auth header name differs, so one implementation covers both.
 */
export class JellyfinAdapter implements MediaServerAdapter {
  constructor(
    readonly type: ServerType,
    private readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}

  private headers(token = this.adminToken, device = SERVER_DEVICE_ID): Record<string, string> {
    const auth = `MediaBrowser Client="${CLIENT}", Device="${CLIENT}", DeviceId="${device}", Version="${VERSION}", Token="${token}"`;
    return this.type === 'emby'
      ? { 'X-Emby-Authorization': auth, 'X-Emby-Token': token, 'Content-Type': 'application/json' }
      : { Authorization: auth, 'Content-Type': 'application/json' };
  }

  private url(path: string) {
    return joinUrl(this.baseUrl, path);
  }

  private toUser(u: JfUser): MediaServerUser {
    return {
      serverUserId: u.Id,
      username: u.Name,
      isAdmin: Boolean(u.Policy?.IsAdministrator),
      avatarUrl: u.PrimaryImageTag ? this.url(`/Users/${u.Id}/Images/Primary`) : undefined,
    };
  }

  async ping() {
    try {
      const info = await apiFetch<{ ServerName?: string; Version?: string }>(
        this.url('/System/Info'),
        { headers: this.headers() },
      );
      return { ok: true, serverName: info.ServerName, version: info.Version };
    } catch {
      return { ok: false };
    }
  }

  async login(credentials: LoginCredentials): Promise<AuthResult> {
    if (credentials.kind === 'token') {
      return { user: await this.getUser(credentials.token), token: credentials.token };
    }
    const res = await apiFetch<{ User: JfUser; AccessToken: string }>(
      this.url('/Users/AuthenticateByName'),
      {
        method: 'POST',
        // The device id is what the issued token gets bound to, so it has to be the
        // account's own — not a constant every account shares.
        headers: this.headers('', deviceIdFor(credentials.username)),
        body: JSON.stringify({ Username: credentials.username, Pw: credentials.password }),
      },
    );
    return { user: this.toUser(res.User), token: res.AccessToken };
  }

  async getUser(token: string): Promise<MediaServerUser> {
    const me = await apiFetch<JfUser>(this.url('/Users/Me'), { headers: this.headers(token) });
    return this.toUser(me);
  }

  async listUsers(): Promise<MediaServerUser[]> {
    const users = await apiFetch<JfUser[]>(this.url('/Users'), { headers: this.headers() });
    return users.map((u) => this.toUser(u));
  }

  async getSessions(token?: string): Promise<PlaybackSession[]> {
    // Server-wide listing needs the admin token; a user token only returns that user's sessions.
    const sessions = await apiFetch<JfSession[]>(this.url('/Sessions'), {
      headers: this.headers(token ?? this.adminToken),
    });
    return sessions
      .filter((s) => s.NowPlayingItem)
      .map((s) => {
        const item = s.NowPlayingItem!;
        const streams = item.MediaStreams ?? [];
        const video = streams.find((stream) => stream.Type === 'Video');
        const audio = streams.find((stream) => stream.Type === 'Audio');
        const subtitle = streams.find((stream) => stream.Type === 'Subtitle');
        const transcode = s.TranscodingInfo;
        const playMethod = toPlayMethod(s.PlayState?.PlayMethod) ?? (transcode ? 'transcode' : undefined);

        return {
          sessionKey: s.Id,
          serverUserId: s.UserId,
          username: s.UserName,
          itemId: item.Id,
          title: item.Name,
          grandparentTitle: item.SeriesName,
          mediaType: (item.Type ?? 'unknown').toLowerCase(),
          state: s.PlayState?.IsPaused ? ('paused' as const) : ('playing' as const),
          progressMs: ticksToMs(s.PlayState?.PositionTicks),
          durationMs: ticksToMs(item.RunTimeTicks),
          isTranscoding: playMethod === 'transcode',
          bandwidthKbps: transcode?.Bitrate
            ? Math.round(transcode.Bitrate / 1000)
            : video?.BitRate
              ? Math.round(video.BitRate / 1000)
              : undefined,
          clientName: s.Client,
          deviceName: s.DeviceName,
          playMethod,
          // While transcoding, the interesting codec is the one being delivered.
          videoCodec: (transcode?.VideoCodec ?? video?.Codec)?.toLowerCase(),
          audioCodec: (transcode?.AudioCodec ?? audio?.Codec)?.toLowerCase(),
          container: (transcode?.Container ?? item.Container)?.toLowerCase(),
          width: transcode?.Width ?? video?.Width,
          height: transcode?.Height ?? video?.Height,
          transcodeReason: transcode?.TranscodeReasons?.[0],
          audioChannels: audio?.Channels,
          subtitleCodec: subtitle?.Codec?.toLowerCase(),
          // MediaStreams describe the file; TranscodingInfo describes the delivery. Both
          // are reported so a transcode shows what it came from as well as what it became.
          sourceVideoCodec: video?.Codec?.toLowerCase(),
          sourceAudioCodec: audio?.Codec?.toLowerCase(),
          sourceContainer: item.Container?.toLowerCase(),
          sourceHeight: video?.Height,
          sourceBitrateKbps: video?.BitRate ? Math.round(video.BitRate / 1000) : undefined,
          terminateKey: s.Id,
          remoteAddress: endpointAddress(s.RemoteEndPoint),
          lastCheckInAt: s.LastPlaybackCheckIn
            ? new Date(s.LastPlaybackCheckIn)
            : s.LastActivityDate
              ? new Date(s.LastActivityDate)
              : undefined,
        };
      });
  }

  /**
   * The message is sent first: after Playing/Stop the client usually tears the session
   * down, and a message delivered to a gone session is never displayed.
   */
  async terminateSession(terminateKey: string, reason?: string): Promise<void> {
    const headers = { ...this.headers(), 'Content-Type': 'application/json' };
    if (reason) {
      await apiFetch<void>(this.url(`/Sessions/${encodeURIComponent(terminateKey)}/Message`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ Header: 'Playback stopped', Text: reason, TimeoutMs: 10_000 }),
      }).catch(() => {});
    }
    await apiFetch<void>(this.url(`/Sessions/${encodeURIComponent(terminateKey)}/Playing/Stop`), {
      method: 'POST',
      headers,
    });
  }

  /**
   * Jellyfin and Emby both expose /socket, authenticated with the same token as the REST
   * API. SessionsStart asks the server to push the session list on an interval and on
   * every change; the payload is ignored — see liveSocket() on the interface for why.
   */
  liveSocket(): { url: string; hello?: string } | null {
    const url = new URL(joinUrl(this.baseUrl, '/socket'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('api_key', this.adminToken);
    url.searchParams.set('deviceId', SERVER_DEVICE_ID);
    return {
      url: url.toString(),
      // "initial delay, interval" in milliseconds. The interval is a fallback heartbeat,
      // not the mechanism — changes arrive without waiting for it.
      hello: JSON.stringify({ MessageType: 'SessionsStart', Data: '0,1500' }),
    };
  }

  async getLibrary(): Promise<LibraryItem[]> {
    // One request per library rather than one for everything: without ParentId the response
    // carries no way back to the library an item came from, and the per-library statistics
    // need exactly that. The requests run in parallel, so it costs latency, not time.
    const sections = await this.getLibraries().catch(() => []);
    const sources = sections.length ? sections.map((s) => s.id) : [undefined];

    const pages = await Promise.all(
      sources.map(async (sectionId) => {
        const params = new URLSearchParams({
          Recursive: 'true',
          IncludeItemTypes: 'Movie,Series',
          // MediaSources carries file size and the video stream; UserData carries the
          // server's own last-played date, which reaches further back than watch_history.
          Fields: 'Genres,ProductionYear,MediaSources,UserData,DateCreated',
          SortBy: 'SortName',
          Limit: '5000',
        });
        if (sectionId) params.set('ParentId', sectionId);
        const res = await apiFetch<{ Items: JfItem[] }>(this.url(`/Items?${params}`), {
          headers: this.headers(),
        }).catch(() => ({ Items: [] as JfItem[] }));
        return res.Items.map((i) => {
          const source = i.MediaSources?.[0];
          const video = source?.MediaStreams?.find((stream) => stream.Type === 'Video');
          return {
            itemId: i.Id,
            title: i.Name,
            mediaType: (i.Type ?? 'unknown').toLowerCase(),
            year: i.ProductionYear,
            genres: i.Genres ?? [],
            posterUrl: this.posterUrl(i.Id),
            sectionId,
            fileSizeBytes: source?.Size,
            videoCodec: video?.Codec?.toLowerCase(),
            height: video?.Height,
            durationMs: i.RunTimeTicks ? ticksToMs(i.RunTimeTicks) : undefined,
            addedAt: i.DateCreated ? new Date(i.DateCreated) : undefined,
            lastPlayedAt: i.UserData?.LastPlayedDate
              ? new Date(i.UserData.LastPlayedDate)
              : undefined,
          };
        });
      }),
    );
    return pages.flat();
  }

  async getLibraries(): Promise<LibrarySection[]> {
    const folders = await apiFetch<{ Name: string; ItemId: string; CollectionType?: string }[]>(
      this.url('/Library/VirtualFolders'),
      { headers: this.headers() },
    );
    const wanted = folders.filter(
      (f) => f.CollectionType === 'movies' || f.CollectionType === 'tvshows',
    );

    // Counts come from separate requests per library: Jellyfin reports the total in the
    // paging metadata, so Limit=0 returns it without any items. A show library needs three
    // of them, because seasons and episodes are not implied by the series count.
    const countOf = async (parentId: string, type: string): Promise<number> => {
      const params = new URLSearchParams({
        Recursive: 'true',
        ParentId: parentId,
        IncludeItemTypes: type,
        Limit: '0',
        EnableTotalRecordCount: 'true',
      });
      const res = await apiFetch<{ TotalRecordCount?: number }>(this.url(`/Items?${params}`), {
        headers: this.headers(),
      }).catch(() => ({ TotalRecordCount: 0 }));
      return res.TotalRecordCount ?? 0;
    };

    return Promise.all(
      wanted.map(async (folder) => {
        const isMovies = folder.CollectionType === 'movies';
        const [itemCount, seasonCount, episodeCount] = await Promise.all([
          countOf(folder.ItemId, isMovies ? 'Movie' : 'Series'),
          isMovies ? Promise.resolve(undefined) : countOf(folder.ItemId, 'Season'),
          isMovies ? Promise.resolve(undefined) : countOf(folder.ItemId, 'Episode'),
        ]);
        return {
          id: folder.ItemId,
          name: folder.Name,
          mediaType: isMovies ? 'movie' : 'show',
          itemCount,
          seasonCount,
          episodeCount,
        };
      }),
    );
  }

  async getRecentlyAdded(limit: number, sectionId?: string): Promise<LibraryItem[]> {
    const params = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series',
      Fields: 'Genres,ProductionYear,DateCreated',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: String(limit),
    });
    if (sectionId) params.set('ParentId', sectionId);
    const res = await apiFetch<{ Items: JfItem[] }>(this.url(`/Items?${params}`), {
      headers: this.headers(),
    });
    return res.Items.map((i) => ({
      itemId: i.Id,
      title: i.Name,
      mediaType: (i.Type ?? 'unknown').toLowerCase(),
      year: i.ProductionYear,
      genres: i.Genres ?? [],
      posterUrl: this.posterUrl(i.Id),
      addedAt: i.DateCreated ? new Date(i.DateCreated) : undefined,
    }));
  }

  posterUrl(itemId: string): string {
    return this.url(`/Items/${itemId}/Images/Primary?maxHeight=450`);
  }

  async getHistory(token: string, serverUserId: string, since?: Date): Promise<HistoryEntry[]> {
    const params = new URLSearchParams({
      Recursive: 'true',
      IsPlayed: 'true',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Fields: 'Genres,ProductionYear,SeriesName',
      Limit: '500',
    });
    const res = await apiFetch<{ Items: JfItem[] }>(
      this.url(`/Users/${serverUserId}/Items?${params}`),
      { headers: this.headers(token) },
    );
    return res.Items.flatMap((i) => {
      const played = i.UserData?.LastPlayedDate ? new Date(i.UserData.LastPlayedDate) : null;
      if (!played || (since && played < since)) return [];
      return [
        {
          itemId: i.Id,
          title: i.Name,
          grandparentTitle: i.SeriesName,
          mediaType: (i.Type ?? 'unknown').toLowerCase(),
          year: i.ProductionYear,
          genres: i.Genres ?? [],
          watchedAt: played,
          durationMs: ticksToMs(i.RunTimeTicks),
        },
      ];
    });
  }
}
