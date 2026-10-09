// Checks a SQLite file without touching it: node scripts/verify-backup.mjs <file>
// Prints one JSON line. A separate process on purpose — quick_check on a database with years
// of history takes long enough to stall the web server if it ran inside it (better-sqlite3 is
// synchronous), and a crash in a corrupt file must not take the app down with it.
import Database from 'better-sqlite3';

const file = process.argv[2];
const out = (value) => console.log(JSON.stringify(value));

try {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const quick = db.pragma('quick_check', { simple: true });
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
  );
  const count = (table) =>
    tables.has(table) ? db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n : null;
  const looksLikeWatcharr = tables.has('users') && tables.has('app_settings');
  out({
    ok: quick === 'ok' && looksLikeWatcharr,
    quickCheck: quick,
    watcharr: looksLikeWatcharr,
    users: count('users'),
    history: count('watch_history'),
    sessions: count('playback_sessions'),
    migrations: count('_migrations'),
  });
  db.close();
} catch (error) {
  out({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
