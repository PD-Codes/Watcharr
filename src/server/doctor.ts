import 'server-only';
import { readdirSync, statSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { db, DB_PATH } from '@/db';
import { createAdapter, type ServerType } from './adapters';
import { listAutoBackups } from './autobackup';
import { listBackups, pendingRestore } from './backups';
import { getSettings, listServers } from './config';
import { evaluateDoctor, sortChecks, type Check } from './doctor-core';
import { getJob } from './importjob';
import { listChannels } from './notifications';
import { getUpdateStatus } from './update';

/** Gathers the facts for the system check. Every probe is allowed to fail on its own. */
export async function runDoctor(): Promise<{ checks: Check[]; usage: { label: string; bytes: number }[] }> {
  const settings = await getSettings();
  const dataDir = dirname(DB_PATH);

  const size = (path: string) => stat(path).then((s) => s.size, () => 0);
  const [dbBytes, walBytes, backups, auto, free, servers, update, job, restore, channels] = await Promise.all([
    size(DB_PATH),
    size(`${DB_PATH}-wal`),
    listBackups(),
    listAutoBackups(),
    statfs(dataDir).then((f) => f.bavail * f.bsize, () => null),
    listServers(),
    getUpdateStatus(settings).catch(() => null),
    getJob(),
    pendingRestore(),
    listChannels(),
  ]);

  const down = (
    await Promise.all(
      servers.map(async (server) =>
        (await createAdapter(server.serverType as ServerType, server.serverUrl, server.serverToken)
          .ping()
          .catch(() => ({ ok: false }))).ok
          ? null
          : server.label,
      ),
    )
  ).filter((label): label is string => label !== null);

  // Applied migrations against the files shipped with this build.
  let pending = 0;
  try {
    const applied = new Set(
      (db.all('SELECT name FROM _migrations') as { name: string }[]).map((row) => row.name),
    );
    pending = readdirSync(join(process.cwd(), 'drizzle')).filter((f) => f.endsWith('.sql') && !applied.has(f)).length;
  } catch {
    // No drizzle folder next to the build: nothing to compare against.
  }

  const checks = evaluateDoctor({
    secretIsPlaceholder:
      !process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me' || process.env.SESSION_SECRET.length < 16,
    appUrlSet: Boolean(process.env.APP_URL),
    tmdbConfigured: Boolean(settings.tmdbApiKey),
    emailChannel: channels.some((c) => c.type === 'email' && c.enabled),
    newsletterEnabled: settings.newsletterEnabled,
    timezoneSet: Boolean(settings.timezone),
    backup: {
      autoEnabled: settings.backupAutoEnabled,
      intervalHours: settings.backupIntervalHours,
      lastAutoAt: settings.backupLastAt?.getTime() ?? auto[0]?.createdAt.getTime() ?? null,
      newestAt: backups[0]?.createdAt.getTime() ?? null,
    },
    disk: { freeBytes: free, dbBytes },
    downServers: down,
    pendingMigrations: pending,
    updateAvailable: update?.outdated ? update.latest : null,
    importInterrupted: job?.status === 'interrupted',
    restorePending: restore !== null,
  });

  const importsDir = join(dataDir, 'imports');
  const dirBytes = (dir: string) => {
    try {
      return readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
    } catch {
      return 0;
    }
  };
  return {
    checks: sortChecks(checks),
    usage: [
      { label: 'database', bytes: dbBytes },
      { label: 'wal', bytes: walBytes },
      { label: 'backups', bytes: backups.reduce((sum, b) => sum + b.size, 0) },
      { label: 'imports', bytes: dirBytes(importsDir) },
    ],
  };
}
