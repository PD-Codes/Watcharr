import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
const dir = join(process.cwd(), 'drizzle');

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
}

db.close();
