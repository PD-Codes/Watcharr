import 'server-only';
import { sql } from 'drizzle-orm';
import { db, vacuum } from '@/db';
import { getSettings, updateSettings } from './config';

// Data retention. Three tables grow with every poll and every login and nobody ever looks
// at their oldest rows again; a fourth — watch_history — is the one people would actually
// miss, so it is separated out and stays off unless somebody deliberately turns it on.
//
// Runs from the same activity-sync tick as monitoring, the digest and the automatic
// backup: this app has exactly one clock, and a delete pass does not deserve a second.

const EVERY_MS = 6 * 3_600_000;

type Prune = { table: string; days: number | null; where?: string };

async function deleteOlderThan({ table, days, where }: Prune): Promise<number> {
  if (!days) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  const extra = where ? sql.raw(` AND ${where}`) : sql.raw('');
  // db.run reports how many rows the statement touched, which is what decides whether the
  // VACUUM below is worth its write lock.
  const result = await db.run(
    sql`DELETE FROM ${sql.raw(table)} WHERE created_at < ${cutoff}${extra}`,
  );
  return Number(result.changes ?? 0);
}

/**
 * One pass over everything with a configured cutoff. Returns how many rows went, so the
 * caller can tell "retention is off" apart from "there was nothing left to delete".
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
    const result = await db.run(
      sql`DELETE FROM playback_sessions WHERE state = 'ended' AND last_seen_at < ${cutoff}`,
    );
    deleted += Number(result.changes ?? 0);
  }

  if (settings.retentionHistoryDays) {
    const cutoff = Date.now() - settings.retentionHistoryDays * 86_400_000;
    const result = await db.run(sql`DELETE FROM watch_history WHERE watched_at < ${cutoff}`);
    deleted += Number(result.changes ?? 0);
  }

  // Freed pages are only reusable, not returned, so the file keeps its size — the one
  // number an operator came here to reduce. Skipped when nothing was deleted, because the
  // rebuild takes a write lock over the whole database.
  if (deleted > 0) vacuum();
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
