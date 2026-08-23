import { apiFetch, joinUrl } from './http';
import type {
  AuthResult,
  HistoryEntry,
  LibraryItem,
  PlayMethod,
  LoginCredentials,
  MediaServerAdapter,
  MediaServerUser,
  PlaybackSession,
  ServerType,
} from './types';

const CLIENT = 'Watcharr';
const DEVICE_ID = 'watcharr-server';
const VERSION = '0.1.0';

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
  UserData?: { LastPlayedDate?: string };
};

type JfMediaStream = {
  Type?: string;
  Codec?: string;
  Width?: number;
  Height?: number;
  BitRate?: number;
};

type JfSession = {
  Id: string;
  UserId: string;
  UserName: string;
  Client?: string;
  DeviceName?: string;
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

  private headers(token = this.adminToken): Record<string, string> {
    const auth = `MediaBrowser Client="${CLIENT}", Device="${CLIENT}", DeviceId="${DEVICE_ID}", Version="${VERSION}", Token="${token}"`;
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
        headers: this.headers(''),
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
          lastCheckInAt: s.LastPlaybackCheckIn
            ? new Date(s.LastPlaybackCheckIn)
            : s.LastActivityDate
              ? new Date(s.LastActivityDate)
              : undefined,
        };
      });
  }

  async getLibrary(): Promise<LibraryItem[]> {
    const params = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series',
      Fields: 'Genres,ProductionYear',
      SortBy: 'SortName',
      Limit: '5000',
    });
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
