export type ServerType = 'plex' | 'jellyfin' | 'emby';

export interface MediaServerUser {
  serverUserId: string;
  username: string;
  email?: string;
  avatarUrl?: string;
  isAdmin: boolean;
}

export interface AuthResult {
  user: MediaServerUser;
  /** Access token for this user, stored server-side in auth_sessions. */
  token: string;
}

export type PlayMethod = 'directplay' | 'directstream' | 'transcode';

export interface PlaybackSession {
  sessionKey: string;
  serverUserId: string;
  username: string;
  itemId: string;
  title: string;
  grandparentTitle?: string;
  mediaType: string;
  state: 'playing' | 'paused' | 'buffering';
  progressMs: number;
  durationMs: number;
  isTranscoding: boolean;
  bandwidthKbps?: number;
  /** Player application, e.g. "Jellyfin Web" or "Plex for Android". */
  clientName?: string;
  /** Physical device or browser, e.g. "Opera" or "Living Room TV". */
  deviceName?: string;
  playMethod?: PlayMethod;
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
  width?: number;
  height?: number;
  /** Why the server had to transcode, as reported by the media server. */
  transcodeReason?: string;
  audioChannels?: number;
  /** Codec of the burned-in or delivered subtitle track, where one is playing. */
  subtitleCodec?: string;

  // What the file holds, as opposed to the fields above, which describe what is being
  // delivered. During a transcode the two differ, and only having one of them makes a
  // stream panel unreadable: "H264 1080p" says nothing without the 4K HEVC it came from.
  sourceVideoCodec?: string;
  sourceAudioCodec?: string;
  sourceContainer?: string;
  sourceHeight?: number;
  sourceBitrateKbps?: number;
  /** Address the stream is delivered to, as reported by the media server. */
  remoteAddress?: string;
  /**
   * Native handle for terminating this stream. Not the same value as sessionKey on Plex,
   * which is why it is carried separately instead of being derived from the stored row.
   */
  terminateKey?: string;
  /**
   * Last time the client checked in about this playback, if the server reports it.
   * Media servers keep sessions around after a client disappears, so this is the only
   * trustworthy signal that a stream is still actually running.
   */
  lastCheckInAt?: Date;
}

export interface HistoryEntry {
  itemId: string;
  title: string;
  grandparentTitle?: string;
  mediaType: string;
  year?: number;
  genres: string[];
  watchedAt: Date;
  durationMs: number;
  deviceName?: string;
}

/**
 * One call's worth of history.
 *
 * A call is capped (pages per call, metadata lookups per call), because a first sync of a long
 * history would otherwise hold a page render or the tick for minutes. `more` says the cap was
 * hit: the server has plays newer than the newest entry here. Whenever `more` is true, the
 * entries are a gap-free run starting right after `since`, so asking again with
 * `since` = the newest `watchedAt` returned continues exactly where this call stopped. With
 * `more` false the order of the entries is not specified.
 */
export interface HistoryPage {
  entries: HistoryEntry[];
  more: boolean;
}

/**
 * A pending Jellyfin Quick Connect sign-in. `code` is shown to the person, who enters it in a
 * signed-in Jellyfin client; `secret` and `deviceId` stay server-side (the secret alone redeems
 * the sign-in, and the issued token is bound to `deviceId`, which the later calls must repeat).
 */
export interface QuickConnectRequest {
  code: string;
  secret: string;
  deviceId: string;
}

/**
 * `expired` covers every way the request can no longer succeed: the server forgot the secret
 * (it keeps them for minutes), or Quick Connect was switched off in the meantime.
 */
export type QuickConnectState = 'pending' | 'authorized' | 'expired';

export interface LibraryItem {
  itemId: string;
  title: string;
  mediaType: string;
  year?: number;
  genres: string[];
  posterUrl?: string;
  /** When the server first saw the item. Only filled in by the recently-added queries. */
  addedAt?: Date;
  /** Which library the item belongs to, where the backend reports it. */
  sectionId?: string;
  /**
   * Plex only: the global id behind the item's plex:// guid, which is how plex.tv's watchlist
   * names it. Undefined for items matched by a legacy agent.
   */
  globalId?: string;

  // Media info, for the per-library table. Optional throughout: a backend that does not
  // report a field leaves it out rather than reporting a zero that would be aggregated.
  fileSizeBytes?: number;
  videoCodec?: string;
  height?: number;
  durationMs?: number;
  /** Last play according to the media server itself, which reaches back before Watcharr. */
  lastPlayedAt?: Date;
}

/** A library / section as the media server groups it. */
export interface LibrarySection {
  id: string;
  name: string;
  /** 'movie' | 'show' | 'audio' (music and audiobooks, counted in tracks) | 'mixed' (Jellyfin/Emby movies and shows). */
  mediaType: string;
  /** Movies, or series — the top level of the library, never its children. */
  itemCount: number;
  /** Only for show libraries, and only where the backend reports a total. */
  seasonCount?: number;
  episodeCount?: number;
}

