import { apiFetch, joinUrl } from './http';
import type {
  AuthResult,
  HistoryEntry,
  LibraryItem,
  LibrarySection,
  PlayMethod,
  LoginCredentials,
  MediaServerAdapter,
  MediaServerUser,
  PinAuthAdapter,
  PlaybackSession,
  ServerType,
  WatchlistEntry,
} from './types';

const PLEX_TV = 'https://plex.tv/api/v2';
const PLEX_METADATA = 'https://metadata.provider.plex.tv';
const PRODUCT = 'Watcharr';
const CLIENT_ID = 'watcharr-server';

type PlexStream = { streamType?: number; codec?: string; width?: number; height?: number };

type PlexMeta = {
  ratingKey: string;
  key?: string;
  title: string;
  grandparentTitle?: string;
  type?: string;
  year?: number;
  duration?: number;
  viewedAt?: number;
  addedAt?: number; // seconds since the epoch, like every other Plex timestamp
  viewOffset?: number;
  thumb?: string;
  accountID?: number;
  Genre?: { tag: string }[];
  User?: { id: string; title: string };
  Player?: { state?: string; title?: string; product?: string; address?: string; local?: boolean };
  Session?: { id?: string; bandwidth?: number };
  Media?: {
    container?: string;
    videoCodec?: string;
    audioCodec?: string;
    width?: number;
    height?: number;
    bitrate?: number;
    Part?: { decision?: string; Stream?: PlexStream[] }[];
  }[];
  TranscodeSession?: {
    videoDecision?: string;
    audioDecision?: string;
    container?: string;
    videoCodec?: string;
    audioCodec?: string;
    width?: number;
    height?: number;
    transcodeReason?: string;
  };
};

type PlexContainer = {
  MediaContainer: {
    Metadata?: PlexMeta[];
    totalSize?: number;
    size?: number;
    myPlexUsername?: string;
    friendlyName?: string;
    version?: string;
  };
};

