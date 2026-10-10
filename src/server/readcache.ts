import 'server-only';
import { createHash } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { db } from '@/db';
import { readOnWorker, ReadersUnavailable } from '@/db/readers';
import { globalState } from './state';

/**
 * `db.all` for the statistics modules, with a short memory for the expensive answers.
 *
 * SQLite runs synchronously on the one thread that also serves every request, so a server-wide
 * aggregate over a few hundred thousand plays (a second or two each, twenty-odd on the admin
 * statistics page) holds up everybody for as long as it runs. Those numbers do not need to be
 * fresher than the page that shows them is refreshed, so an answer that took a noticeable time
 * to compute is kept for 30 s and handed to the next asker. Cheap queries are never cached:
 * they stay live, and a small database behaves exactly as it did before.
 *
 * ponytail: keyed on the SQL text and its parameters, no invalidation on writes — the 30 s is
 * the whole contract. Needs no change when a query is added, which is why it sits behind
 * db.all rather than at every call site.
 */

const SLOW_MS = 150;
const TTL_MS = 30_000;
const MAX_ENTRIES = 400;

const dialect = new SQLiteSyncDialect();
const kept = globalState('readcache', () => new Map<string, { at: number; rows: unknown[] }>());

async function all<T>(query: SQL): Promise<T[]> {
  const { sql, params } = dialect.sqlToQuery(query);
  // Hashed: a query can carry big parameter lists, and the key is kept for every slow answer.
  const key = createHash('sha1').update(sql).update('\u0000').update(JSON.stringify(params)).digest('base64');
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return (hit.rows as T[]).slice();

  // On a reader thread when there is one, so a slow aggregate no longer stops every other
  // request; on the main connection otherwise (exclusive locking, readers off or failed).
  // "Slow" is the query's own time: a reader's start-up or queue says nothing about it.
  const { rows, ms } = await readOnWorker<T>(sql, params).catch(async (error: unknown) => {
    if (!(error instanceof ReadersUnavailable)) throw error;
    const started = performance.now();
    const local = await db.all<T>(query);
    return { rows: local, ms: performance.now() - started };
  });
  if (ms >= SLOW_MS) {
    kept.delete(key);
    kept.set(key, { at: Date.now(), rows });
    if (kept.size > MAX_ENTRIES) {
      const now = Date.now();
      for (const [k, v] of kept) if (now - v.at >= TTL_MS) kept.delete(k);
      // Still over: drop the oldest first (a Map iterates in insertion order).
      for (const k of kept.keys()) {
        if (kept.size <= MAX_ENTRIES) break;
        kept.delete(k);
      }
    }
  }
  return rows;
}

/** Same call shape as db.all, which is all the statistics modules use. */
export const readDb = { all };
export const clearReadCache = () => kept.clear();
