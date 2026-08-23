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
 * Single-row table holding the deployment configuration chosen in the setup wizard.
 * The row always has id = 1; there is exactly one media server per deployment.
 */
export const appConfig = sqliteTable('app_config', {
  id: integer('id').primaryKey().default(1),
  serverType: text('server_type').notNull(), // 'plex' | 'jellyfin' | 'emby'
  serverUrl: text('server_url').notNull(),
  serverToken: text('server_token').notNull(), // admin/server token used for server-wide queries
  serverName: text('server_name'),
  tmdbApiKey: text('tmdb_api_key'),
  features: text('features', { mode: 'json' })
    .$type<Record<string, boolean>>()
    .notNull()
    .default({}),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** Users mirrored from the media server. No local passwords are ever stored. */
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverUserId: text('server_user_id').notNull(),
    username: text('username').notNull(),
    email: text('email'),
    avatarUrl: text('avatar_url'),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => ({ serverUserIdx: uniqueIndex('users_server_user_idx').on(t.serverUserId) }),
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

/** Cached suggestion payloads so the heuristic + TMDB lookups are not recomputed per request. */
export const suggestionsCache = sqliteTable('suggestions_cache', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  payload: text('payload', { mode: 'json' }).notNull(),
  generatedAt: integer('generated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});
