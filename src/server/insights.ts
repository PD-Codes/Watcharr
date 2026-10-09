import 'server-only';
import { cache } from 'react';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { globalState } from '@/server/state';
import { scopeFilter, type Scope } from '@/server/stats';
import {
  computeAchievements,
  computeInsights,
  type Achievement,
  type Insight,
  type PlayRow,
} from '@/server/insights-core';

function parseGenres(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * One scan for everything. The strip and the shelf both need the same rows, so cache() keeps
 * a page that mounts both from reading the history twice. The arguments are primitives on
 * purpose: cache() keys on identity, and a fresh Scope object would never hit.
 */
const loadPlays = cache(async (userId: number | null, serverId: number | null): Promise<PlayRow[]> => {
  const scope: Scope =
    userId !== null ? { userId } : serverId !== null ? { userId: null, serverId } : { userId: null };
  // 'localtime' like every other day/hour bucket in stats.ts, so a play lands on the same
  // day here as on the calendar. Day and hour come out of one strftime and are split below.
  const rows = await db.all<{
    user_id: number;
    item_id: string;
    title: string;
    grandparent_title: string | null;
    media_type: string;
    year: number | null;
    genres: string | null;
    duration_ms: number;
    slot: string;
  }>(sql`
    SELECT user_id, item_id, title, grandparent_title, media_type, year, genres, duration_ms,
           strftime('%Y-%m-%d %H', watched_at / 1000, 'unixepoch', 'localtime') AS slot
    FROM watch_history
    WHERE ${scopeFilter(scope)}
      -- strftime answers NULL beyond year 9999 (a bad import); one such row must not take the page down.
      AND watched_at / 1000 BETWEEN 0 AND 253402300799
  `);
  return rows.map((row) => ({
    userId: Number(row.user_id),
    itemId: row.item_id,
    title: row.title,
    show: row.grandparent_title,
    mediaType: row.media_type,
    year: row.year,
    day: row.slot.slice(0, 10),
    hour: Number(row.slot.slice(11, 13)),
    genres: parseGenres(row.genres),
    durationMs: Number(row.duration_ms ?? 0),
  }));
});

const rowsFor = (scope: Scope) =>
  loadPlays(scope.userId, scope.userId === null ? (scope.serverId ?? null) : null);

// The scan reads every play in scope, and the dashboard refreshes itself every 30 seconds in
// every open tab. A minute of memory keeps that from being a full-table read per tab.
// shortcut: per-process cache keyed by scope, upgrade to a SQL aggregate if histories pass ~100k rows.
const MEMO_MS = 60_000;
const MEMO_MAX = 200;
const memo = globalState('insights.memo', () => new Map<string, { at: number; value: unknown }>());

async function memoized<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value as T;
  const value = await compute();
  memo.set(key, { at: Date.now(), value });
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  return value;
}

const scopeKey = (scope: Scope) =>
  scope.userId !== null ? `u${scope.userId}` : `s${scope.serverId ?? 'all'}`;

/** The few observations worth showing for a scope; empty when there is nothing true to say. */
export async function getInsights(scope: Scope, now = new Date()): Promise<Insight[]> {
  // The day is part of the key: "on this day" changes at midnight.
  return memoized(`i:${scopeKey(scope)}:${now.toDateString()}`, async () =>
    computeInsights(await rowsFor(scope), now),
  );
}

/** Every achievement with its progress, locked ones included. */
export async function getAchievements(scope: Scope): Promise<Achievement[]> {
  return memoized(`a:${scopeKey(scope)}`, async () => computeAchievements(await rowsFor(scope)));
}
