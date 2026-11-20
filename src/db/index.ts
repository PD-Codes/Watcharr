import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, readdirSync } from 'node:fs';
import { rename, rm, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as schema from './schema';
import { readerCount, startReaders, stopReaders } from './readers';
import { chooseLocking, remoteFileSystem, type LockingMode } from './storage';

export const DB_PATH = process.env.DATABASE_PATH ?? './data/watcharr.db';

/**
 * Migrations run once at startup (`node scripts/migrate.mjs && next dev`), so a migration
 * added while the server is already running is never applied — and every page then fails
 * with a bare *"no such column"* from deep inside a query, which says nothing about the
 * cause. Checking here turns that into one sentence naming the fix.
 *
 * Deliberately only a check, not a second implementation of the apply loop: applying
 * schema changes from inside the request path would race with the migrate script that may
 * be running at the same time.
 */
function warnAboutPendingMigrations(sqlite: Database.Database) {
  try {
    const files = readdirSync(join(process.cwd(), 'drizzle'))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const applied = new Set(
      sqlite
        .prepare('SELECT name FROM _migrations')
        .all()
        .map((row) => (row as { name: string }).name),
    );
    const pending = files.filter((file) => !applied.has(file));
    if (pending.length) {
      console.error(
        `\n[watcharr] ${pending.length} migration(s) have not been applied: ${pending.join(', ')}.\n` +
          `[watcharr] The schema is older than the code, so pages will fail with "no such column".\n` +
          `[watcharr] Restart the app (npm run dev / docker compose restart) or run: npm run db:migrate\n`,
      );
    }
  } catch {
    // No drizzle folder or no _migrations table yet: nothing to compare against, and this
    // check must never be the reason a working install refuses to start.
  }
}

/**
 * Applies a configured IANA zone to the process.
 *
 * Every date aggregate in the app buckets with SQLite's 'localtime' modifier, which reads
 * the process time zone — so a container running in UTC put an evening in Berlin into the
 * wrong day and the wrong hour, silently and only for the people it applied to. Rather
 * than passing an offset into a few dozen strftime() calls (and getting DST wrong at every
 * one of them), the zone is set once here: assigning process.env.TZ calls tzset(), which
 * is exactly what both Node's Date and SQLite's date functions consult.
 *
 * An invalid zone is ignored rather than applied — an unrecognised TZ silently means UTC,
 * which would look like the bug this fixes.
 */
// The zone the process started with (the container's TZ), restored when the setting is cleared.
const startTzHolder = globalThis as { __watcharrStartTz?: string | null };
startTzHolder.__watcharrStartTz ??= process.env.TZ ?? null;
const startupTz = startTzHolder.__watcharrStartTz;

export function applyTimezone(zone: string | null | undefined): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    console.warn(`[watcharr] ignoring unknown time zone "${zone}"; using the container's`);
    return false;
  }
  process.env.TZ = zone;
  return true;
}

/** Back to the zone the process started with; clearing the setting must not need a restart. */
export function resetTimezone(): void {
  if (startupTz) process.env.TZ = startupTz;
  else delete process.env.TZ;
}

/** How the connection ended up configured, for the system check and the startup log. */
export interface DbInfo {
  journalMode: string;
  locking: LockingMode;
  /** The risky file system the data folder is on, or null for a local disk. */
  remoteFs: string | null;
}

function connect(): { sqlite: Database.Database; info: DbInfo } {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const remoteFs = remoteFileSystem(dirname(DB_PATH));
  const locking = chooseLocking(process.env.WATCHARR_DB_LOCKING, remoteFs);
  const sqlite = new Database(DB_PATH);
  // Before journal_mode, or WAL would already have mapped the -shm file: in exclusive mode the
  // WAL index lives in process memory and no lock is taken or released per transaction.
  if (locking === 'exclusive') sqlite.pragma('locking_mode = EXCLUSIVE');
  // WAL keeps the sync writes from blocking page reads; foreign keys are off by default.
  const journalMode = String(sqlite.pragma('journal_mode = WAL', { simple: true }));
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  // NORMAL is the documented setting for WAL: a commit no longer waits for an fsync (only a
  // checkpoint does), and a crash can at worst lose the last commits, never corrupt the file.
  // With FULL every one of the dozens of small writes per sync tick paid a disk flush on the
  // request thread, which on a NAS or a busy disk is where the multi-second stalls came from.
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('cache_size = -32000');
  // A large import or VACUUM can grow the WAL to the size of the database; truncate it back
  // after the checkpoint instead of keeping the high-water mark on disk for good.
  sqlite.pragma('journal_size_limit = 67108864');
  if (journalMode !== 'wal') {
    console.warn(
      `[watcharr] SQLite runs in "${journalMode}" journal mode instead of WAL, so every write ` +
        `blocks every read. The data folder's file system does not support WAL; move it to a local disk.`,
    );
  }
  if (remoteFs) {
    console.warn(
      `[watcharr] The database is on a ${remoteFs} file system (${dirname(DB_PATH)}). ` +
        (locking === 'exclusive'
          ? 'Running with an exclusive lock so SQLite does not depend on its file locking; parallel readers are off.'
          : 'WATCHARR_DB_LOCKING=normal is set, so expect "database is locked" errors. A local volume is strongly recommended.'),
    );
  }
  warnAboutPendingMigrations(sqlite);
  // Read raw rather than through server/config.ts: that module imports this one, and the
  // zone has to be in place before the first date query runs.
  try {
    const row = sqlite.prepare('SELECT timezone FROM app_settings WHERE id = 1').get() as
      | { timezone: string | null }
      | undefined;
    applyTimezone(row?.timezone);
  } catch {
    // No settings row or no column yet (a database that has not been migrated): the
    // container's own zone applies, which is the behaviour this setting replaced.
  }
  return { sqlite, info: { journalMode, locking, remoteFs } };
}

