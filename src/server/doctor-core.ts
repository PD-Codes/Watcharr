// The rules behind the system check, free of I/O so they can be tested. doctor.ts gathers the
// facts; this decides what they mean. Each check has an id, and the page looks up its texts as
// `doctor.<id>` (title) and `doctor.<id>.<level>` (message).

export type Level = 'ok' | 'warn' | 'fail';

export interface DoctorInput {
  secretIsPlaceholder: boolean;
  appUrlSet: boolean;
  tmdbConfigured: boolean;
  emailChannel: boolean;
  newsletterEnabled: boolean;
  timezoneSet: boolean;
  backup: { autoEnabled: boolean; intervalHours: number; lastAutoAt: number | null; newestAt: number | null };
  disk: { freeBytes: number | null; dbBytes: number };
  downServers: string[];
  pendingMigrations: number;
  updateAvailable: string | null;
  importInterrupted: boolean;
  restorePending: boolean;
}

export interface Check {
  id: string;
  level: Level;
  params?: Record<string, string | number>;
}

const DAY = 86_400_000;
const GB = 1024 ** 3;

export function evaluateDoctor(i: DoctorInput, now = Date.now()): Check[] {
  const checks: Check[] = [];
  const add = (id: string, level: Level, params?: Check['params']) => checks.push({ id, level, params });

  add('secret', i.secretIsPlaceholder ? 'fail' : 'ok');
  add('migrations', i.pendingMigrations > 0 ? 'fail' : 'ok', { count: i.pendingMigrations });
  add('servers', i.downServers.length ? 'fail' : 'ok', { servers: i.downServers.join(', ') });

  // Backups: scheduled ones that have stopped are worse than none that were never wanted.
  const staleAfter = Math.max(i.backup.intervalHours, 1) * 3_600_000 * 2;
  if (i.backup.autoEnabled && (!i.backup.lastAutoAt || now - i.backup.lastAutoAt > staleAfter)) {
    add('backup', 'fail');
  } else if (!i.backup.autoEnabled && (!i.backup.newestAt || now - i.backup.newestAt > 30 * DAY)) {
    add('backup', 'warn');
  } else {
    add('backup', 'ok');
  }

  const free = i.disk.freeBytes;
  if (free === null) add('disk', 'ok', { free: '?' });
  else {
    // A backup, a VACUUM and an import each need room about the size of the database.
    const level: Level = free < 0.2 * GB ? 'fail' : free < Math.max(GB, i.disk.dbBytes * 2) ? 'warn' : 'ok';
    add('disk', level, { free: (free / GB).toFixed(1) });
  }

  add('update', i.updateAvailable ? 'warn' : 'ok', { version: i.updateAvailable ?? '' });
  add('import', i.importInterrupted ? 'warn' : 'ok');
  add('restore', i.restorePending ? 'warn' : 'ok');
  add('email', i.newsletterEnabled && !i.emailChannel ? 'warn' : 'ok');
  add('appUrl', i.appUrlSet ? 'ok' : 'warn');
  add('tmdb', i.tmdbConfigured ? 'ok' : 'warn');
  add('timezone', i.timezoneSet ? 'ok' : 'warn');
  return checks;
}

/** Worst first, so what needs attention is on top. Stable within a level. */
export function sortChecks(checks: Check[]): Check[] {
  const rank: Record<Level, number> = { fail: 0, warn: 1, ok: 2 };
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => rank[a.check.level] - rank[b.check.level] || a.index - b.index)
    .map((x) => x.check);
}
