import 'server-only';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { monitorAlerts, playbackSessions, users } from '@/db/schema';
import { getSettings } from './config';
import { liveSessionFilter } from './sync';
import { notify } from './notifications';

// Threshold checks over the live session table and the login history. Runs from the same
// activity-sync tick as everything else in sync.ts — there is no separate poller, this app
// has exactly one.

const COOLDOWN_MS = 15 * 60_000;
const lastAlertAt = new Map<string, number>();

function cooled(rule: string): boolean {
  const last = lastAlertAt.get(rule) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return true;
  lastAlertAt.set(rule, Date.now());
  return false;
}

/** Notifies every subscribed channel and records the firing, so past alerts stay visible
 * after the in-memory cooldown map resets on restart. */
async function fire(rule: string, message: string, value: number, threshold?: number) {
  notify('monitor.alert', { rule, message, value, threshold });
  try {
    await db.insert(monitorAlerts).values({ rule, message, value, threshold: threshold ?? null });
  } catch {
    // The history is a convenience; a write failure must not stop the alert itself.
  }
}

/**
 * Evaluates per-user concurrent stream count, total delivered bandwidth, whether any
 * transcode is running, and repeated failed logins, against the thresholds configured on
 * Settings. Each rule fires at most once per cooldown window so a stuck-over-threshold
 * state does not spam the channels on every five-second poll.
 */
export async function checkThresholds() {
  const settings = await getSettings();

  if (settings.monitorMaxStreamsPerUser || settings.monitorBandwidthMbps || settings.monitorTranscodeAlert) {
    const live = await db
      .select({
        userId: playbackSessions.userId,
        username: users.username,
        bitrateKbps: playbackSessions.bitrateKbps,
        playMethod: playbackSessions.playMethod,
      })
      .from(playbackSessions)
      .leftJoin(users, eq(users.id, playbackSessions.userId))
      .where(liveSessionFilter());

    if (settings.monitorMaxStreamsPerUser) {
      const perUser = new Map<string, number>();
      for (const row of live) {
        const key = row.username ?? 'unknown';
        perUser.set(key, (perUser.get(key) ?? 0) + 1);
      }
      for (const [username, count] of perUser) {
        if (count <= settings.monitorMaxStreamsPerUser) continue;
        if (cooled(`streams:${username}`)) continue;
        await fire(
          'max_streams_per_user',
          `${username} has ${count} concurrent streams (limit ${settings.monitorMaxStreamsPerUser})`,
          count,
          settings.monitorMaxStreamsPerUser,
        );
      }
    }

    if (settings.monitorBandwidthMbps) {
      const totalMbps = Math.round(live.reduce((sum, row) => sum + (row.bitrateKbps ?? 0), 0) / 1000);
      if (totalMbps > settings.monitorBandwidthMbps && !cooled('bandwidth')) {
        await fire(
          'bandwidth',
          `Total delivered bandwidth is ${totalMbps} Mbps (limit ${settings.monitorBandwidthMbps})`,
          totalMbps,
          settings.monitorBandwidthMbps,
        );
      }
    }

    if (settings.monitorTranscodeAlert) {
      const transcoding = live.filter((row) => row.playMethod === 'transcode');
      if (transcoding.length > 0 && !cooled('transcode')) {
        await fire('transcode', `${transcoding.length} stream(s) currently transcoding`, transcoding.length);
      }
    }
  }

  if (settings.monitorFailedLoginThreshold) {
    await checkFailedLogins(settings.monitorFailedLoginThreshold, settings.monitorFailedLoginWindowMin);
  }
}

/** Repeated failed logins from the same IP within the configured window — a brute-force tell. */
async function checkFailedLogins(threshold: number, windowMin: number) {
  const rows = await db.all<{ ip: string; attempts: number }>(sql`
    SELECT ip, count(*) AS attempts
    FROM login_history
    WHERE success = 0
      AND ip IS NOT NULL
      AND created_at >= (unixepoch('now', ${`-${windowMin} minutes`}) * 1000)
    GROUP BY ip
    HAVING attempts >= ${threshold}
  `);

  for (const row of rows) {
    if (cooled(`failed_login:${row.ip}`)) continue;
    await fire(
      'failed_logins',
      `${row.attempts} failed logins from ${row.ip} in the last ${windowMin} minutes`,
      row.attempts,
      threshold,
    );
  }
}

export interface AlertEntry {
  id: number;
  rule: string;
  message: string;
  value: number | null;
  threshold: number | null;
  createdAt: Date;
}

export async function listAlerts(limit = 50): Promise<AlertEntry[]> {
  return db.select().from(monitorAlerts).orderBy(desc(monitorAlerts.createdAt)).limit(limit);
}
