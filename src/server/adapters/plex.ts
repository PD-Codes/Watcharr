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
/** Items per library request, and the ceiling that keeps a runaway server from filling memory. */
const LIBRARY_PAGE = 5000;
const MAX_LIBRARY_ITEMS = 200_000;

// Plex numbers stream types: 1 = video, 2 = audio, 3 = subtitle.
type PlexStream = {
  streamType?: number;
  codec?: string;
  width?: number;
  height?: number;
  channels?: number;
  bitrate?: number;
};

type PlexMeta = {
  ratingKey: string;
  key?: string;
  title: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  type?: string;
  year?: number;
  duration?: number;
  viewedAt?: number;
  lastViewedAt?: number; // seconds since the epoch, like every other Plex timestamp
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
    audioChannels?: number;
    width?: number;
    height?: number;
    bitrate?: number;
    duration?: number;
    Part?: { decision?: string; size?: number; Stream?: PlexStream[] }[];
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
    machineIdentifier?: string;
    version?: string;
    Account?: { id: number | string; name?: string }[];
  };
};

type PlexDetails = { durationMs: number; year?: number; genres: string[] };

// Process-wide on purpose: adapters are rebuilt on every call, these answers are not.
const ACCOUNT_TTL_MS = 10 * 60_000;
const accountCache = new Map<string, { at: number; accounts: { id: string; name: string }[] }>();
const MAX_DETAILS = 5_000;
const detailCache = new Map<string, PlexDetails>();
const DETAIL_CONCURRENCY = 6;
const HISTORY_LIMIT = 500;

