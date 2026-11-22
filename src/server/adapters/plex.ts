import { apiFetch, joinUrl } from './http';
import { isStrained } from '../strain';
import { findPlexRoute, isUnreachable, plexRoute, routeIsStale } from './plexroute';
import { trimTrailingInstant } from './paging';
import type {
  AuthResult,
  HistoryPage,
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
/** Watchlist writes; python-plexapi's MyPlexAccount.addToWatchlist uses the same host. */
const PLEX_DISCOVER = 'https://discover.provider.plex.tv';
const PRODUCT = 'Watcharr';
const CLIENT_ID = 'watcharr-server';
/**
 * plex.tv calls in the sign-in path. /resources lists every server an account can see and
 * regularly needs well over the default 8 s for accounts with many shared servers, which made
 * the login fail on every poll for exactly those people.
 */
const PLEX_TV_AUTH_TIMEOUT_MS = 25_000;
/** Items per library request, and the ceiling that keeps a runaway server from filling memory. */
// 1000, not 5000: Plex builds a page with full media info in one go, and a 5000-item page of a
// large movie library took long enough to look like an overloaded server.
const LIBRARY_PAGE = 1000;
const MAX_LIBRARY_ITEMS = 200_000;
/** Delta sync: changed items per page, and the point from which a full listing is cheaper. */
const DELTA_PAGE = 200;
const MAX_DELTA_ITEMS = 2000;

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
  guid?: string;
  parentGuid?: string;
  grandparentGuid?: string;
  title: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  type?: string;
  year?: number;
  duration?: number;
  viewedAt?: number;
  lastViewedAt?: number; // seconds since the epoch, like every other Plex timestamp
  addedAt?: number; // seconds since the epoch, like every other Plex timestamp
  updatedAt?: number;
  viewOffset?: number;
  thumb?: string;
  accountID?: number;
  Genre?: { tag: string }[];
  User?: { id: string; title: string };
  Player?: { state?: string; title?: string; product?: string; address?: string; local?: boolean; machineIdentifier?: string };
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
    subtitleDecision?: string;
    sourceVideoCodec?: string;
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

/**
 * Plex's session API carries no transcode reason (the web UI works it out client-side), so
 * derive one from the decisions and the source/delivery difference. Tokens match the ones
 * Jellyfin reports so both servers land in the same bucket of the reasons chart. Only the
 * first cause is returned, like the Jellyfin adapter does.
 */
export function plexTranscodeReason(
  transcode: NonNullable<PlexMeta['TranscodeSession']>,
  media?: NonNullable<PlexMeta['Media']>[number],
): string | undefined {
  if (transcode.transcodeReason) return transcode.transcodeReason;
  if (transcode.videoDecision === 'transcode') {
    const source = (transcode.sourceVideoCodec ?? media?.videoCodec)?.toLowerCase();
    if (source && transcode.videoCodec && source !== transcode.videoCodec.toLowerCase()) {
      return 'VideoCodecNotSupported';
    }
    if (transcode.height && media?.height && transcode.height < media.height) {
      return 'VideoResolutionNotSupported';
    }
    return 'ContainerBitrateExceedsLimit';
  }
  if (transcode.audioDecision === 'transcode') return 'AudioCodecNotSupported';
  if (transcode.subtitleDecision === 'burn') return 'SubtitleCodecNotSupported';
  if (transcode.container && media?.container && transcode.container.toLowerCase() !== media.container.toLowerCase()) {
    return 'ContainerNotSupported';
  }
  return undefined;
}

type PlexDetails = { durationMs: number; year?: number; genres: string[] };

// Process-wide on purpose: adapters are rebuilt on every call, these answers are not.
const ACCOUNT_TTL_MS = 10 * 60_000;
const accountCache = new Map<string, { at: number; accounts: { id: string; name: string }[] }>();
const MAX_DETAILS = 5_000;
const detailCache = new Map<string, PlexDetails>();
const DETAIL_CONCURRENCY = 6;
/** History rows per request, requests per call, and uncached metadata reads per call. */
const HISTORY_PAGE = 500;
const HISTORY_PAGES = 10;
const MAX_HISTORY_LOOKUPS = 600;

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

/** The sections getLibraries() reports; getUserSectionIds() answers within the same set. */
const listedSection = (d: { type: string }) => d.type === 'movie' || d.type === 'show' || d.type === 'artist';

/**
 * The global Plex id a watchlist entry is keyed by, from a plex:// guid
 * ("plex://movie/5d776825880197001ec967c6" → "5d776825880197001ec967c6"). Undefined for the
 * guids of legacy agents (com.plexapp.agents.imdb://…), which plex.tv's watchlist cannot use.
 */
export function plexGlobalId(guid: string | undefined): string | undefined {
  const match = /^plex:\/\/[a-z]+\/([0-9a-f]+)$/i.exec(guid ?? '');
  return match?.[1];
}

export class PlexAdapter implements MediaServerAdapter, PinAuthAdapter {
  readonly type: ServerType = 'plex';

  constructor(
    private readonly configuredUrl: string,
    private readonly adminToken: string,
  ) {}

  /** Where requests go: the configured URL, or the detour plexroute.ts found to the same server. */
  private get baseUrl(): string {
    return plexRoute(this.configuredUrl);
  }

  private plexHeaders(token?: string): Record<string, string> {
    return {
      'X-Plex-Product': PRODUCT,
      'X-Plex-Version': '0.1.0',
      'X-Plex-Client-Identifier': CLIENT_ID,
      Accept: 'application/json',
      ...(token ? { 'X-Plex-Token': token } : {}),
    };
  }

  private async server<T>(path: string, token = this.adminToken, bulk = false): Promise<T> {
    const base = this.baseUrl;
    // A detour is not forever: now and then look again, in the background, for the URL the
    // admin actually entered (a router that learned NAT loopback, a corrected address).
    if (routeIsStale(this.configuredUrl)) void findPlexRoute(this.configuredUrl, this.plexHeaders(this.adminToken));
    try {
      return await apiFetch<T>(joinUrl(base, path), { headers: this.plexHeaders(token), bulk });
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      // Never reached the server: ask plex.tv how else to get there and try once more.
      const next = await findPlexRoute(this.configuredUrl, this.plexHeaders(this.adminToken));
      if (!next || next === base) throw error;
      return apiFetch<T>(joinUrl(next, path), { headers: this.plexHeaders(token), bulk });
    }
  }

  async ping() {
    try {
      const res = await this.server<PlexContainer>('/');
      return {
        ok: true,
        serverName: res.MediaContainer.friendlyName,
        version: res.MediaContainer.version,
        machineIdentifier: res.MediaContainer.machineIdentifier,
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

  async startPinAuth(forwardUrl?: (pinId: string) => string) {
    const pin = await apiFetch<{ id: number; code: string }>(`${PLEX_TV}/pins?strong=true`, {
      method: 'POST',
      headers: this.plexHeaders(),
    });
    const params = new URLSearchParams({
      clientID: CLIENT_ID,
      code: pin.code,
      'context[device][product]': PRODUCT,
    });
    // Without it the plex.tv tab just stays open after approval (and on a phone the first tab
    // sleeps in the background), so the browser is sent back to a page that finishes the login.
    if (forwardUrl) params.set('forwardUrl', forwardUrl(String(pin.id)));
    return {
      pinId: String(pin.id),
      code: pin.code,
      authUrl: `https://app.plex.tv/auth#?${params}`,
    };
  }

  async pollPinAuth(pinId: string): Promise<AuthResult | null> {
    const pin = await apiFetch<{ authToken: string | null }>(`${PLEX_TV}/pins/${encodeURIComponent(pinId)}`, {
      headers: this.plexHeaders(),
      timeoutMs: PLEX_TV_AUTH_TIMEOUT_MS,
    });
    if (!pin.authToken) return null;
    return { user: await this.getUser(pin.authToken), token: pin.authToken };
  }

  async getUser(token: string): Promise<MediaServerUser> {
    // All three at once: one after the other they added up past what the login poll waits.
    // /resources without includeHttps/includeRelay: only clientIdentifier and owned are read,
    // and the extra connection entries make plex.tv's slowest endpoint slower still.
    const [me, root, resources] = await Promise.all([
      apiFetch<{ id: number; username: string; title?: string; email?: string; thumb?: string }>(`${PLEX_TV}/user`, {
        headers: this.plexHeaders(token),
        timeoutMs: PLEX_TV_AUTH_TIMEOUT_MS,
      }),
      this.server<PlexContainer>('/'),
      apiFetch<{ clientIdentifier?: string; owned?: boolean }[]>(`${PLEX_TV}/resources`, {
        headers: this.plexHeaders(token),
        timeoutMs: PLEX_TV_AUTH_TIMEOUT_MS,
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
    // be the only test stays as a fallback (an entry without the flag, or one plex.tv got
    // wrong): matching the account the server itself is signed into is ownership by definition,
    // as long as only identifiers no other account can hold are compared. Despite its name,
    // myPlexUsername is usually the owner's email (python-plexapi documents it as such), so
    // both username and email are compared, case-insensitively. Never `title`: that is a free
    // display name (a Plex Home profile name, for one), and anybody with access could set it to
    // the owner's email or username and be made an admin of this app.
    const entry = resources.find((r) => r.clientIdentifier === machineId);
    const owner = root.MediaContainer.myPlexUsername?.trim().toLowerCase();
    const names = [me.username, me.email].map((n) => n?.trim().toLowerCase()).filter(Boolean);
    return {
      serverUserId: String(me.id),
      username: me.username,
      email: me.email,
      avatarUrl: me.thumb,
      isAdmin: entry?.owned === true || (!!owner && names.includes(owner)),
    };
  }

  async listUsers(): Promise<MediaServerUser[]> {
    return (await this.listUsersWithCompleteness()).users;
  }

  /**
   * The user list plus whether it is the whole picture. When plex.tv does not answer, the list
   * below falls back to the server's account table, which only names people who have streamed
   * and therefore must not be read as "everybody else lost access" (userroster.ts).
   */
  async listUsersWithCompleteness(): Promise<{ users: MediaServerUser[]; complete: boolean }> {
    // Friends come from plex.tv. The endpoint answers XML (JSON when a future version learns
    // it), so the body is read as text and either shape is accepted.
    let friendsLoaded = false;
    const friends = await fetch(`https://plex.tv/api/users?X-Plex-Token=${encodeURIComponent(this.adminToken)}`, {
      headers: this.plexHeaders(this.adminToken),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
      .then(async (res) => {
        if (!res.ok) return [];
        const text = await res.text();
        const parsed = text.trimStart().startsWith('{')
          ? ((JSON.parse(text) as { MediaContainer?: { User?: { id: number; title: string; email?: string; thumb?: string }[] } })
              .MediaContainer?.User ?? []
            ).map((u) => ({ ...u, id: String(u.id) }))
          : parseUsersXml(text);
        friendsLoaded = true;
        return parsed;
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
    // Complete only with a friends list from plex.tv that names somebody. An empty answer is
    // indistinguishable from a token that lost its plex.tv rights, and the /accounts fallback
    // above only names people who have streamed; either read as complete would sign out every
    // shared user the list happens to miss.
    return { users: list, complete: friendsLoaded && friends.length > 0 && owner !== null };
  }

  /** The server's own account table: id 1 is the owner, the rest carry their plex.tv ids. */
  private async accounts(): Promise<{ id: string; name: string }[]> {
    const hit = accountCache.get(this.configuredUrl);
    if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.accounts;
    const res = await this.server<PlexContainer>('/accounts').catch(() => null);
    const accounts = (res?.MediaContainer.Account ?? []).map((a) => ({ id: String(a.id), name: a.name ?? '' }));
    // An empty answer is not cached, so a hiccup does not hide everybody for ten minutes.
    if (accounts.length) accountCache.set(this.configuredUrl, { at: Date.now(), accounts });
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
        // The device is part of the key: one account playing the same title on two devices is
        // two streams, and without it both would share one row and overwrite each other.
        sessionKey:
          String(m.ratingKey) + ':' + (m.User?.id ?? '') + (m.Player?.machineIdentifier ? ':' + m.Player.machineIdentifier : ''),
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
        transcodeReason: transcode ? plexTranscodeReason(transcode, media) : undefined,
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
    // One section after the other: in parallel, every library asked Plex for a big page at
    // the same moment, which is the load the strain backoff then (rightly) reacted to.
    const pages: PlexContainer[] = [];
    for (const d of wanted) {
      const Metadata: PlexMeta[] = [];
      for (let start = 0; start < MAX_LIBRARY_ITEMS; start += LIBRARY_PAGE) {
        const page = await this.server<PlexContainer>(
          `/library/sections/${d.key}/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${LIBRARY_PAGE}`,
          this.adminToken,
          true,
        );
        const batch = page.MediaContainer.Metadata ?? [];
        for (const item of batch) Metadata.push(item); // push(...batch) overflows the stack on huge pages
        if (batch.length < LIBRARY_PAGE) break;
      }
      pages.push({ MediaContainer: { Metadata } } as PlexContainer);
    }
    // Trade-off: Plex omits genres in section listings; scoring falls back to year/type.
    // Fetch /library/metadata/{key} per item if genre-accurate suggestions matter.
    return pages.flatMap((page, index) =>
      (page.MediaContainer.Metadata ?? []).map((m) => this.libraryItem(m, wanted[index].key)),
    );
  }

  private libraryItem(m: PlexMeta, sectionId: string): LibraryItem {
    const media = m.Media?.[0];
    return {
      itemId: m.ratingKey,
      title: m.title,
      mediaType: m.type ?? 'unknown',
      year: m.year,
      genres: (m.Genre ?? []).map((g) => g.tag),
      posterUrl: this.posterUrl(m.ratingKey),
      sectionId,
      globalId: plexGlobalId(m.guid),
      // Shows have no Media block of their own — only their episodes do — so these
      // stay undefined there rather than reporting a misleading zero.
      fileSizeBytes: media?.Part?.[0]?.size,
      videoCodec: media?.videoCodec?.toLowerCase(),
      height: media?.height,
      durationMs: media?.duration ?? m.duration,
      addedAt: m.addedAt ? new Date(m.addedAt * 1000) : undefined,
      lastPlayedAt: m.lastViewedAt ? new Date(m.lastViewedAt * 1000) : undefined,
    };
  }

  /**
   * What changed since `since`, newest change first, page by page until the changes are older.
   * Sorting (rather than a `updatedAt>` filter) works on every Plex version. Plus each
   * section's total, one header-only request each, so the caller can spot deletions.
   */
  async getLibraryChanges(since: Date): Promise<{ changed: LibraryItem[]; totals: Record<string, number> } | null> {
    const sections = await this.server<{ MediaContainer: { Directory?: { key: string; type: string }[] } }>(
      '/library/sections',
    );
    const wanted = (sections.MediaContainer.Directory ?? []).filter((d) => d.type === 'movie' || d.type === 'show');
    const cutoff = Math.floor(since.getTime() / 1000);
    const changed: LibraryItem[] = [];
    const totals: Record<string, number> = {};
    for (const d of wanted) {
      for (let start = 0; ; start += DELTA_PAGE) {
        const page = await this.server<PlexContainer>(
          `/library/sections/${d.key}/all?sort=updatedAt:desc&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${DELTA_PAGE}`,
          this.adminToken,
          true, // sorting a large section can take Plex a while; that is size, not load
        );
        if (start === 0) totals[d.key] = page.MediaContainer.totalSize ?? page.MediaContainer.size ?? 0;
        const batch = page.MediaContainer.Metadata ?? [];
        const recent = batch.filter((m) => (m.updatedAt ?? m.addedAt ?? 0) >= cutoff);
        for (const m of recent) changed.push(this.libraryItem(m, d.key));
        if (recent.length < batch.length || batch.length < DELTA_PAGE) break;
        // So much changed (a rescan, a big import) that one full listing is cheaper.
        if (start + DELTA_PAGE >= MAX_DELTA_ITEMS) return null;
      }
    }
    return { changed, totals };
  }

  async getLibraries(): Promise<LibrarySection[]> {
    const sections = await this.server<{
      MediaContainer: { Directory?: { key: string; title: string; type: string }[] };
    }>('/library/sections');
    // Music libraries ('artist', audiobooks included) only as counts: their tracks never enter
    // getLibrary(), which feeds search and suggestions with titles to watch.
    const wanted = (sections.MediaContainer.Directory ?? []).filter(listedSection);

    // Container-Size=0 returns no items, only the paging header with the total. Plex
    // numbers its metadata types: 2 = show, 3 = season, 4 = episode — asking for a type
    // is what makes seasons and episodes countable inside a show library.
    const countOf = async (key: string, type?: number): Promise<number> => {
      const query = `X-Plex-Container-Size=0${type ? `&type=${type}` : ''}`;
      // Counting episodes makes Plex walk the whole show library: bulk, see http.ts.
      const page = await this.server<PlexContainer>(
        `/library/sections/${key}/all?${query}`,
        this.adminToken,
        true,
      ).catch(() => ({ MediaContainer: {} }) as PlexContainer);
      return page.MediaContainer.totalSize ?? page.MediaContainer.size ?? 0;
    };

    return Promise.all(
      wanted.map(async (d) => {
        const isShow = d.type === 'show';
        // 10 = track: an artist count says little about how much music there is.
        if (d.type === 'artist') {
          return { id: d.key, name: d.title, mediaType: 'audio', itemCount: await countOf(d.key, 10) };
        }
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

  async getHistory(_token: string, serverUserId: string, since?: Date, username?: string): Promise<HistoryPage> {
    const accountID = await this.localAccountId(serverUserId, username);
    const after = since ? Math.floor(since.getTime() / 1000) : undefined;
    // Oldest first, a page at a time. Newest-first with a cap (what this used to be) loses
    // for good whatever lies past the cap: the next call only asks for plays newer than the
    // newest one stored. Ascending, the cap just means "continue from here next time".
    const rows: PlexMeta[] = [];
    const details = new Map<string, PlexDetails>();
    let more = false;
    let lookups = 0;
    for (let page = 0; page < HISTORY_PAGES; page += 1) {
      const start = page * HISTORY_PAGE;
      const params = new URLSearchParams({
        accountID,
        sort: 'viewedAt:asc',
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(HISTORY_PAGE),
      });
      if (after !== undefined) params.set('viewedAt>', String(after));
      // History is only exposed to the server owner token, not to individual user tokens.
      // Sorting a long play history is slow on Plex's side, not a sign of load: bulk, see http.ts.
      const res = await this.server<PlexContainer>(`/status/sessions/history/all?${params}`, this.adminToken, true);
      const all = res.MediaContainer.Metadata ?? [];
      // Some Plex versions ignore the page size on this endpoint and hand over everything at
      // once. Taken as one unpaged answer, sorted here and cut at what one call may carry, so
      // the whole history never runs through the metadata lookups in a single go.
      const unpaged = all.length > HISTORY_PAGE;
      // Filtered here too: a server that ignored `viewedAt>` must not feed old plays back in.
      // Before the cut, not after: a server that ignores the page size usually ignores the
      // filter as well, and cutting its whole answer first kept only the oldest plays, all of
      // them already stored, so every call came back empty with `more` set and never got past.
      const newer = all.filter((m) => m.viewedAt && (after === undefined || m.viewedAt > after));
      const ordered = unpaged ? newer.sort((a, b) => (a.viewedAt ?? 0) - (b.viewedAt ?? 0)) : newer;
      const fresh = unpaged ? ordered.slice(0, HISTORY_PAGE * HISTORY_PAGES - rows.length) : ordered;
      lookups += this.uncachedKeys(fresh);
      for (const [key, value] of await this.details(fresh)) details.set(key, value);
      for (const m of fresh) rows.push(m); // push(...fresh) overflows the stack on huge answers

      if (unpaged) {
        more = ordered.length > fresh.length;
        break;
      }
      const total = res.MediaContainer.totalSize;
      if (all.length < HISTORY_PAGE || (total !== undefined && start + all.length >= total)) {
        more = false;
        break;
      }
      more = true;
      // Every title not seen before costs a metadata read; a first sync of years of history
      // would otherwise make thousands of them in one call. The rest follows in the next one.
      if (lookups >= MAX_HISTORY_LOOKUPS) break;
    }

    const kept = more ? trimTrailingInstant(rows, (m) => m.viewedAt ?? 0) : rows;
    const entries = kept.map((m) => {
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
    return { entries, more };
  }

  /** How many metadata reads details() would make for these rows. */
  private uncachedKeys(rows: PlexMeta[]): number {
    const keys = new Set<string>();
    for (const m of rows) {
      keys.add(m.ratingKey);
      if (m.grandparentRatingKey) keys.add(m.grandparentRatingKey);
    }
    let missing = 0;
    for (const key of keys) if (!detailCache.has(`${this.configuredUrl}|${key}`)) missing += 1;
    return missing;
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
      const cached = detailCache.get(`${this.configuredUrl}|${key}`);
      if (cached) found.set(key, cached);
      else todo.push(key);
    }
    // A server paused for load gets no extra lookups. Thrown rather than returning bare rows:
    // a play stored without its runtime would count zero watch time for good, while an aborted
    // sync simply fetches the same rows again after the pause.
    if (todo.length && isStrained(this.baseUrl)) throw new Error('paused while the server is overloaded');
    const work = async () => {
      for (let key = todo.pop(); key; key = todo.pop()) {
        if (isStrained(this.baseUrl)) return; // stop asking the moment the server struggles
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
        detailCache.set(`${this.configuredUrl}|${key}`, entry);
        found.set(key, entry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, todo.length) }, work));
    // The server went under during the lookups: same reasoning as above, retry after the pause.
    if (found.size < keys.size && isStrained(this.baseUrl)) throw new Error('paused while the server is overloaded');
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

  /**
   * PUT discover.provider.plex.tv/actions/{add,remove}ToWatchlist?ratingKey=<global id>, with
   * the user's plex.tv token: the same call python-plexapi's MyPlexAccount.addToWatchlist /
   * removeFromWatchlist makes, which takes the id as `item.guid.rsplit('/', 1)[-1]`.
   */
  async addToWatchlist(token: string, itemId: string): Promise<void> {
    await this.watchlistAction('addToWatchlist', token, itemId);
  }

  async removeFromWatchlist(token: string, itemId: string): Promise<void> {
    await this.watchlistAction('removeFromWatchlist', token, itemId);
  }

  private async watchlistAction(action: 'addToWatchlist' | 'removeFromWatchlist', token: string, itemId: string) {
    const id = await this.watchlistId(itemId);
    await apiFetch<unknown>(`${PLEX_DISCOVER}/actions/${action}?ratingKey=${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: this.plexHeaders(token),
    });
  }

  /**
   * The watchlist knows titles by their global id, the library by a server-local ratingKey,
   * and Watcharr holds both: getWatchlist() rows carry the global id, everything from the
   * library or the history the local one. Local keys are short integers, global ids 24 hex
   * digits, so the two cannot be confused. A local key is looked up on the server; an episode
   * or season stands for its show, since plex.tv only lists movies and shows.
   */
  private async watchlistId(itemId: string): Promise<string> {
    const fromGuid = plexGlobalId(itemId);
    if (fromGuid) return fromGuid;
    if (!/^\d{1,12}$/.test(itemId)) return itemId;
    const res = await this.server<PlexContainer>(`/library/metadata/${encodeURIComponent(itemId)}`);
    const meta = res.MediaContainer.Metadata?.[0];
    const guid =
      meta?.type === 'episode' ? meta.grandparentGuid : meta?.type === 'season' ? meta.parentGuid : meta?.guid;
    const id = plexGlobalId(guid);
    if (!id) throw new Error(`Plex item ${itemId} has no plex:// guid, so it cannot go on the watchlist`);
    return id;
  }

  /**
   * Asks the server itself, with the access token plex.tv issued this user for it: Plex then
   * lists exactly the sections shared with them (the owner's token sees all). The alternative,
   * plex.tv's shared_servers list read with the owner token, describes the same shares from the
   * outside but leaves out Plex Home members and the owner, who each need a rule of their own.
   */
  async getUserSectionIds(token: string): Promise<string[] | null> {
    if (!token) return null;
    const [root, resources] = await Promise.all([
      this.server<PlexContainer>('/'),
      apiFetch<{ clientIdentifier?: string; accessToken?: string }[]>(`${PLEX_TV}/resources`, {
        headers: this.plexHeaders(token),
        timeoutMs: PLEX_TV_AUTH_TIMEOUT_MS,
      }),
    ]);
    const machineId = root.MediaContainer.machineIdentifier;
    if (!machineId || !Array.isArray(resources)) return null;
    const entry = resources.find((r) => r.clientIdentifier === machineId);
    // Not listed at all: plex.tv gives this account no access to the server, so nothing.
    if (!entry) return [];
    if (!entry.accessToken) return null;
    const sections = await this.server<{ MediaContainer: { Directory?: { key: string; type: string }[] } }>(
      '/library/sections',
      entry.accessToken,
    );
    return (sections.MediaContainer.Directory ?? []).filter(listedSection).map((d) => d.key);
  }
}
