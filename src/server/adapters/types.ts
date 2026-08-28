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
  /** 'movie' | 'show' | whatever the backend calls it. */
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
  ping(): Promise<{ ok: boolean; serverName?: string; version?: string }>;

  /** Exchange credentials for a user token. Not used by Plex (see PinAuthAdapter). */
  login(credentials: LoginCredentials): Promise<AuthResult>;

  /** Resolve the owner of a token. Used to validate stored sessions. */
  getUser(token: string): Promise<MediaServerUser>;

  /** All users known to the server. Admin only. */
  listUsers(): Promise<MediaServerUser[]>;

  /** Live playback sessions. Pass a token to scope to that user, omit for server-wide. */
  getSessions(token?: string): Promise<PlaybackSession[]>;

  getHistory(token: string, serverUserId: string, since?: Date): Promise<HistoryEntry[]>;

  /** Movies and series in the server's libraries. Used for search and suggestions. */
  getLibrary(): Promise<LibraryItem[]>;

  /** The libraries themselves, with how many items each holds. */
  getLibraries(): Promise<LibrarySection[]>;

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
   */
  liveSocket?(): { url: string; hello?: string } | null;
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

/** Plex uses a PIN-based OAuth flow instead of username/password. */
export interface PinAuthAdapter {
  startPinAuth(): Promise<{ pinId: string; code: string; authUrl: string }>;
  pollPinAuth(pinId: string): Promise<AuthResult | null>;
}

export function supportsPinAuth(a: MediaServerAdapter): a is MediaServerAdapter & PinAuthAdapter {
  return typeof (a as Partial<PinAuthAdapter>).startPinAuth === 'function';
}