/** Plex hands out XML for its v1 endpoints whatever Accept says; read the few attributes needed. */
function parseUsersXml(xml: string) {
  const users: { id: string; title: string; email?: string; thumb?: string }[] = [];
  for (const tag of xml.match(/<User\b[^>]*>/g) ?? []) {
    const attr = (name: string) =>
      tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const id = attr('id');
    const title = attr('title') ?? attr('username');
    if (id && title) users.push({ id, title, email: attr('email') || undefined, thumb: attr('thumb') || undefined });
  }
  return users;
}

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
    const pin = await apiFetch<{ authToken: string | null }>(`${PLEX_TV}/pins/${encodeURIComponent(pinId)}`, {
      headers: this.plexHeaders(),
    });
    if (!pin.authToken) return null;
    return { user: await this.getUser(pin.authToken), token: pin.authToken };
  }

  async getUser(token: string): Promise<MediaServerUser> {
    const me = await apiFetch<{ id: number; username: string; title?: string; email?: string; thumb?: string }>(
      `${PLEX_TV}/user`,
      { headers: this.plexHeaders(token) },
    );
    const [root, resources] = await Promise.all([
      this.server<PlexContainer>('/'),
      apiFetch<{ clientIdentifier?: string; owned?: boolean }[]>(`${PLEX_TV}/resources?includeHttps=1&includeRelay=1`, {
        headers: this.plexHeaders(token),
      }),
    ]);
    // plex.tv issues a valid token to every Plex account there is, so a valid token proves
    // nothing about this server. Only an account that plex.tv lists this server for may sign
    // in; everyone else would otherwise browse the library through this app's admin token.
    const machineId = root.MediaContainer.machineIdentifier;
    if (!machineId || !Array.isArray(resources) || !resources.some((r) => r.clientIdentifier === machineId)) {
      throw Object.assign(new Error('This Plex account has no access to the server'), { status: 403 });
    }
    // Ownership comes from plex.tv itself: the resource entry of this very server carries
    // `owned: true` for the account the server is claimed by. The name comparison that used to
    // be the only test fails whenever the two spellings differ (case, an email instead of a
    // username, an account whose `username` is empty), so it is kept as a fallback, loosely.
    const entry = resources.find((r) => r.clientIdentifier === machineId);
    const owner = root.MediaContainer.myPlexUsername?.trim().toLowerCase();
    const names = [me.username, me.email, me.title].map((n) => n?.trim().toLowerCase());
    return {
      serverUserId: String(me.id),
      username: me.username,
      email: me.email,
      avatarUrl: me.thumb,
      isAdmin: entry?.owned === true || (!!owner && names.includes(owner)),
    };
  }

  async listUsers(): Promise<MediaServerUser[]> {
    // Friends come from plex.tv. The endpoint answers XML (JSON when a future version learns
    // it), so the body is read as text and either shape is accepted.
    const friends = await fetch(`https://plex.tv/api/users?X-Plex-Token=${encodeURIComponent(this.adminToken)}`, {
      headers: this.plexHeaders(this.adminToken),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
      .then(async (res) => {
        if (!res.ok) return [];
        const text = await res.text();
        if (text.trimStart().startsWith('{')) {
          const json = JSON.parse(text) as { MediaContainer?: { User?: { id: number; title: string; email?: string; thumb?: string }[] } };
          return (json.MediaContainer?.User ?? []).map((u) => ({ ...u, id: String(u.id) }));
        }
        return parseUsersXml(text);
      })
      .catch(() => []);

    // No friends list (token without plex.tv rights, plex.tv down): the server's own account
    // table still names everybody who has used it. Id 1 is the owner and 0 the system account.
    const named = friends.length
      ? friends
      : (await this.accounts()).filter((a) => a.id !== '0' && a.id !== '1').map((a) => ({ id: a.id, title: a.name }));

    // The owner is not part of their own friends list, and without them a "sync users" would
    // never contain the one account that is an admin.
    const owner = await apiFetch<{ id: number; username?: string; title?: string; email?: string; thumb?: string }>(
      `${PLEX_TV}/user`,
      { headers: this.plexHeaders(this.adminToken) },
    ).catch(() => null);

    const list: MediaServerUser[] = named.map((u) => ({
      serverUserId: String(u.id),
      username: u.title,
      email: (u as { email?: string }).email,
      avatarUrl: (u as { thumb?: string }).thumb,
      isAdmin: false,
    }));
    if (owner && !list.some((u) => u.serverUserId === String(owner.id))) {
      list.unshift({
        serverUserId: String(owner.id),
        username: owner.username || owner.title || 'owner',
        email: owner.email,
        avatarUrl: owner.thumb,
        isAdmin: true,
      });
    }
    return list;
  }

  /** The server's own account table: id 1 is the owner, the rest carry their plex.tv ids. */
  private async accounts(): Promise<{ id: string; name: string }[]> {
    const hit = accountCache.get(this.baseUrl);
    if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.accounts;
    const res = await this.server<PlexContainer>('/accounts').catch(() => null);
    const accounts = (res?.MediaContainer.Account ?? []).map((a) => ({ id: String(a.id), name: a.name ?? '' }));
    // An empty answer is not cached, so a hiccup does not hide everybody for ten minutes.
    if (accounts.length) accountCache.set(this.baseUrl, { at: Date.now(), accounts });
    return accounts;
  }

  /**
   * The id the server itself uses for this person. Sessions and history speak the local
   * account id, which only equals the plex.tv id for shared users — the owner is 1 — so the
   * plex.tv id alone would find no history for exactly the person who set the server up.
   */
  private async localAccountId(serverUserId: string, username?: string): Promise<string> {
    const accounts = await this.accounts();
    if (accounts.some((a) => a.id === serverUserId)) return serverUserId;
    const wanted = username?.trim().toLowerCase();
    return (wanted && accounts.find((a) => a.name.trim().toLowerCase() === wanted)?.id) || serverUserId;
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
        audioChannels: media?.audioChannels,
        subtitleCodec: part?.Stream?.find((stream) => stream.streamType === 3)?.codec?.toLowerCase(),
        // Media/Part describe the file, TranscodeSession the delivery. Reporting both is
        // what lets a stream panel show "HEVC 4K → H264 1080p" instead of half of it.
        sourceVideoCodec: media?.videoCodec?.toLowerCase(),
        sourceAudioCodec: media?.audioCodec?.toLowerCase(),
        sourceContainer: media?.container?.toLowerCase(),
        sourceHeight: media?.height,
        sourceBitrateKbps: media?.bitrate,
        terminateKey: m.Session?.id,
        remoteAddress: m.Player?.address,
      };
    });
  }

  /**
   * Plex terminates by its own session id, which is unrelated to the sessionKey this
   * adapter reports — the latter has to stay stable across polls for the stored row.
   */
  /**
   * Plex pushes PlaySessionStateNotification and a dozen other event types over this
   * socket. None of them are parsed — the arrival is the signal, and the session list is
   * then read the normal way. No hello frame: Plex starts sending on connect.
   */
  liveSocket(): { url: string; hello?: string; relevant: (frame: string) => boolean } | null {
    const url = new URL(joinUrl(this.baseUrl, '/:/websockets/notifications'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('X-Plex-Token', this.adminToken);
    // Playback frames only ("playing", and transcode updates, which move bandwidth and
    // decisions). Library scans, timeline and activity frames arrive in bursts that would
    // each trigger a full session read for nothing. An unreadable frame counts as relevant.
    const relevant = (frame: string) => {
      try {
        const type = (JSON.parse(frame) as { NotificationContainer?: { type?: string } }).NotificationContainer?.type;
        return !type || type === 'playing' || type.startsWith('transcodeSession');
      } catch {
        return true;
      }
    };
    return { url: url.toString(), relevant };
  }

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
    // Paged: a single capped request would silently drop everything past the cap from
    // search, the library table and the "never started" list.
    const pages = await Promise.all(
      wanted.map(async (d) => {
        const Metadata: PlexMeta[] = [];
        for (let start = 0; start < MAX_LIBRARY_ITEMS; start += LIBRARY_PAGE) {
          const page = await this.server<PlexContainer>(
            `/library/sections/${d.key}/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${LIBRARY_PAGE}`,
          );
          const batch = page.MediaContainer.Metadata ?? [];
          Metadata.push(...batch);
          if (batch.length < LIBRARY_PAGE) break;
        }
        return { MediaContainer: { Metadata } } as PlexContainer;
      }),
    );
    // ponytail: Plex omits genres in section listings; scoring falls back to year/type.
    // Fetch /library/metadata/{key} per item if genre-accurate suggestions matter.
    return pages.flatMap((page, index) =>
      (page.MediaContainer.Metadata ?? []).map((m) => {
        const media = m.Media?.[0];
        return {
          itemId: m.ratingKey,
          title: m.title,
          mediaType: m.type ?? 'unknown',
          year: m.year,
          genres: (m.Genre ?? []).map((g) => g.tag),
          posterUrl: this.posterUrl(m.ratingKey),
          // The pages come back in the order the sections were requested in.
          sectionId: wanted[index].key,
          // Shows have no Media block of their own — only their episodes do — so these
          // stay undefined there rather than reporting a misleading zero.
          fileSizeBytes: media?.Part?.[0]?.size,
          videoCodec: media?.videoCodec?.toLowerCase(),
          height: media?.height,
          durationMs: media?.duration ?? m.duration,
          addedAt: m.addedAt ? new Date(m.addedAt * 1000) : undefined,
          lastPlayedAt: m.lastViewedAt ? new Date(m.lastViewedAt * 1000) : undefined,
        };
      }),
    );
  }

  async getLibraries(): Promise<LibrarySection[]> {
    const sections = await this.server<{
      MediaContainer: { Directory?: { key: string; title: string; type: string }[] };
    }>('/library/sections');
    const wanted = (sections.MediaContainer.Directory ?? []).filter(
      (d) => d.type === 'movie' || d.type === 'show',
    );

    // Container-Size=0 returns no items, only the paging header with the total. Plex
    // numbers its metadata types: 2 = show, 3 = season, 4 = episode — asking for a type
    // is what makes seasons and episodes countable inside a show library.
    const countOf = async (key: string, type?: number): Promise<number> => {
      const query = `X-Plex-Container-Size=0${type ? `&type=${type}` : ''}`;
      const page = await this.server<PlexContainer>(
        `/library/sections/${key}/all?${query}`,
      ).catch(() => ({ MediaContainer: {} }) as PlexContainer);
      return page.MediaContainer.totalSize ?? page.MediaContainer.size ?? 0;
    };

    return Promise.all(
      wanted.map(async (d) => {
        const isShow = d.type === 'show';
        const [itemCount, seasonCount, episodeCount] = await Promise.all([
          countOf(d.key),
          isShow ? countOf(d.key, 3) : Promise.resolve(undefined),
          isShow ? countOf(d.key, 4) : Promise.resolve(undefined),
        ]);
        return { id: d.key, name: d.title, mediaType: d.type, itemCount, seasonCount, episodeCount };
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

  async getHistory(_token: string, serverUserId: string, since?: Date, username?: string): Promise<HistoryEntry[]> {
    const params = new URLSearchParams({
      accountID: await this.localAccountId(serverUserId, username),
      sort: 'viewedAt:desc',
      'X-Plex-Container-Start': '0',
      'X-Plex-Container-Size': String(HISTORY_LIMIT),
    });
    if (since) params.set('viewedAt>', String(Math.floor(since.getTime() / 1000)));
    // History is only exposed to the server owner token, not to individual user tokens.
    const res = await this.server<PlexContainer>(`/status/sessions/history/all?${params}`);
    // Newest first. Cut here as well as in the request: an answer that ignores the page size
    // would otherwise bring the whole history through the metadata lookups below.
    const rows = (res.MediaContainer.Metadata ?? []).filter((m) => m.viewedAt).slice(0, HISTORY_LIMIT);
    const details = await this.details(rows);
    return rows.map((m) => {
      const own = details.get(m.ratingKey);
      // Episodes carry their genres on the show, not on themselves.
      const show = m.grandparentRatingKey ? details.get(m.grandparentRatingKey) : undefined;
      return {
        itemId: m.ratingKey,
        title: m.title,
        grandparentTitle: m.grandparentTitle,
        mediaType: m.type ?? 'unknown',
        year: m.year ?? own?.year,
        genres: (m.Genre ?? []).map((g) => g.tag).concat(show?.genres ?? own?.genres ?? []).filter((g, i, all) => all.indexOf(g) === i),
        watchedAt: new Date((m.viewedAt ?? 0) * 1000),
        durationMs: m.duration ?? own?.durationMs ?? 0,
      };
    });
  }

  /**
   * The history listing names what was watched but not how long it is or what genre it
   * belongs to, and watch time is computed from exactly that. One metadata read per distinct
   * title, cached, a few at a time; a title the library no longer has is simply left bare.
   */
  private async details(rows: PlexMeta[]): Promise<Map<string, PlexDetails>> {
    const keys = new Set<string>();
    for (const m of rows) {
      keys.add(m.ratingKey);
      if (m.grandparentRatingKey) keys.add(m.grandparentRatingKey);
    }
    const found = new Map<string, PlexDetails>();
    const todo: string[] = [];
    for (const key of keys) {
      const cached = detailCache.get(`${this.baseUrl}|${key}`);
      if (cached) found.set(key, cached);
      else todo.push(key);
    }
    const work = async () => {
      for (let key = todo.pop(); key; key = todo.pop()) {
        const res = await apiFetch<PlexContainer>(joinUrl(this.baseUrl, `/library/metadata/${encodeURIComponent(key)}`), {
          headers: this.plexHeaders(this.adminToken),
          timeoutMs: 4_000,
        }).catch(() => null);
        const meta = res?.MediaContainer.Metadata?.[0];
        if (!meta) continue;
        const entry = {
          durationMs: meta.duration ?? meta.Media?.[0]?.duration ?? 0,
          year: meta.year,
          genres: (meta.Genre ?? []).map((g) => g.tag),
        };
        if (detailCache.size >= MAX_DETAILS) detailCache.clear();
        detailCache.set(`${this.baseUrl}|${key}`, entry);
        found.set(key, entry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, todo.length) }, work));
    return found;
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
