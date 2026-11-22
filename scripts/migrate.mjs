import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';

// Applies drizzle-kit generated SQL files at startup, in both Docker and plain node runs.
// Next.js loads .env by itself, plain node does not — so DATABASE_PATH would otherwise
// differ between this script and the app.
try {
  process.loadEnvFile();
} catch {
  // No .env file present, which is fine when the environment is set another way.
}

const dbPath = process.env.DATABASE_PATH ?? './data/watcharr.db';
mkdirSync(dirname(dbPath), { recursive: true });

/**
 * SQLite reports an unwritable volume as "attempt to write a readonly database" from deep inside
 * the first migration, which says nothing about the cause. In a container it is almost always
 * ownership: a volume or bind mount created by root, while the image runs as the node user.
 * The directory matters as much as the file (SQLite creates the -wal/-shm/-journal files next to it).
 */
function assertWritable() {
  const targets = [dirname(dbPath), dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(
    (path, index) => index === 0 || existsSync(path),
  );
  for (const path of targets) {
    try {
      accessSync(path, constants.W_OK);
    } catch (error) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
      console.error(
        `\nCannot write to ${path} (${error.code}). Running as uid ${uid}.\n` +
          'The database folder must be writable by the user the container runs as (node, uid 1000).\n' +
          'Fix the owner of the data volume or folder, for example:\n' +
          '  docker compose down\n' +
          '  docker run --rm -v <volume-or-folder>:/data busybox chown -R 1000:1000 /data\n' +
          '  docker compose up -d\n' +
          'A read-only mount (":ro") on the data folder causes the same error.\n',
      );
      process.exit(1);
    }
  }
}
assertWritable();

/**
 * A restore staged from the Backups page. The swap has to happen here, before anything holds
 * the database open: replacing the file under a live WAL connection is how a database gets
 * corrupted, which is why the web app only writes a marker and asks for a restart.
 *
 * The database being replaced is copied to backups/pre-restore-<stamp>.db first, so a
 * restore of the wrong file is itself undoable. Any problem leaves the current database as it
 * is and drops the marker, rather than retrying on every start.
 */
function applyStagedRestore() {
  const marker = join(dirname(dbPath), 'restore-pending.json');
  if (!existsSync(marker)) return;
  try {
    const { file } = JSON.parse(readFileSync(marker, 'utf8'));
    // A bare file name inside backups/ — the marker is a file on disk, so it is not trusted.
    if (typeof file !== 'string' || file !== basename(file) || !file.endsWith('.db')) {
      throw new Error('invalid backup name in restore marker');
    }
    const backupDir = join(dirname(dbPath), 'backups');
    const source = join(backupDir, file);
    if (!existsSync(source)) throw new Error(`${file} is gone`);

    const check = new Database(source, { readonly: true, fileMustExist: true });
    const verdict = check.pragma('quick_check', { simple: true });
    check.close();
    if (verdict !== 'ok') throw new Error(`${file} failed its integrity check: ${verdict}`);

    if (existsSync(dbPath)) {
      mkdirSync(backupDir, { recursive: true });
      const current = new Database(dbPath);
      current.pragma('wal_checkpoint(TRUNCATE)');
      current.close();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(dbPath, join(backupDir, `pre-restore-${stamp}.db`));
    }
    copyFileSync(source, `${dbPath}.restoring`);
    for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    renameSync(`${dbPath}.restoring`, dbPath);
    console.log(`restored the database from backups/${file}`);
  } catch (error) {
    console.error(`restore skipped, the current database is untouched: ${error.message}`);
  } finally {
    rmSync(marker, { force: true });
    rmSync(`${dbPath}.restoring`, { force: true });
  }
}
applyStagedRestore();

/**
 * "attempt to write a readonly database" with a writable folder is what SQLite says when it cannot
 * recover or map the WAL index — typically after the previous process was killed without closing
 * the database, on a volume without working shared-memory locking (network share, some bind mounts).
 * The -shm file only caches the -wal and is rebuilt from it, so it is the one file that is safe to drop.
 */
function explainReadonly(error) {
  const listing = ['', '-wal', '-shm']
    .map((suffix) => `${dbPath}${suffix}`)
    .filter((path) => existsSync(path))
    .map((path) => {
      const info = statSync(path);
      return `  ${path}  ${info.size} bytes  uid ${info.uid}  mode ${(info.mode & 0o777).toString(8)}`;
    });
  console.error(
    `\nThe database could not be written (${error.code}) although the folder is writable.\n` +
      `Files:\n${listing.join('\n')}\n` +
      'This usually follows a container that was killed instead of stopped. With the app stopped, delete only\n' +
      `${dbPath}-shm (keep the .db and -wal files, they hold the data) and start again, e.g.:\n` +
      '  docker run --rm -v <volume-or-folder>:/data busybox rm -f /data/watcharr.db-shm\n' +
      'If it keeps happening, the data folder is probably on a network share or a mount without file locking;\n' +
      'use a Docker named volume instead.\n',
  );
}

