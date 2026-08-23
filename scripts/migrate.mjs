import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