// One connection per process. Kept on globalThis in production too, not only in development:
// Next bundles instrumentation.ts and the request handlers as separate module graphs, and each
// graph used to open its own handle (and print the migration warning and open the settings row
// once more).
const globalForDb = globalThis as unknown as { sqlite?: Database.Database; dbInfo?: DbInfo };
if (!globalForDb.sqlite) {
  const opened = connect();
  globalForDb.sqlite = opened.sqlite;
  globalForDb.dbInfo = opened.info;
  // Readers need a second connection to the file, which exclusive locking rules out.
  if (opened.info.locking === 'normal' && opened.info.journalMode === 'wal') {
    startReaders(DB_PATH, readerCount());
  }
}
const sqlite = globalForDb.sqlite;

export const dbInfo = (): DbInfo =>
  globalForDb.dbInfo ?? { journalMode: 'unknown', locking: 'normal', remoteFs: null };

export const db = drizzle(sqlite, { schema });

// A stop should leave one clean file instead of a -wal/-shm pair the next start has to recover
// (Next calls process.exit on SIGTERM, which lands here). Closing checkpoints only when this is
// the last connection, and the reader threads may still hold theirs — the SIGTERM handler in
// instrumentation-node.ts stops them first, but any other exit gets here with them running.
// So the checkpoint is explicit: TRUNCATE needs no other connection gone, only none of them in
// the middle of a read, and leaves an empty WAL even when the close cannot remove it.
if (!(globalThis as { dbExitHook?: boolean }).dbExitHook) {
  (globalThis as { dbExitHook?: boolean }).dbExitHook = true;
  process.once('exit', () => closeForExit(sqlite));
}

/** Checkpoint and close, never throwing: an exit hook has nobody to report to. */
export function closeForExit(connection: Database.Database): void {
  try {
    if (!connection.open) return;
    // Short: a reader in the middle of a query holds the WAL, and the default five seconds
    // would stretch every stop by that long for a checkpoint the next start does anyway.
    connection.pragma('busy_timeout = 250');
    connection.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Busy or not in WAL mode: closing still leaves a consistent database.
  }
  try {
    connection.close();
  } catch {
    // Already closed (tests): nothing left to checkpoint.
  }
}

/** Closes the connection so the database file can be removed (used by the tests). */
export function closeDb() {
  void stopReaders();
  sqlite.close();
}

/** Thrown when the target folder has no room for a snapshot; the caller says so instead of a 500. */
export class InsufficientSpaceError extends Error {
  constructor(
    readonly neededBytes: number,
    readonly freeBytes: number,
  ) {
    super(
      `Not enough free disk space for a backup: ${Math.round(freeBytes / 1024 ** 2)} MB free, ` +
        `about ${Math.round(neededBytes / 1024 ** 2)} MB needed`,
    );
    this.name = 'InsufficientSpaceError';
  }
}

/** Suffix of a snapshot that is still being written. Never counted as a backup. */
export const PARTIAL_SUFFIX = '.partial';

/** Size of the database's pages — what a snapshot of it will roughly take. */
export function databaseBytes(): number {
  return Number(sqlite.pragma('page_count', { simple: true })) * Number(sqlite.pragma('page_size', { simple: true }));
}

/**
 * Refuses when the folder cannot take a snapshot with some room to spare: a backup that fills
 * the volume takes the live database down with it, because that is the file that then cannot
 * grow. An unknown free space (statfs unsupported) is not a reason to refuse.
 */
export async function assertSpaceFor(dir: string, bytes = databaseBytes()): Promise<void> {
  const fs = await statfs(dir).catch(() => null);
  if (!fs) return;
  const free = Number(fs.bavail) * Number(fs.bsize);
  const needed = Math.ceil(bytes * 1.2);
  if (free < needed) throw new InsufficientSpaceError(needed, free);
}

/**
 * Consistent snapshot of the live database, taken through better-sqlite3's own backup API
 * rather than copying the file — a plain file copy of a WAL-mode database can land mid-
 * checkpoint and be unreadable. Restoring is never done under the open connection: it is
 * staged and applied by scripts/migrate.mjs at the next start.
 *
 * Written to <path>.partial and renamed when complete, so a crash or a full disk never leaves
 * a truncated file under a name that looks like a backup (the rotation would count it, and a
 * restore would pick it). The free space is checked first for the same reason.
 */
export async function backupTo(path: string): Promise<void> {
  await assertSpaceFor(dirname(path));
  const partial = `${path}${PARTIAL_SUFFIX}`;
  try {
    await sqlite.backup(partial);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Returns freed pages to the filesystem after a prune. Deleting rows only marks pages
 * reusable, so a database that shed a year of playback sessions keeps its old size — the
 * one number an operator looks at when they came here to reclaim disk.
 *
 * Rebuilds the file and takes a write lock while it runs, so it is called only when a
 * prune actually deleted something, never on a schedule. Returns whether it ran.
 */
export function vacuum(): boolean {
  // Only worth its cost when a real share of the file is free: VACUUM rewrites the whole
  // database on the request thread and holds the write lock throughout. Before this check it
  // ran after every six-hourly prune that deleted a single log row — on a database of a few
  // hundred megabytes that was the half-minute freeze nobody could explain.
  const free = Number(sqlite.pragma('freelist_count', { simple: true }));
  const total = Number(sqlite.pragma('page_count', { simple: true }));
  if (!total || free / total < VACUUM_FREE_SHARE) return false;
  sqlite.exec('VACUUM');
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  return true;
}

/** Share of free pages from which a VACUUM pays for itself. */
export const VACUUM_FREE_SHARE = 0.25;

export { schema };
