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
 * One pass over everything with a configured cutoff. Returns how many rows went, so the
 * caller can tell "retention is off" apart from "there was nothing left to delete".
 *
 * No VACUUM here any more: it rewrites the whole file while holding the database, which on
 * a large one froze every request. Freed pages are reused right away; giving them back to the
 * disk happens at the next start (scripts/migrate.mjs), before the server takes requests.
 */
export async function prune(): Promise<number> {
  const settings = await getSettings();
  let deleted = 0;

  deleted += await deleteOlderThan({ table: 'login_history', days: settings.retentionLogDays });
  deleted += await deleteOlderThan({ table: 'notification_log', days: settings.retentionLogDays });
  deleted += await deleteOlderThan({ table: 'monitor_alerts', days: settings.retentionLogDays });

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

/** Called from the activity sync; does nothing until the interval has elapsed. */
export async function checkRetention(): Promise<void> {
  const settings = await getSettings();
  if (!settings.retentionSessionDays && !settings.retentionLogDays && !settings.retentionHistoryDays) {
    return;
  }
  if (settings.retentionLastAt && Date.now() - settings.retentionLastAt.getTime() < EVERY_MS) {
    return;
  }
  await updateSettings({ retentionLastAt: new Date() });
  await prune();
}