/**
 * A backup is written as <name>.partial and renamed when complete (src/db/index.ts::backupTo).
 * Whatever is still called .partial now was cut off by a crash or a full disk, and nothing is
 * writing to it before the server starts.
 */
function removePartialBackups() {
  const backupDir = join(dirname(dbPath), 'backups');
  if (!existsSync(backupDir)) return;
  for (const name of readdirSync(backupDir)) {
    if (!name.endsWith('.partial')) continue;
    rmSync(join(backupDir, name), { force: true });
    console.log(`removed the unfinished backup backups/${name}`);
  }
}
try {
  removePartialBackups();
} catch (error) {
  console.warn(`could not clean up unfinished backups: ${error.message}`);
}

// Mirrors src/server/secret.ts::secretProblem. The image ships scripts/ but not src/, so this
// cannot import it; the ops test holds both to the same verdicts.
const MIN_SECRET_LENGTH = 32;
function secretProblem(value) {
  if (!value?.trim()) return 'missing';
  if (['change-me', 'changeme'].includes(value.trim().toLowerCase())) return 'placeholder';
  if (value.length < MIN_SECRET_LENGTH) return 'short';
  return null;
}

/**
 * Whether anything is stored that depends on the current SESSION_SECRET: servers and channels
 * hold encrypted tokens, sessions are signed with it. Only an install without any of that can
 * be told to pick a new secret for free.
 */
function holdsSecrets(db) {
  const count = (query) => {
    try {
      return Number(db.prepare(query).pluck().get() ?? 0);
    } catch {
      return 0; // a table an older schema does not have yet holds nothing
    }
  };
  return (
    count('SELECT count(*) FROM app_config') +
      count('SELECT count(*) FROM auth_sessions') +
      count('SELECT count(*) FROM plex_tokens') +
      count('SELECT count(*) FROM notification_channels') +
      count('SELECT count(*) FROM app_settings WHERE tmdb_api_key IS NOT NULL OR api_key IS NOT NULL') >
    0
  );
}

/**
 * A weak secret on a new install is refused: nothing is encrypted with it yet, so fixing it now
 * costs one line in .env. On an install that already stored tokens with it, a hard stop would
 * be an outage (a new secret signs everyone out and every token must be entered again), so it is
 * only warned about; the system check keeps showing it.
 *
 * Enforced for production runs (the image sets NODE_ENV, `npm start` sets npm_lifecycle_event):
 * development, the test suites and the preview start fresh databases with throwaway secrets.
 */
function checkSecret(db) {
  const problem = secretProblem(process.env.SESSION_SECRET);
  if (!problem) return;
  const what =
    problem === 'missing'
      ? 'SESSION_SECRET is not set'
      : problem === 'placeholder'
        ? 'SESSION_SECRET is still the placeholder from .env.example'
        : `SESSION_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`;
  const production = process.env.NODE_ENV === 'production' || process.env.npm_lifecycle_event === 'start';
  const fresh = !holdsSecrets(db);
  if (production && fresh) {
    console.error(
      `\n${what}. It encrypts the media server tokens this app stores and signs every session,\n` +
        'so a guessable value hands both to anyone with a copy of the database.\n' +
        'This is a new installation with nothing stored yet, so now is the moment to set a real one:\n' +
        '  echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env\n' +
        '(or put the output of `openssl rand -hex 32` into SESSION_SECRET in your compose file or\n' +
        'container settings) and start again.\n',
    );
    db.close();
    process.exit(1);
  }
  console.warn(
    fresh
      ? `${what}. Fine for development and tests; a new production install would refuse to start with it. ` +
          'Generate a real one with: openssl rand -hex 32.'
      : `${what}. Generate one with: openssl rand -hex 32. Changing it signs everyone out and the ` +
          'media server tokens have to be entered again, so it is not enforced on an existing install.',
  );
}

/**
 * Gives pages freed by retention back to the disk here, before the server takes requests: a
 * VACUUM rewrites the whole file and used to run in the middle of serving pages. Only when a
 * quarter of the file is free (the same share as db/index.ts::VACUUM_FREE_SHARE).
 *
 * Never a reason not to start: it is housekeeping, and a failure (a full disk, a lock held by a
 * second instance) leaves the database exactly as it was, because VACUUM is one transaction.
 */