export interface WatchlistEntry {
  itemId: string;
  title: string;
  mediaType: string;
  year?: number;
  posterUrl?: string;
}

/** Credentials for a login attempt. Shape depends on the server type. */
export type LoginCredentials =
  | { kind: 'password'; username: string; password: string }
  | { kind: 'token'; token: string };

/**
 * Everything the app is allowed to know about a media server.
 * Adding a new backend means implementing this interface — nothing else changes.
 */
export interface MediaServerAdapter {
  readonly type: ServerType;

  /** Verify the configured server URL/token. Returns the server's display name. */
  /** `machineIdentifier`: Plex only, the id plex.tv and Plex clients know this server by. */
  ping(): Promise<{ ok: boolean; serverName?: string; version?: string; machineIdentifier?: string }>;

  /** Exchange credentials for a user token. Not used by Plex (see PinAuthAdapter). */
  login(credentials: LoginCredentials): Promise<AuthResult>;

  /** Resolve the owner of a token. Used to validate stored sessions. */
  getUser(token: string): Promise<MediaServerUser>;

  /** All users known to the server. Admin only. */
  listUsers(): Promise<MediaServerUser[]>;

  /**
   * listUsers() plus whether that list names everybody who may use the server. Only a complete
   * list may be read as "whoever is missing lost access" (userroster.ts::reconcileRoster). An
   * adapter without this method has a listUsers() that is complete whenever it resolves.
   */
  listUsersWithCompleteness?(): Promise<{ users: MediaServerUser[]; complete: boolean }>;

  /** Live playback sessions. Pass a token to scope to that user, omit for server-wide. */
  getSessions(token?: string): Promise<PlaybackSession[]>;

  /**
   * `username` is the fallback identity for servers whose history ids differ from the ids the
   * user signed in with (Plex numbers the owner 1 locally, but by plex.tv id everywhere else).
   */
  /**
   * Plays strictly after `since` (everything when omitted), capped per call; see HistoryPage
   * for `more` and how to continue. Throws on transport and HTTP errors.
   */
  getHistory(
    token: string,
    serverUserId: string,
    since?: Date,
    username?: string,
  ): Promise<HistoryPage>;

  /**
   * Movies and series in the server's libraries. Used for search and suggestions. When some
   * libraries could be listed and others not, a backend may throw a PartialLibraryError that
   * carries the part it got; library.ts keeps the old items of the failed libraries.
   */
  getLibrary(): Promise<LibraryItem[]>;

  /** The libraries themselves, with how many items each holds. */
  getLibraries(): Promise<LibrarySection[]>;

  /**
   * Delta sync, where the backend can sort by change time: the items changed since `since`,
   * plus how many items each library holds now (a changed total means something was deleted,
   * which a delta cannot show). Null when the change list is too long to be worth it — the
   * caller then loads everything.
   */
  getLibraryChanges?(since: Date): Promise<{ changed: LibraryItem[]; totals: Record<string, number> } | null>;

  /**
   * Newest additions, newest first. Without a section id this spans every library, which
   * is what the media.added notification watches; the newsletter passes one so an admin
   * can leave a library out of it.
   */
  getRecentlyAdded(limit: number, sectionId?: string): Promise<LibraryItem[]>;

  /** Artwork URL for an item, proxied through the app so tokens stay server-side. */
  posterUrl(itemId: string): string;

  /** Server-side watchlist, where the backend has one. */
  getWatchlist?(token: string): Promise<WatchlistEntry[]>;

  /**
   * Writes to that watchlist (Plex: the plex.tv watchlist). `token` is the same user token
   * getWatchlist() reads with. `itemId` is either an id as getWatchlist() reports it (the global
   * Plex id, e.g. "5d776825880197001ec967c6", or the full "plex://movie/<id>" guid) or a local
   * library id (a ratingKey as getLibrary()/history report it), which is resolved to the global
   * id through the server; an episode or season resolves to its show. Throws when the item
   * cannot be resolved (not in the library, or matched by a legacy agent without a plex:// guid)
   * and on any HTTP error; adding an item already listed is not checked here.
   */
  addToWatchlist?(token: string, itemId: string): Promise<void>;
  removeFromWatchlist?(token: string, itemId: string): Promise<void>;

  /**
   * Ids of the libraries this user may see according to the media server, in exactly the id
   * format of LibrarySection.id from getLibraries(), and only among the sections getLibraries()
   * lists (movies, shows, music/audiobooks).
   *
   * Plex: `token` is the user's plex.tv token (the one the session holds); the server is asked
   * for its sections with the server access token plex.tv issues this user (the owner sees all).
   * An account plex.tv does not list for this server gets []. Jellyfin/Emby: the user's policy
   * (EnableAllFolders/EnabledFolders), read with the admin token, so `token` is not needed.
   *
   * Null only when the server cannot answer the question (no token, plex.tv returned no usable
   * entry, a policy whose folder ids match no library). HTTP and transport errors throw.
   */
  getUserSectionIds?(token: string, serverUserId: string): Promise<string[] | null>;

