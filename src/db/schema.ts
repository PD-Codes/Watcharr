import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  integer,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;

/**
 * One row per connected media server. The table name is historical — it held the single
 * deployment configuration before multiple servers were supported.
 */
export const appConfig = sqliteTable(
  'app_config',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverType: text('server_type').notNull(), // 'plex' | 'jellyfin' | 'emby'
    serverUrl: text('server_url').notNull(),
    serverToken: text('server_token').notNull(), // admin/server token used for server-wide queries
    serverName: text('server_name'), // as reported by the server itself
    label: text('label').notNull().default(''), // free-form name chosen by the admin
    slug: text('slug').notNull().default(''), // URL-safe form of the label
    // Newest item id seen by the last recently-added check. Item ids are stable and the
    // feed is ordered, so this is enough to tell new arrivals apart without a timestamp.
    lastAddedItemId: text('last_added_item_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => ({ slugIdx: uniqueIndex('app_config_slug_idx').on(t.slug) }),
);

/**
 * Single-row table (id = 1) for everything that belongs to the deployment rather than to
 * one media server: the TMDB key, feature toggles and the cached update check.
 */
export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey().default(1),
  tmdbApiKey: text('tmdb_api_key'),
  // UI language for anyone who has not picked one. Users override it on their profile,
  // and that choice lives in the database rather than a cookie so it follows the account
  // to every browser and device.
  defaultLocale: text('default_locale').notNull().default('en-US'),
  features: text('features', { mode: 'json' })
    .$type<Record<string, boolean>>()
    .notNull()
    .default({}),
  // Percentage of an item that counts as "finished". Only playback_sessions know how far
  // a stream actually got — watch_history is the media server's own played list and
  // carries no progress at all.
  watchedThreshold: integer('watched_threshold').notNull().default(85),
  // One outgoing webhook instead of a notification agent per service: Discord, Slack,
  // ntfy and n8n all accept a JSON POST and route it themselves.
  webhookUrl: text('webhook_url'),
  webhookEvents: text('webhook_events', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  // Country lookup is off by default: it is the only part of the app besides TMDB that
  // would send data to a third party.
  geoipEnabled: integer('geoip_enabled', { mode: 'boolean' }).notNull().default(false),
  geoipUrl: text('geoip_url'),
  // Monitoring thresholds. Null/false means the check is off — a fresh install alerts on
  // nothing, same as the webhook being unset.
  monitorMaxStreamsPerUser: integer('monitor_max_streams_per_user'),
  monitorBandwidthMbps: integer('monitor_bandwidth_mbps'),
  monitorTranscodeAlert: integer('monitor_transcode_alert', { mode: 'boolean' })
    .notNull()
    .default(false),
  // Failed logins from the same IP within this window. Null threshold means the check is off.
  monitorFailedLoginThreshold: integer('monitor_failed_login_threshold'),
  monitorFailedLoginWindowMin: integer('monitor_failed_login_window_min').notNull().default(10),
  // A *successful* login from an address this account has never used before. On a shared
  // account that is the signal that matters — a stranger who has the password never
  // produces a failed attempt at all. Reuses the window above rather than adding a second.
  monitorNewAddressAlert: integer('monitor_new_address_alert', { mode: 'boolean' })
    .notNull()
    .default(false),
  // Periodic summary sent through the same channels as everything else, see server/digest.ts.
  digestEnabled: integer('digest_enabled', { mode: 'boolean' }).notNull().default(false),
  digestFrequency: text('digest_frequency').notNull().default('weekly'), // 'daily' | 'weekly'
  digestLastSentAt: integer('digest_last_sent_at', { mode: 'timestamp_ms' }),
  // Automatic snapshots on top of the on-demand download, see server/backup.ts.
  backupAutoEnabled: integer('backup_auto_enabled', { mode: 'boolean' }).notNull().default(false),
  backupIntervalHours: integer('backup_interval_hours').notNull().default(24),
  backupRetention: integer('backup_retention').notNull().default(7),
  backupLastAt: integer('backup_last_at', { mode: 'timestamp_ms' }),
  // Recently-added newsletter. Users subscribe themselves (newsletter_subscriptions); a
  // global admin owns the schedule, the time frame and which libraries it covers.
  newsletterEnabled: integer('newsletter_enabled', { mode: 'boolean' }).notNull().default(false),
  newsletterDayOfWeek: integer('newsletter_day_of_week').notNull().default(5), // 0 = Sunday
  newsletterHour: integer('newsletter_hour').notNull().default(11),
  newsletterDays: integer('newsletter_days').notNull().default(7),
  /** Library section ids to include. Empty means every library the server reports. */
  newsletterLibraries: text('newsletter_libraries', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  newsletterSubject: text('newsletter_subject').notNull().default('Recently added'),
  newsletterIntro: text('newsletter_intro').notNull().default(''),
  /** URL-safe name behind /newsletter/<id>, which serves the last sent issue. */
  newsletterUniqueId: text('newsletter_unique_id').notNull().default('newsletter'),
  newsletterLastSentAt: integer('newsletter_last_sent_at', { mode: 'timestamp_ms' }),
  /** Rendered HTML of the last issue, so the static URL does not rebuild it. */
  newsletterLastHtml: text('newsletter_last_html'),
  // Cached result of the upstream release check, see server/update.ts.
  updateCheckedAt: integer('update_checked_at', { mode: 'timestamp_ms' }),
  updateLatestVersion: text('update_latest_version'),
});

/**
 * Additional outgoing notification channels, on top of the single legacy webhook still
 * stored on app_settings. Each row is one destination with its own event filter — config
 * shape depends on type (see server/notifications.ts for what each one expects).
 */
export const notificationChannels = sqliteTable('notification_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // 'discord' | 'slack' | 'telegram' | 'pushover' | 'pushbullet' | 'email'
  name: text('name').notNull().default(''),
  // Encrypted JSON blob (bot tokens, webhook URLs, SMTP credentials — all as sensitive as
  // a media server token), not a plain json column. See server/notifications.ts.
  config: text('config').notNull().default(''),
  events: text('events', { mode: 'json' }).$type<string[]>().notNull().default([]),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * One row per delivery attempt, successful or not. `dispatch()` used to drop a failed
 * notification silently after its one retry — this is the audit trail that was missing.
 */
export const notificationLog = sqliteTable(
  'notification_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelType: text('channel_type').notNull(),
    // Null for the legacy webhook field, which has no row in notification_channels.
    channelId: integer('channel_id'),
    channelName: text('channel_name').notNull().default(''),
    event: text('event').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => ({ createdIdx: index('notification_log_created_idx').on(t.createdAt) }),
);

/** One row per fired monitoring threshold — checkThresholds() used to only notify, never record. */
export const monitorAlerts = sqliteTable(
  'monitor_alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    rule: text('rule').notNull(),
    message: text('message').notNull(),
    value: integer('value'),
    threshold: integer('threshold'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => ({ createdIdx: index('monitor_alerts_created_idx').on(t.createdAt) }),
);

/**
 * Who wants the newsletter. One row per user, created by the user themselves from their
 * own profile page — an admin never subscribes anyone, they only own the schedule and the
 * content. The email is stored separately from users.email because the media server's
 * address is not necessarily where someone wants this delivered.
 */
export const newsletterSubscriptions = sqliteTable('newsletter_subscriptions', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * One row per login attempt, successful or not — Tautulli's login/IP history. Kept
 * separate from auth_sessions, which only ever holds live sessions.
 */
export const loginHistory = sqliteTable(
  'login_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: integer('server_id'),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    username: text('username').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    ip: text('ip'),
    country: text('country'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => ({ createdIdx: index('login_history_created_idx').on(t.createdAt) }),
);

/**
 * Users mirrored from the media server. No local passwords are ever stored.
 * A person with accounts on two servers is two rows — identities are not merged.
 */
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // No REFERENCES: SQLite cannot add a foreign key with ALTER TABLE, so deleting a
    // server removes its users explicitly in deleteServer().
    serverId: integer('server_id').notNull().default(1),
    serverUserId: text('server_user_id').notNull(),
    username: text('username').notNull(),
    email: text('email'),
    avatarUrl: text('avatar_url'),
    // Admin on that user's own media server, and therefore on that server's data only.
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    // Deployment-wide admin: every server, plus server management.
    globalAdmin: integer('global_admin', { mode: 'boolean' }).notNull().default(false),
    // Null means "follow the deployment default". Stored here rather than in a cookie so
    // the same account sees the same language on every device.
    locale: text('locale'),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => ({
    serverUserIdx: uniqueIndex('users_server_user_idx').on(t.serverId, t.serverUserId),
  }),
);

/** Server-side session store. The cookie only carries a signed session id. */
export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(), // random hex, also the cookie value
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverToken: text('server_token').notNull(), // media server access token, encrypted at rest
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ userIdx: index('auth_sessions_user_idx').on(t.userId) }),
);

/** Per-user watchlist. Optionally synced from the Plex watchlist. */
export const watchlist = sqliteTable(
  'watchlist',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(), // media server rating key / item id
    title: text('title').notNull(),
    mediaType: text('media_type').notNull(), // 'movie' | 'show' | 'episode'
    year: integer('year'),
    posterUrl: text('poster_url'),
    status: text('status').notNull().default('planned'), // 'planned' | 'watching' | 'done'
    source: text('source').notNull().default('local'), // 'local' | 'plex'
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => ({ userItemIdx: uniqueIndex('watchlist_user_item_idx').on(t.userId, t.itemId) }),
);

/** Completed / partial playbacks pulled from the media server history API. */
export const watchHistory = sqliteTable(
  'watch_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    title: text('title').notNull(),
    grandparentTitle: text('grandparent_title'), // show name for episodes
    mediaType: text('media_type').notNull(),
    year: integer('year'),
    // JSON array; aggregated with json_each() in the statistics queries.
    genres: text('genres', { mode: 'json' }).$type<string[]>().notNull().default([]),
    watchedAt: integer('watched_at', { mode: 'timestamp_ms' }).notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    deviceName: text('device_name'),
  },
  (t) => ({
    userWatchedIdx: index('watch_history_user_watched_idx').on(t.userId, t.watchedAt),
    dedupeIdx: uniqueIndex('watch_history_dedupe_idx').on(t.userId, t.itemId, t.watchedAt),
  }),
);

