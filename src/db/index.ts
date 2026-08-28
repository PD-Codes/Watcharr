import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as schema from './schema';

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

function connect(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  // WAL keeps the sync writes from blocking page reads; foreign keys are off by default.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
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
  return sqlite;
}

// One connection per process; Next.js dev reloads would otherwise open a new handle each time.
const globalForDb = globalThis as unknown as { sqlite?: Database.Database };
const sqlite = globalForDb.sqlite ?? connect();
if (process.env.NODE_ENV !== 'production') globalForDb.sqlite = sqlite;

export const db = drizzle(sqlite, { schema });

/** Closes the connection so the database file can be removed (used by the tests). */
export function closeDb() {
  sqlite.close();
}

/**
 * Consistent snapshot of the live database, taken through better-sqlite3's own backup API
 * rather than copying the file — a plain file copy of a WAL-mode database can land mid-
 * checkpoint and be unreadable. There is deliberately no restore endpoint: swapping the
 * file out from under an open WAL connection is how you corrupt it. Restoring means
 * replacing data/watcharr.db while the process is stopped, which is an operational step,
 * not an HTTP request.
 */
export async function backupTo(path: string): Promise<void> {
  await sqlite.backup(path);
}

/**
 * Returns freed pages to the filesystem after a prune. Deleting rows only marks pages
 * reusable, so a database that shed a year of playback sessions keeps its old size — the
 * one number an operator looks at when they came here to reclaim disk.
 *
 * Rebuilds the file and takes a write lock while it runs, so it is called only when a
 * prune actually deleted something, never on a schedule.
 */
export function vacuum(): void {
  sqlite.exec('VACUUM');
}

export { schema };