  /**
   * Jellyfin Quick Connect. Present on the shared Jellyfin/Emby adapter, but only Jellyfin has
   * it: check with supportsQuickConnect(), which also looks at the type.
   *
   * - quickConnectEnabled(): whether the server has it switched on. Never throws for a server
   *   that simply lacks it (false).
   * - initiateQuickConnect(): starts a request; null when Quick Connect is switched off or the
   *   server does not have it (401/404 from Jellyfin). Other errors throw.
   * - quickConnectState(): see QuickConnectState. Other errors throw.
   * - authenticateQuickConnect(): redeems an authorized request; the result has exactly the
   *   shape of a password login (token + user including isAdmin). Throws when the request is
   *   not (or no longer) authorized.
   */
  quickConnectEnabled?(): Promise<boolean>;
  initiateQuickConnect?(): Promise<QuickConnectRequest | null>;
  quickConnectState?(request: QuickConnectRequest): Promise<QuickConnectState>;
  authenticateQuickConnect?(request: QuickConnectRequest): Promise<AuthResult>;

  /** Stops a running stream. Takes the terminateKey of a live session, not a stored row. */
  terminateSession?(terminateKey: string, reason?: string): Promise<void>;

  /**
   * Where to listen for live playback events, and what to say on connect.
   *
   * Deliberately narrow: the socket is only ever used as a doorbell. Whatever arrives
   * makes the app re-read the session list through getSessions() rather than being parsed
   * into a PlaybackSession itself — two socket protocols would otherwise become a second
   * mapping to keep in step with the first, for data the HTTP call already returns. What
   * it buys is latency: a stream appears when it starts instead of up to five seconds
   * later, and an idle server stops being polled at all.
   *
   * `relevant` lets an adapter tell playback frames from the rest of a chatty socket (Plex
   * also announces library scans); it only ever skips work and is never needed for correctness.
   */
  liveSocket?(): { url: string; hello?: string; relevant?: (frame: string) => boolean } | null;
}

export function supportsLiveSocket(
  a: MediaServerAdapter,
): a is MediaServerAdapter & Required<Pick<MediaServerAdapter, 'liveSocket'>> {
  return typeof a.liveSocket === 'function';
}

export function supportsTerminate(
  a: MediaServerAdapter,
): a is MediaServerAdapter & Required<Pick<MediaServerAdapter, 'terminateSession'>> {
  return typeof a.terminateSession === 'function';
}

export function supportsWatchlistWrite(
  a: MediaServerAdapter,
): a is MediaServerAdapter & Required<Pick<MediaServerAdapter, 'addToWatchlist' | 'removeFromWatchlist'>> {
  return typeof a.addToWatchlist === 'function' && typeof a.removeFromWatchlist === 'function';
}

export function supportsUserSections(
  a: MediaServerAdapter,
): a is MediaServerAdapter & Required<Pick<MediaServerAdapter, 'getUserSectionIds'>> {
  return typeof a.getUserSectionIds === 'function';
}

/** Jellyfin only: Emby shares the adapter class but has no Quick Connect. */
export function supportsQuickConnect(
  a: MediaServerAdapter,
): a is MediaServerAdapter &
  Required<
    Pick<MediaServerAdapter, 'quickConnectEnabled' | 'initiateQuickConnect' | 'quickConnectState' | 'authenticateQuickConnect'>
  > {
  return a.type === 'jellyfin' && typeof a.initiateQuickConnect === 'function';
}

/** Plex uses a PIN-based OAuth flow instead of username/password. */
export interface PinAuthAdapter {
  /** `forwardUrl` is where plex.tv sends the browser after approval; it gets the new pin id. */
  startPinAuth(forwardUrl?: (pinId: string) => string): Promise<{ pinId: string; code: string; authUrl: string }>;
  pollPinAuth(pinId: string): Promise<AuthResult | null>;
}

export function supportsPinAuth(a: MediaServerAdapter): a is MediaServerAdapter & PinAuthAdapter {
  return typeof (a as Partial<PinAuthAdapter>).startPinAuth === 'function';
}

/**
 * getLibrary() could list only some libraries. Thrown rather than returned, so a caller that
 * does not know it still treats the listing as failed (and keeps its previous copy) instead of
 * replacing it with a part.
 */
export class PartialLibraryError extends Error {
  constructor(
    readonly items: LibraryItem[],
    readonly failedSections: string[],
    cause: unknown,
  ) {
    super(
      `${failedSections.length} librar${failedSections.length === 1 ? 'y' : 'ies'} could not be listed: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
    this.name = 'PartialLibraryError';
  }
}

/** By name, not instanceof: the class can exist once per module graph (see state.ts). */
export function isPartialLibrary(error: unknown): error is PartialLibraryError {
  return (error as { name?: string } | null)?.name === 'PartialLibraryError' && Array.isArray((error as PartialLibraryError).failedSections);
}
