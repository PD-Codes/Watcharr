import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SHARE_ENV, Worker } from 'node:worker_threads';

/**
 * Read-only SQLite connections on worker threads, for the statistics queries.
 *
 * better-sqlite3 is synchronous: every query runs on the one thread that also serves every
 * request, so a server-wide aggregate of a second or two stalls every other visitor for that
 * long, and a page with a dozen of them for the sum. WAL lets any number of readers work next
 * to the one writer, so the heavy reads move here and run side by side while the main thread
 * keeps answering. Writes, and the small reads around them, stay on the main connection.
 *
 * Kept on globalThis for the same reason as the main connection: Next builds the background
 * tick and the request handlers as two module graphs, and each would otherwise start its own
 * pool.
 */

/** Thrown when no worker can take the query — the caller runs it on the main connection instead. */
export class ReadersUnavailable extends Error {}

export interface ReadResult<T> {
  rows: T[];
  /** How long SQLite worked on it, measured on the reader. */
  ms: number;
}

interface Job {
  resolve: (result: ReadResult<unknown>) => void;
  reject: (error: unknown) => void;
}

interface Reader {
  worker: Worker;
  pending: Map<number, Job>;
}

interface Pool {
  readers: Reader[];
  seq: number;
  path: string;
  size: number;
  /** Set when a worker failed to start; the pool stays off until the next process. */
  broken: boolean;
}

const root = globalThis as unknown as { __watcharrReaders?: Pool };

const SCRIPT = () => join(process.cwd(), 'scripts', 'read-worker.mjs');

/** How many readers to run: WATCHARR_DB_READERS, default 2, 0 turns the pool off. */
export function readerCount(value = process.env.WATCHARR_DB_READERS): number {
  if (value === undefined || value.trim() === '') return 2;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 8) : 2;
}

export function startReaders(path: string, size: number): void {
  if (root.__watcharrReaders || size <= 0) return;
  // No script next to the build (an unusual layout): everything simply stays on the main thread.
  if (!existsSync(SCRIPT())) return;
  root.__watcharrReaders = { readers: [], seq: 0, path, size, broken: false };
}

function spawn(pool: Pool): Reader {
  // SHARE_ENV: the configured time zone is set as process.env.TZ at runtime, and every
  // 'localtime' bucket in SQL depends on it.
  const worker = new Worker(SCRIPT(), { workerData: { path: pool.path }, env: SHARE_ENV });
  const reader: Reader = { worker, pending: new Map() };
  // An idle worker must not keep the process alive (tests, scripts); one with work in flight must.
  worker.unref();
  worker.on('message', (message: { id: number; rows?: unknown[]; ms?: number; error?: string; code?: string }) => {
    const job = reader.pending.get(message.id);
    if (!job) return;
    reader.pending.delete(message.id);
    if (reader.pending.size === 0) worker.unref();
    if (message.error !== undefined) {
      job.reject(Object.assign(new Error(message.error), { code: message.code }));
    } else {
      job.resolve({ rows: message.rows ?? [], ms: message.ms ?? 0 });
    }
  });
  const fail = (error: unknown) => {
    pool.readers = pool.readers.filter((r) => r !== reader);
    // A worker that cannot even open the file (permissions, a locked share) will not do better
    // on the next try; the main connection carries on alone.
    if (error) pool.broken = true;
    for (const job of reader.pending.values()) job.reject(new ReadersUnavailable(String(error ?? 'reader exited')));
    reader.pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => fail(code === 0 ? null : `reader exited with ${code}`));
  pool.readers.push(reader);
  return reader;
}

/** Runs one SELECT on a reader. Rejects with ReadersUnavailable when there is none to run it. */
export function readOnWorker<T>(sql: string, params: unknown[]): Promise<ReadResult<T>> {
  const pool = root.__watcharrReaders;
  if (!pool || pool.broken) return Promise.reject(new ReadersUnavailable('no readers'));
  // Spawned on first use, so a process that never renders a statistics page starts none.
  let reader = pool.readers.length < pool.size ? spawn(pool) : null;
  reader ??= pool.readers.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
  const id = ++pool.seq;
  return new Promise<ReadResult<T>>((resolve, reject) => {
    reader.pending.set(id, { resolve: resolve as (result: ReadResult<unknown>) => void, reject });
    if (reader.pending.size === 1) reader.worker.ref();
    reader.worker.postMessage({ id, sql, params });
  });
}

/** Stops every reader (tests remove the database file afterwards). */
export async function stopReaders(): Promise<void> {
  const pool = root.__watcharrReaders;
  if (!pool) return;
  root.__watcharrReaders = undefined;
  await Promise.all(pool.readers.map((r) => r.worker.terminate()));
}

/** For the system check. */
export function readerStatus(): { size: number; running: number; broken: boolean } | null {
  const pool = root.__watcharrReaders;
  return pool ? { size: pool.size, running: pool.readers.length, broken: pool.broken } : null;
}