export class PlexAdapter implements MediaServerAdapter, PinAuthAdapter {
  readonly type: ServerType = 'plex';

  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}

  private plexHeaders(token?: string): Record<string, string> {
    return {
      'X-Plex-Product': PRODUCT,
      'X-Plex-Version': '0.1.0',
      'X-Plex-Client-Identifier': CLIENT_ID,
      Accept: 'application/json',
      ...(token ? { 'X-Plex-Token': token } : {}),
    };
  }

  private server<T>(path: string, token = this.adminToken) {
    return apiFetch<T>(joinUrl(this.baseUrl, path), { headers: this.plexHeaders(token) });
  }

  async ping() {
    try {
      const res = await this.server<PlexContainer>('/');
      return {
        ok: true,
        serverName: res.MediaContainer.friendlyName,
        version: res.MediaContainer.version,
      };
    } catch {
      return { ok: false };
    }
  }

  /** Plex authenticates through the PIN flow; direct login only accepts an existing token. */
  async login(credentials: LoginCredentials): Promise<AuthResult> {
    if (credentials.kind !== 'token') {
      throw new Error('Plex requires the PIN based OAuth flow');
    }
    return { user: await this.getUser(credentials.token), token: credentials.token };
  }

  async startPinAuth() {
    const pin = await apiFetch<{ id: number; code: string }>(`${PLEX_TV}/pins?strong=true`, {
      method: 'POST',
      headers: this.plexHeaders(),
    });
    const params = new URLSearchParams({
      clientID: CLIENT_ID,
      code: pin.code,
      'context[device][product]': PRODUCT,
    });
    return {
      pinId: String(pin.id),
      code: pin.code,
      authUrl: `https://app.plex.tv/auth#?${params}`,
    };
  }

  async pollPinAuth(pinId: string): Promise<AuthResult | null> {
    const pin = await apiFetch<{ authToken: string | null }>(`${PLEX_TV}/pins/${pinId}`, {
      headers: this.plexHeaders(),
    });
    if (!pin.authToken) return null;
    return { user: await this.getUser(pin.authToken), token: pin.authToken };
  }

  async getUser(token: string): Promise<MediaServerUser> {
    const me = await apiFetch<{ id: number; username: string; email?: string; thumb?: string }>(
      `${PLEX_TV}/user`,
      { headers: this.plexHeaders(token) },
    );
    // ponytail: server ownership is derived from the root endpoint's myPlexUsername.
    // Swap for /api/v2/resources ownership check if shared-admin setups need it.
    const root = await this.server<PlexContainer>('/');
    return {
      serverUserId: String(me.id),
      username: me.username,
      email: me.email,
      avatarUrl: me.thumb,
      isAdmin: root.MediaContainer.myPlexUsername === me.username,
    };
  }

  async listUsers(): Promise<MediaServerUser[]> {
    const res = await apiFetch<{ MediaContainer: { User?: { id: number; title: string; email?: string; thumb?: string }[] } }>(
      'https://plex.tv/api/users?X-Plex-Token=' + encodeURIComponent(this.adminToken),
      { headers: this.plexHeaders(this.adminToken) },
    ).catch(() => ({ MediaContainer: { User: [] } }));
    return (res.MediaContainer.User ?? []).map((u) => ({
      serverUserId: String(u.id),
      username: u.title,
      email: u.email,
      avatarUrl: u.thumb,
      isAdmin: false,
    }));
  }

  async getSessions(): Promise<PlaybackSession[]> {
    const res = await this.server<PlexContainer>('/status/sessions');
    return (res.MediaContainer.Metadata ?? []).map((m) => {
      const media = m.Media?.[0];
      const part = media?.Part?.[0];
      const transcode = m.TranscodeSession;

      // Plex reports a decision per stream; "transcode" on either one means transcoding.
      let playMethod: PlayMethod | undefined;
      if (transcode) {
        playMethod =
          transcode.videoDecision === 'transcode' || transcode.audioDecision === 'transcode'
            ? 'transcode'
            : 'directstream';
      } else if (part?.decision) {
        playMethod = part.decision === 'directplay' ? 'directplay' : 'directstream';
      }

      return {
        sessionKey: String(m.ratingKey) + ':' + (m.User?.id ?? ''),
        serverUserId: m.User?.id ?? '',
        username: m.User?.title ?? 'unknown',
        itemId: m.ratingKey,
        title: m.title,
        grandparentTitle: m.grandparentTitle,
        mediaType: m.type ?? 'unknown',
        state: (m.Player?.state as PlaybackSession['state']) ?? 'playing',
        progressMs: m.viewOffset ?? 0,
        durationMs: m.duration ?? 0,
        isTranscoding: playMethod === 'transcode',
        bandwidthKbps: m.Session?.bandwidth,
        clientName: m.Player?.product,
        deviceName: m.Player?.title,
        playMethod,
        videoCodec: (transcode?.videoCodec ?? media?.videoCodec)?.toLowerCase(),
        audioCodec: (transcode?.audioCodec ?? media?.audioCodec)?.toLowerCase(),
        container: (transcode?.container ?? media?.container)?.toLowerCase(),
        width: transcode?.width ?? media?.width,
        height: transcode?.height ?? media?.height,
        transcodeReason: transcode?.transcodeReason,
        terminateKey: m.Session?.id,
        remoteAddress: m.Player?.address,
      };
    });
  }

  /**
   * Plex terminates by its own session id, which is unrelated to the sessionKey this
   * adapter reports — the latter has to stay stable across polls for the stored row.
   */
  async terminateSession(terminateKey: string, reason?: string): Promise<void> {
    const params = new URLSearchParams({ sessionId: terminateKey });
    if (reason) params.set('reason', reason);
    await this.server<void>(`/status/sessions/terminate?${params}`);
  }

  async getLibrary(): Promise<LibraryItem[]> {
    const sections = await this.server<{ MediaContainer: { Directory?: { key: string; type: string }[] } }>(
      '/library/sections',
    );
    const wanted = (sections.MediaContainer.Directory ?? []).filter(
      (d) => d.type === 'movie' || d.type === 'show',
    );
    const pages = await Promise.all(
      wanted.map((d) =>
        this.server<PlexContainer>(`/library/sections/${d.key}/all?X-Plex-Container-Size=5000`),
      ),
    );
    // ponytail: Plex omits genres in section listings; scoring falls back to year/type.
    // Fetch /library/metadata/{key} per item if genre-accurate suggestions matter.
    return pages.flatMap((page, index) =>
      (page.MediaContainer.Metadata ?? []).map((m) => ({
        itemId: m.ratingKey,
        title: m.title,
        mediaType: m.type ?? 'unknown',
        year: m.year,
        genres: (m.Genre ?? []).map((g) => g.tag),
        posterUrl: this.posterUrl(m.ratingKey),
        // The pages come back in the order the sections were requested in.
        sectionId: wanted[index].key,
      })),
    );
  }

  async getLibraries(): Promise<LibrarySection[]> {
    const sections = await this.server<{
      MediaContainer: { Directory?: { key: string; title: string; type: string }[] };
    }>('/library/sections');
    const wanted = (sections.MediaContainer.Directory ?? []).filter(
      (d) => d.type === 'movie' || d.type === 'show',
    );

    // Container-Size=0 returns no items, only the paging header with the total.
    return Promise.all(
      wanted.map(async (d) => {
        const page = await this.server<PlexContainer>(
          `/library/sections/${d.key}/all?X-Plex-Container-Size=0`,
        ).catch(() => ({ MediaContainer: {} }) as PlexContainer);
        return {
          id: d.key,
          name: d.title,
          mediaType: d.type,
          itemCount: page.MediaContainer.totalSize ?? page.MediaContainer.size ?? 0,
        };
      }),
    );
  }

  async getRecentlyAdded(limit: number, sectionId?: string): Promise<LibraryItem[]> {
    const path = sectionId
      ? `/library/sections/${encodeURIComponent(sectionId)}/recentlyAdded`
      : '/library/recentlyAdded';
    const page = await this.server<PlexContainer>(`${path}?X-Plex-Container-Size=${limit}`);
    return (page.MediaContainer.Metadata ?? []).map((m) => ({
      itemId: m.ratingKey,
      title: m.grandparentTitle ?? m.title,
      mediaType: m.type ?? 'unknown',
      year: m.year,
      genres: (m.Genre ?? []).map((g) => g.tag),
      posterUrl: this.posterUrl(m.ratingKey),
      addedAt: m.addedAt ? new Date(m.addedAt * 1000) : undefined,
    }));
  }

  posterUrl(itemId: string): string {
    // The token stays server-side: artwork is only fetched by the /api/art proxy.
    return joinUrl(this.baseUrl, `/library/metadata/${itemId}/thumb?X-Plex-Token=${this.adminToken}`);
  }

  async getHistory(_token: string, serverUserId: string, since?: Date): Promise<HistoryEntry[]> {
    const params = new URLSearchParams({
      accountID: serverUserId,
      sort: 'viewedAt:desc',
      'X-Plex-Container-Size': '500',
    });
    if (since) params.set('viewedAt>', String(Math.floor(since.getTime() / 1000)));
    // History is only exposed to the server owner token, not to individual user tokens.
    const res = await this.server<PlexContainer>(`/status/sessions/history/all?${params}`);
    return (res.MediaContainer.Metadata ?? []).map((m) => ({
      itemId: m.ratingKey,
      title: m.title,
      grandparentTitle: m.grandparentTitle,
      mediaType: m.type ?? 'unknown',
      year: m.year,
      genres: (m.Genre ?? []).map((g) => g.tag),
      watchedAt: new Date((m.viewedAt ?? 0) * 1000),
      durationMs: m.duration ?? 0,
    }));
  }

  async getWatchlist(token: string): Promise<WatchlistEntry[]> {
    const res = await apiFetch<PlexContainer>(
      `${PLEX_METADATA}/library/sections/watchlist/all`,
      { headers: this.plexHeaders(token) },
    );
    return (res.MediaContainer.Metadata ?? []).map((m) => ({
      itemId: m.ratingKey,
      title: m.title,
      mediaType: m.type ?? 'unknown',
      year: m.year,
      posterUrl: m.thumb,
    }));
  }
}