/**
 * One row per playback session, kept after the session ends. Rows are upserted while a
 * session is running, which is what makes client, codec and transcoding statistics possible.
 * A session counts as live while it is not 'ended' and was seen in the last poll window.
 */
export const playbackSessions = sqliteTable(
  'playback_sessions',
  {
    sessionKey: text('session_key').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    itemId: text('item_id').notNull(),
    title: text('title').notNull(),
    grandparentTitle: text('grandparent_title'),
    mediaType: text('media_type').notNull(),
    state: text('state').notNull(), // 'playing' | 'paused' | 'buffering' | 'ended'
    progressMs: integer('progress_ms').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),

    clientName: text('client_name'), // e.g. "Jellyfin Web"
    deviceName: text('device_name'), // e.g. "Opera"
    playMethod: text('play_method'), // 'directplay' | 'directstream' | 'transcode'
    videoCodec: text('video_codec'),
    audioCodec: text('audio_codec'),
    container: text('container'),
    width: integer('width'),
    height: integer('height'),
    bitrateKbps: integer('bitrate_kbps'),
    transcodeReason: text('transcode_reason'),
    audioChannels: integer('audio_channels'),
    subtitleCodec: text('subtitle_codec'),
    // What the file itself holds, as opposed to the columns above, which describe what is
    // being delivered. Tautulli's stream panel is only readable because it shows both
    // sides of a transcode ("HEVC 4K → H264 1080p"); with one set of columns the original
    // is lost the moment the server re-encodes it.
    sourceVideoCodec: text('source_video_codec'),
    sourceAudioCodec: text('source_audio_codec'),
    sourceContainer: text('source_container'),
    sourceHeight: integer('source_height'),
    sourceBitrateKbps: integer('source_bitrate_kbps'),
    // Where the stream was delivered to. is_local is derived once on write so every query
    // can filter on it without re-parsing the address.
    remoteAddress: text('remote_address'),
    isLocal: integer('is_local', { mode: 'boolean' }),

    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().default(now),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
    // When the playback position last actually moved. A media server keeps reporting a
    // session after the client vanished, so presence alone does not mean "live".
    progressAt: integer('progress_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => ({
    userIdx: index('playback_sessions_user_idx').on(t.userId),
    lastSeenIdx: index('playback_sessions_last_seen_idx').on(t.lastSeenAt),
  }),
);

