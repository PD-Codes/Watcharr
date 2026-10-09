import 'server-only';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backupTo, DB_PATH } from '@/db';
import { getSettings, updateSettings } from './config';
import { globalState } from './state';

// Periodic snapshots on top of the on-demand download in /api/admin/backup, same reasoning
// as the digest and the monitoring thresholds: checked from the one existing sync tick
// instead of a separate scheduler or an OS-level cron entry the container would need to own.

const BACKUP_DIR = join(dirname(DB_PATH), 'backups');
const PREFIX = 'watcharr-';

// Without the guard, every sync pass that lands while a large snapshot is still being written
// sees the old backupLastAt and starts another one, and the copies evict the older, distinct
// backups through the count-based retention. Process-wide (see state.ts), or each graph
// would run its own.
const guard = globalState('autobackup', () => ({ busy: false, retryAt: 0 }));
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

export async function checkAutoBackup() {
  if (guard.busy || Date.now() < guard.retryAt) return;
  guard.busy = true;
  try {
    await runAutoBackup();
  } catch (error) {
    // A failed run leaves backupLastAt untouched, so the next five-second pass would try (and
    // read the whole database) again — against a full disk that is a retry loop, not a retry.
    guard.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
    throw error;
  } finally {
    guard.busy = false;
  }
}

async function runAutoBackup() {
  const settings = await getSettings();
  if (!settings.backupAutoEnabled) return;

  const due =
    !settings.backupLastAt ||
    Date.now() - settings.backupLastAt.getTime() >= settings.backupIntervalHours * 3_600_000;
  if (!due) return;

  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await backupTo(join(BACKUP_DIR, `${PREFIX}${stamp}.db`));
  await updateSettings({ backupLastAt: new Date() });
  await pruneOldBackups(settings.backupRetention);
}

async function pruneOldBackups(keep: number) {
  const files = (await readdir(BACKUP_DIR).catch(() => []))
    .filter((name) => name.startsWith(PREFIX) && name.endsWith('.db'))
    .sort(); // ISO timestamp in the filename sorts chronologically as text

  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    await rm(join(BACKUP_DIR, name)).catch(() => {});
  }
}

export interface BackupFile {
  name: string;
  size: number;
  createdAt: Date;
}

export async function listAutoBackups(): Promise<BackupFile[]> {
  const files = (await readdir(BACKUP_DIR).catch(() => [])).filter(
    (name) => name.startsWith(PREFIX) && name.endsWith('.db'),
  );
  const withStats = await Promise.all(
    files.map(async (name) => {
      const info = await stat(join(BACKUP_DIR, name));
      return { name, size: info.size, createdAt: info.mtime };
    }),
  );
  return withStats.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
