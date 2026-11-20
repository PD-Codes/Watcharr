import { createHash } from 'node:crypto';
import { apiFetch, joinUrl, type HttpError } from './http';
import { normalise } from '../net';
import { randomUUID } from 'node:crypto';
import { trimTrailingInstant } from './paging';
import type {
  AuthResult,
  HistoryEntry,
  HistoryPage,
  LibraryItem,
  LibrarySection,
  PlayMethod,
  LoginCredentials,
  MediaServerAdapter,
  MediaServerUser,
  PlaybackSession,
  QuickConnectRequest,
  QuickConnectState,
  ServerType,
} from './types';
import { PartialLibraryError } from './types';

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
  Policy?: { IsAdministrator?: boolean; EnableAllFolders?: boolean; EnabledFolders?: string[] };
};

/**
 * A library as /Library/VirtualFolders lists it. Jellyfin names it by ItemId; Emby also
 * reports Id and Guid, and its user policy may refer to a library by either.
 */
type JfFolder = { Name: string; ItemId: string; CollectionType?: string; Id?: string; Guid?: string };

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

/** Items per library request, and the ceiling that keeps a runaway server from filling memory. */
// 1000, not 5000: with MediaSources in the fields a 5000-item page of a large library takes long
// enough to time out on a server that is merely big. Same reasoning as in plex.ts.
const LIBRARY_PAGE = 1000;
const MAX_LIBRARY_ITEMS = 200_000;
/** History items per request, and requests per call (see HistoryPage). */
const HISTORY_PAGE = 500;
const HISTORY_PAGES = 10;

const audioFolder = (f: { CollectionType?: string }) => f.CollectionType === 'music' || f.CollectionType === 'books';
/** "Mixed movies and shows": Jellyfin leaves the type out, Emby writes "mixed". */
const mixedFolder = (f: { CollectionType?: string }) => !f.CollectionType || f.CollectionType === 'mixed';
/** The libraries getLibrary() lists items of. */
const videoFolder = (f: { CollectionType?: string }) =>
  f.CollectionType === 'movies' || f.CollectionType === 'tvshows' || mixedFolder(f);