/**
 * Everything known about one address, so an enabled lookup does not fire on every page
 * refresh. The country alone was enough for the activity badge; the IP detail dialog wants
 * the full picture, which is one request to the same provider either way.
 */
export const geoipCache = sqliteTable('geoip_cache', {
  ip: text('ip').primaryKey(),
  country: text('country'),
  continent: text('continent'),
  region: text('region'),
  city: text('city'),
  postalCode: text('postal_code'),
  latitude: text('latitude'),
  longitude: text('longitude'),
  timezone: text('timezone'),
  isp: text('isp'),
  organisation: text('organisation'),
  asn: text('asn'),
  // Reverse DNS, resolved locally rather than by the provider — no extra third party.
  host: text('host'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * One row per TMDB lookup, keyed by what was asked for rather than by the TMDB id — the
 * app only ever knows a title, a year and a media type, so that triple is the real cache
 * key. A miss is cached too (payload null): a title the media server has and TMDB does not
 * would otherwise re-search on every page view, forever.
 */
export const tmdbCache = sqliteTable('tmdb_cache', {
  key: text('key').primaryKey(),
  payload: text('payload', { mode: 'json' }),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** Cached suggestion payloads so the heuristic + TMDB lookups are not recomputed per request. */
export const suggestionsCache = sqliteTable('suggestions_cache', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  payload: text('payload', { mode: 'json' }).notNull(),
  generatedAt: integer('generated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});
