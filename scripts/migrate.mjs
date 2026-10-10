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

try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  const dir = join(process.cwd(), 'drizzle');
  let changed = false;

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
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

  // New indexes have no statistics yet, and a planner without them picks plans for a small
  // database (a title page went from 5 ms to 450 ms on a million plays). Analyzes only what
  // lacks them, so it is quick on an install that is already tuned.
  if (changed) db.pragma('optimize(0x10002)');
  // Give pages freed by retention back to the disk here, before the server takes requests: a
  // VACUUM rewrites the whole file and used to run in the middle of serving pages. Only when a
  // quarter of the file is free (the same share as db/index.ts::VACUUM_FREE_SHARE).
  const free = Number(db.pragma('freelist_count', { simple: true }));
  const total = Number(db.pragma('page_count', { simple: true }));
  if (total && free / total >= 0.25) {
    console.log(`reclaiming ${Math.round((free / total) * 100)}% free space (VACUUM)`);
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
  db.close();
} catch (error) {
  if (error?.code?.startsWith('SQLITE_READONLY')) {
    explainReadonly(error);
    process.exit(1);
  }
  throw error;
}