/** The libraries getLibraries() reports; getUserSectionIds() answers within the same set. */
const listedFolder = (f: { CollectionType?: string }) => videoFolder(f) || audioFolder(f);
/** Jellyfin writes ids without dashes, a Guid elsewhere may carry them. */
const sameId = (id: string) => id.replace(/-/g, '').toLowerCase();

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

  /** The libraries as configured, without counts. */
  private folders(): Promise<JfFolder[]> {
    return apiFetch<JfFolder[]>(this.url('/Library/VirtualFolders'), { headers: this.headers() });
  }

  /**
   * Throws instead of returning a partial list: library.ts keeps its previous copy when a
   * refresh fails, while an empty or half list would replace it and drop titles from search,
   * the library table and the notification filters until the next good run. When only some
   * libraries fail, the error is a PartialLibraryError with the rest, so one broken library
   * does not hold back the others (library.ts keeps the old items of the broken one).
   */
  async getLibrary(): Promise<LibraryItem[]> {
    // One request per library rather than one for everything: without ParentId the response
    // carries no way back to the library an item came from, and the per-library statistics
    // and the visibility rules need exactly that. Mixed libraries count as libraries too:
    // asked without a parent, their titles had no library and were hidden from everybody who
    // is not an admin. Only a server without any video library is asked once without a parent.
    const folders = (await this.folders()).filter(videoFolder);
    const sources = folders.length ? folders.map((f) => f.ItemId) : [undefined];

    const items: LibraryItem[] = [];
    const failed: string[] = [];
    let firstError: unknown;
    // One library after the other, a page at a time: all at once, every library asked the
    // server for a big page at the same moment (the load Plex's adapter already stopped making).
    for (const sectionId of sources) {
      const own: LibraryItem[] = [];
      try {
        // Paged: a single capped request would silently drop everything past the cap from
        // search, the library table and the "never started" list.
        for (let start = 0; start < MAX_LIBRARY_ITEMS; start += LIBRARY_PAGE) {
          const params = new URLSearchParams({
            Recursive: 'true',
            IncludeItemTypes: 'Movie,Series',
            // MediaSources carries file size and the video stream; UserData carries the
            // server's own last-played date, which reaches further back than watch_history.
            Fields: 'Genres,ProductionYear,MediaSources,UserData,DateCreated',
            SortBy: 'SortName',
            StartIndex: String(start),
            Limit: String(LIBRARY_PAGE),
          });
          if (sectionId) params.set('ParentId', sectionId);
          // A whole library listing is large, not a sign of load: bulk, see http.ts.
          const res = await apiFetch<{ Items: JfItem[] }>(this.url(`/Items?${params}`), {
            headers: this.headers(),
            bulk: true,
          });
          const batch = res.Items ?? [];
          for (const i of batch) own.push(this.libraryItem(i, sectionId)); // no push(...batch): stack
          if (batch.length < LIBRARY_PAGE) break;
        }
      } catch (error) {
        // A library that fails halfway is dropped whole: half a library would read as deletions.
        if (!sectionId) throw error;
        failed.push(sectionId);
        firstError ??= error;
        continue;
      }
      for (const item of own) items.push(item);
    }
    if (failed.length === sources.length) throw firstError;
    if (failed.length) throw new PartialLibraryError(items, failed, firstError);
    return items;
  }

  private libraryItem(i: JfItem, sectionId: string | undefined): LibraryItem {
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
      lastPlayedAt: i.UserData?.LastPlayedDate ? new Date(i.UserData.LastPlayedDate) : undefined,
    };
  }

  async getLibraries(): Promise<LibrarySection[]> {
    const wanted = (await this.folders()).filter(listedFolder);

    // Counts come from separate requests per library: Jellyfin reports the total in the
    // paging metadata, so Limit=0 returns it without any items. A show library needs three
    // of them, because seasons and episodes are not implied by the series count.
    // A failed count throws rather than reading as 0: library.ts then keeps the counts it had,
    // where a zero would have shown an empty library until the next refresh.
    const countOf = async (parentId: string, type: string): Promise<number> => {
      const params = new URLSearchParams({
        Recursive: 'true',
        ParentId: parentId,
        IncludeItemTypes: type,
        Limit: '0',
        EnableTotalRecordCount: 'true',
      });
      // Counting episodes walks the whole show library: bulk, see http.ts.
      const res = await apiFetch<{ TotalRecordCount?: number }>(this.url(`/Items?${params}`), {
        headers: this.headers(),
        bulk: true,
      });
      return res.TotalRecordCount ?? 0;
    };

    const section = async (folder: JfFolder): Promise<LibrarySection> => {
      // Music and audiobooks as one kind, counted in tracks (a "books" library may also hold
      // e-books, which are not counted).
      if (audioFolder(folder)) {
        return { id: folder.ItemId, name: folder.Name, mediaType: 'audio', itemCount: await countOf(folder.ItemId, 'Audio,AudioBook') };
      }
      // Movies and series side by side, counted together like getLibrary() lists them.
      if (mixedFolder(folder)) {
        return { id: folder.ItemId, name: folder.Name, mediaType: 'mixed', itemCount: await countOf(folder.ItemId, 'Movie,Series') };
      }
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
    };

    // One library after the other; only the counts of one library run side by side.
    const sections: LibrarySection[] = [];
    for (const folder of wanted) sections.push(await section(folder));
    return sections;
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

  /**
   * Jellyfin and Emby keep no play log, only a per-item "last played", so the history is the
   * list of played items ordered by that date. Their API cannot filter by it, which shapes how
   * this pages: see the two paths below.
   */
  async getHistory(token: string, serverUserId: string, since?: Date): Promise<HistoryPage> {
    const after = since?.getTime();
    const playedAt = (i: JfItem) => (i.UserData?.LastPlayedDate ? Date.parse(i.UserData.LastPlayedDate) : Number.NaN);
    const isNew = (i: JfItem) => {
      const at = playedAt(i);
      return Number.isFinite(at) && (after === undefined || at > after);
    };
    const page = (start: number, limit: number, order: 'Ascending' | 'Descending') => {
      const params = new URLSearchParams({
        Recursive: 'true',
        IsPlayed: 'true',
        SortBy: 'DatePlayed',
        SortOrder: order,
        Fields: 'Genres,ProductionYear,SeriesName',
        StartIndex: String(start),
        Limit: String(limit),
        EnableTotalRecordCount: 'true',
      });
      // Sorting a long play list by date is size, not load: bulk, see http.ts.
      return apiFetch<{ Items?: JfItem[]; TotalRecordCount?: number }>(
        this.url(`/Users/${encodeURIComponent(serverUserId)}/Items?${params}`),
        { headers: this.headers(token), bulk: true },
      );
    };
    const toEntry = (i: JfItem): HistoryEntry => ({
      itemId: i.Id,
      title: i.Name,
      grandparentTitle: i.SeriesName,
      mediaType: (i.Type ?? 'unknown').toLowerCase(),
      year: i.ProductionYear,
      genres: i.Genres ?? [],
      watchedAt: new Date(playedAt(i)),
      durationMs: ticksToMs(i.RunTimeTicks),
    });

    // The usual case, one request: the few plays since the last sync all sit on the first page
    // newest first, and the page reaches back past `since` (undated items sort last there).
    const first = await page(0, HISTORY_PAGE, 'Descending');
    const firstItems = first.Items ?? [];
    const newest = firstItems.filter(isNew);
    const total = first.TotalRecordCount;
    // Without a total (an old server) there is no way to page reliably; the newest page is
    // what an older version of this adapter returned as well.
    if (newest.length < firstItems.length || firstItems.length < HISTORY_PAGE || total === undefined) {
      return { entries: newest.map(toEntry), more: false };
    }

    // A backlog bigger than one page: the first sync, or a long history. Newest first with a
    // cap would lose for good whatever lies past the cap (the next call only asks for plays
    // newer than the newest stored), so this continues oldest first from just after `since`.
    // Where that point lies is found by bisecting the ascending order with one-item requests,
    // a dozen or so even for a long list: items newer than `since` form its tail, and the
    // first page above already showed that its last `firstItems.length` entries are newer.
    let lo = 0;
    let hi = Math.max(0, total - firstItems.length);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const [probe] = (await page(mid, 1, 'Ascending')).Items ?? [];
      if (probe && isNew(probe)) hi = mid;
      else lo = mid + 1;
    }

    const rows: JfItem[] = [];
    let more = false;
    for (let n = 0; n < HISTORY_PAGES; n += 1) {
      const start = lo + n * HISTORY_PAGE;
      const res = await page(start, HISTORY_PAGE, 'Ascending');
      const batch = res.Items ?? [];
      // Filtered again: an item played meanwhile moves to the end, shifting the order by one.
      for (const i of batch) if (isNew(i)) rows.push(i);
      if (batch.length < HISTORY_PAGE || start + batch.length >= (res.TotalRecordCount ?? total)) {
        more = false;
        break;
      }
      more = true;
    }
    const kept = more ? trimTrailingInstant(rows, playedAt) : rows;
    return { entries: kept.map(toEntry), more };
  }

  /**
   * What the user may open, from their policy: EnableAllFolders, or the EnabledFolders list.
   * Not their views (/Users/{id}/Views): those are presentation — a library the user hid from
   * their home screen is still theirs, and a grouped view carries an id of its own. Only when
   * the policy names folders by an id no library answers to does the view list stand in.
   * Read with the admin token, so it works for people who are not signed in right now.
   */
  async getUserSectionIds(_token: string, serverUserId: string): Promise<string[] | null> {
    const [user, folders] = await Promise.all([
      apiFetch<JfUser>(this.url(`/Users/${encodeURIComponent(serverUserId)}`), { headers: this.headers() }),
      this.folders(),
    ]);
    const listed = folders.filter(listedFolder);
    const policy = user.Policy;
    if (policy?.EnableAllFolders) return listed.map((f) => f.ItemId);
    if (!Array.isArray(policy?.EnabledFolders)) return null;

    const enabled = new Set(policy.EnabledFolders.map(sameId));
    const ids = (f: JfFolder) => [f.ItemId, f.Id, f.Guid].filter((id): id is string => !!id).map(sameId);
    const known = new Set(folders.flatMap(ids));
    if ([...enabled].every((id) => known.has(id))) {
      return listed.filter((f) => ids(f).some((id) => enabled.has(id))).map((f) => f.ItemId);
    }

    // Emby has written policy folder ids in more than one notation over the years; when they
    // match nothing, the views of the user are the remaining honest answer.
    const views = await apiFetch<{ Items?: { Id: string }[] }>(
      this.url(`/Users/${encodeURIComponent(serverUserId)}/Views`),
      { headers: this.headers() },
    );
    const visible = new Set((views.Items ?? []).map((v) => sameId(v.Id)));
    const found = listed.filter((f) => ids(f).some((id) => visible.has(id)));
    return found.length || !visible.size ? found.map((f) => f.ItemId) : null;
  }

  /** Jellyfin only; false for Emby and for a server where it is off or unknown. */
  async quickConnectEnabled(): Promise<boolean> {
    if (this.type !== 'jellyfin') return false;
    const enabled = await apiFetch<boolean>(this.url('/QuickConnect/Enabled'), { headers: this.headers('') }).catch(
      () => false,
    );
    return enabled === true;
  }

  async initiateQuickConnect(): Promise<QuickConnectRequest | null> {
    if (this.type !== 'jellyfin') return null;
    // The token Jellyfin eventually issues is bound to the device of this very request, and
    // nobody is known yet to derive one from (password logins use the account, see
    // deviceIdFor). A fresh device per sign-in keeps one person's token from replacing another's.
    const deviceId = deviceIdFor(`quickconnect:${randomUUID()}`);
    const start = (method: 'POST' | 'GET') =>
      apiFetch<{ Code?: string; Secret?: string }>(this.url('/QuickConnect/Initiate'), {
        method,
        headers: this.headers('', deviceId),
      });
    try {
      // POST since Jellyfin 10.9; 10.8 only answered GET, and says so with a 405.
      const res = await start('POST').catch((error: unknown) => {
        if ((error as HttpError | null)?.status === 405) return start('GET');
        throw error;
      });
      if (!res?.Code || !res.Secret) return null;
      return { code: res.Code, secret: res.Secret, deviceId };
    } catch (error) {
      // 401 is Jellyfin's answer when Quick Connect is switched off, 404 a server without it.
      const status = (error as HttpError | null)?.status;
      if (status === 401 || status === 404) return null;
      throw error;
    }
  }

  async quickConnectState(request: QuickConnectRequest): Promise<QuickConnectState> {
    try {
      const res = await apiFetch<{ Authenticated?: boolean }>(
        this.url(`/QuickConnect/Connect?${new URLSearchParams({ secret: request.secret })}`),
        { headers: this.headers('', request.deviceId) },
      );
      return res?.Authenticated ? 'authorized' : 'pending';
    } catch (error) {
      // 404: the server no longer knows the secret (they expire after minutes); 401: switched off.
      const status = (error as HttpError | null)?.status;
      if (status === 404 || status === 401) return 'expired';
      throw error;
    }
  }

  async authenticateQuickConnect(request: QuickConnectRequest): Promise<AuthResult> {
    // Same device header as the initiation: Jellyfin 10.8 took the device for the new token
    // from this request, later versions from the stored initiation, and both must agree.
    const res = await apiFetch<{ User: JfUser; AccessToken: string }>(this.url('/Users/AuthenticateWithQuickConnect'), {
      method: 'POST',
      headers: this.headers('', request.deviceId),
      body: JSON.stringify({ Secret: request.secret }),
    });
    return { user: this.toUser(res.User), token: res.AccessToken };
  }
}
