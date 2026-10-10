// One read-only SQLite connection on its own thread, started by src/db/readers.ts.
// Plain .mjs next to verify-backup.mjs on purpose: Next bundles everything under src/, and a
// worker needs a file it can load by path in the standalone build as well as in development.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const db = new Database(workerData.path, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
// Aggregates sort and group in temp tables; memory is far faster than a temp file on a slow disk.
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -32000');

// The statistics modules issue the same few dozen statements over and over.
const statements = new Map();
const MAX_STATEMENTS = 300;

function prepare(sql) {
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
    if (statements.size > MAX_STATEMENTS) statements.delete(statements.keys().next().value);
  }
  return statement;
}

parentPort.on('message', ({ id, sql, params }) => {
  try {
    const started = performance.now();
    const rows = prepare(sql).all(...params);
    // The query's own time, without the thread start-up or the queue in front of it.
    parentPort.postMessage({ id, rows, ms: performance.now() - started });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
      code: error && typeof error === 'object' ? error.code : undefined,
    });
  }
});
