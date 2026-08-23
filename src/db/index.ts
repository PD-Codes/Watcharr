import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema';

export const DB_PATH = process.env.DATABASE_PATH ?? './data/watcharr.db';

function connect(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  // WAL keeps the sync writes from blocking page reads; foreign keys are off by default.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
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

export { schema };
