import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { getSettings, updateSettings } from './config';

// Data retention. Three tables grow with every poll and every login and nobody ever looks
// at their oldest rows again; a fourth — watch_history — is the one people would actually
// miss, so it is separated out and stays off unless somebody deliberately turns it on.
//
// Runs from the same activity-sync tick as monitoring, the digest and the automatic
// backup: this app has exactly one clock, and a delete pass does not deserve a second.

const EVERY_MS = 6 * 3_600_000;

type Prune = { table: string; days: number | null; where?: string };

const BATCH = 5000;

/**
 * Deletes in slices with a breath in between. One DELETE over a few hundred thousand rows
 * (the first prune after turning retention on) held the process for tens of seconds — long
 * enough for the container health check to restart it mid-way.
 */
async function deleteInBatches(table: string, where: ReturnType<typeof sql>): Promise<number> {
  const name = sql.raw(table);
  let total = 0;
  for (;;) {
    const result = await db.run(
      sql`DELETE FROM ${name} WHERE rowid IN (SELECT rowid FROM ${name} WHERE ${where} LIMIT ${BATCH})`,
    );
    const changes = Number(result.changes ?? 0);
    total += changes;
    if (changes < BATCH) return total;
    await new Promise((resolve) => setImmediate(resolve)); // let requests in between slices
  }
}

async function deleteOlderThan({ table, days, where }: Prune): Promise<number> {
  if (!days) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  const extra = where ? sql.raw(` AND ${where}`) : sql.raw('');
  return deleteInBatches(table, sql`created_at < ${cutoff}${extra}`);
}

/**
 * notification_log grows with every delivery attempt and is only read as "what went out lately",
 * so it is capped even when no log retention is configured. A shorter configured period wins.
 */
export const NOTIFICATION_LOG_MAX_DAYS = 90;
/** GeoIP answers are cached for good otherwise; an address's owner and place drift over months. */
export const GEOIP_CACHE_MAX_DAYS = 180;

/** The configured log retention, but never longer than the notification log's own cap. */
export function notificationLogDays(retentionLogDays: number | null): number {
  return retentionLogDays ? Math.min(retentionLogDays, NOTIFICATION_LOG_MAX_DAYS) : NOTIFICATION_LOG_MAX_DAYS;
}

/**
 * Old logins, except the newest successful one per (user, address) among those past the cutoff.
 *
 * monitor.ts::checkNewAddresses alerts on a successful login from an address the account has
 * "never used", which it can only tell from this table. Pruned plainly, every device that
 * signs in less often than the retention period (a TV at the holiday flat, a tablet once a
 * month) would be reported as a new address on each return. One old row per pair is enough to
 * prove the address is known, and it costs one row per device rather than the whole log.
 * Failed attempts and logins without a user or address are pruned as before.
 */
async function pruneLogins(days: number | null): Promise<number> {
  if (!days) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  return deleteInBatches(
    'login_history',
    sql`created_at < ${cutoff} AND NOT (
      success = 1 AND user_id IS NOT NULL AND ip IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM login_history newer
        WHERE newer.user_id = login_history.user_id
          AND newer.ip = login_history.ip
          AND newer.success = 1
          AND newer.created_at < ${cutoff}
          AND (newer.created_at > login_history.created_at
            OR (newer.created_at = login_history.created_at AND newer.id > login_history.id))
      )
    )`,
  );
}

/**
 * One pass over everything with a configured cutoff, plus the two caps that apply without one.
 * Returns how many rows went, so the caller can tell "retention is off" apart from "there was
 * nothing left to delete".
 *
 * No VACUUM here any more: it rewrites the whole file while holding the database, which on
 * a large one froze every request. Freed pages are reused right away; giving them back to the
 * disk happens at the next start (scripts/migrate.mjs), before the server takes requests.
 */
export async function prune(): Promise<number> {
  const settings = await getSettings();
  let deleted = 0;

  deleted += await pruneLogins(settings.retentionLogDays);
  deleted += await deleteOlderThan({ table: 'notification_log', days: notificationLogDays(settings.retentionLogDays) });
  deleted += await deleteOlderThan({ table: 'monitor_alerts', days: settings.retentionLogDays });
  // A cache, not a record: a lookup that is gone is simply asked again when the address shows up.
  deleted += await deleteInBatches(
    'geoip_cache',
    sql`fetched_at < ${Date.now() - GEOIP_CACHE_MAX_DAYS * 86_400_000}`,
  );

  if (settings.retentionSessionDays) {
    // Only sessions that have actually finished: a long film paused since yesterday is
    // still live, and ending it here would take a running stream off "Now Playing".
    const cutoff = Date.now() - settings.retentionSessionDays * 86_400_000;
    deleted += await deleteInBatches('playback_sessions', sql`state = 'ended' AND last_seen_at < ${cutoff}`);
  }

  if (settings.retentionHistoryDays) {
    const cutoff = Date.now() - settings.retentionHistoryDays * 86_400_000;
    deleted += await deleteInBatches('watch_history', sql`watched_at < ${cutoff}`);
  }
  return deleted;
}

/**
 * Called from the activity sync; does nothing until the interval has elapsed. Runs even with
 * every retention setting empty, because the notification log and the GeoIP cache are capped
 * regardless.
 */
export async function checkRetention(): Promise<void> {
  const settings = await getSettings();
  if (settings.retentionLastAt && Date.now() - settings.retentionLastAt.getTime() < EVERY_MS) {
    return;
  }
  await updateSettings({ retentionLastAt: new Date() });
  await prune();
}