function startupVacuum(db) {
  if (process.env.WATCHARR_NO_STARTUP_VACUUM === '1') return;
  try {
    const free = Number(db.pragma('freelist_count', { simple: true }));
    const total = Number(db.pragma('page_count', { simple: true }));
    if (!total || free / total < 0.25) return;
    // VACUUM writes a full copy of the database (a temp file plus the WAL) before it lets go of
    // the old one. Started on a nearly full disk it fails late, and the live database is then the
    // file that cannot grow.
    const size = total * Number(db.pragma('page_size', { simple: true }));
    const fs = statfsSync(dirname(dbPath));
    const available = Number(fs.bavail) * Number(fs.bsize);
    if (available < size * 2) {
      console.log(
        `skipping VACUUM: ${Math.round(available / 1024 ** 2)} MB free, about ${Math.round((size * 2) / 1024 ** 2)} MB needed`,
      );
      return;
    }
    // Logged before and after: on a big database this takes minutes during which the server is
    // not listening yet, and without a line the start looks hung.
    console.log(
      `reclaiming ${Math.round((free / total) * 100)}% free space of ${Math.round(size / 1024 ** 2)} MB (VACUUM); ` +
        'the server starts once this is done',
    );
    const started = Date.now();
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log(`VACUUM finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    console.warn(`VACUUM skipped, starting anyway: ${error.message}`);
  }
}

/**
 * The way back from an update. Migrations only go forward, and an update may also rewrite data
 * the previous release cannot read (secrets re-encrypted under new keys, session ids hashed), so
 * a downgrade is only possible from a copy taken before the first new migration touched the file.
 * Taken through SQLite's backup API (a consistent snapshot even with a WAL), written as .partial
 * and renamed when complete, after a free-space check: the same rules as db/index.ts::backupTo.
 * Named pre-upgrade-<last migration it has>-<time>.db so the release it belongs to is readable
 * from the name; the rotation only ever prunes watcharr-* (autobackup.ts), so it is kept.
 *
 * A backup that cannot be taken (no room, an I/O error) does not stop the start: the update
 * would then run without its way back, and the log says so plainly.
 */
async function preUpgradeBackup(db, lastApplied) {
  const backupDir = join(dirname(dbPath), 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupDir, `pre-upgrade-${lastApplied.replace(/\.sql$/, '')}-${stamp}.db`);
  const partial = `${target}.partial`;
  try {
    mkdirSync(backupDir, { recursive: true });
    const size = Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true }));
    const fs = statfsSync(backupDir);
    const available = Number(fs.bavail) * Number(fs.bsize);
    const needed = Math.ceil(size * 1.2);
    if (available < needed) {
      throw new Error(`${Math.round(available / 1024 ** 2)} MB free, about ${Math.round(needed / 1024 ** 2)} MB needed`);
    }
    console.log(`backing up the database before the update (backups/${basename(target)})`);
    const started = Date.now();
    await db.backup(partial);
    renameSync(partial, target);
    console.log(`pre-upgrade backup done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    rmSync(partial, { force: true });
    console.error(
      `\nNo backup before the update could be taken: ${error.message}.\n` +
        'The update continues, but going back to the previous version will need a backup of your own.\n',
    );
  }
}

try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  const dir = join(process.cwd(), 'drizzle');
  let changed = false;
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  // Only an existing database with migrations still to apply: a fresh one has nothing to go
  // back to, and an up-to-date one is not being changed.
  if (applied.size > 0 && files.some((file) => !applied.has(file))) {
    await preUpgradeBackup(db, [...applied].sort().at(-1));
  }

  for (const file of files) {
    if (applied.has(file)) continue;
    const statements = readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint');

    // One transaction per file: a failed migration leaves nothing half applied.
    db.transaction(() => {
      for (const statement of statements) {
        if (statement.trim()) db.exec(statement);
      }
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
    })();
    console.log(`applied ${file}`);
    changed = true;
  }

  checkSecret(db);

  // New indexes have no statistics yet, and a planner without them picks plans for a small
  // database (a title page went from 5 ms to 450 ms on a million plays). Analyzes only what
  // lacks them, so it is quick on an install that is already tuned. analysis_limit samples
  // each index instead of reading it whole: on a million rows the difference is the start-up
  // waiting seconds or not at all, and the estimates are as good for choosing a plan.
  if (changed) {
    db.pragma('analysis_limit = 1000');
    db.pragma('optimize(0x10002)');
  }
  startupVacuum(db);
  db.close();
} catch (error) {
  if (error?.code?.startsWith('SQLITE_READONLY')) {
    explainReadonly(error);
    process.exit(1);
  }
  throw error;
}
