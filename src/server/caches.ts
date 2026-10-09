import 'server-only';
import { isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { geoipCache, suggestionsCache, tmdbCache } from '@/db/schema';
import { listServers } from './config';
import { getLibrary, getSections, libraryCacheInfo } from './library';
import { globalState } from './state';
import { artworkProgress, prefetchArtwork } from './sync';
import { HIT_TTL_MS, MISS_TTL_MS } from './tmdb';

// One place that knows every cache the app keeps, so an admin can see what is held, how old it
// is, and renew or drop it without touching the database by hand. The tables are the real
// caches; this file only reads their shape and runs the same refreshers the sync tick runs.

export interface CacheStats {
  tmdb: { entries: number; found: number; misses: number; expired: number; oldest: number | null };
  coverage: { cached: number; total: number } | null;
  library: { serverId: number; label: string; items: number; sections: number; ageMs: number }[];
  geoip: { entries: number; oldest: number | null };
  suggestions: { entries: number; expired: number };
  job: RefreshJob;
}

export interface RefreshJob {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  looked: number | null;
  error: string | null;
}

const job = globalState('cacheRefresh', (): RefreshJob => ({
  running: false,
  startedAt: null,
  finishedAt: null,
  looked: null,
  error: null,
}));

/** Titles one manual refresh renews at most; the 10-minute tick keeps doing 25 on its own. */
const MANUAL_LIMIT = 500;

export async function getCacheStats(): Promise<CacheStats> {
  const now = Date.now();
  const [tmdb] = await db
    .select({
      entries: sql<number>`count(*)`,
      misses: sql<number>`coalesce(sum(CASE WHEN ${tmdbCache.payload} IS NULL THEN 1 ELSE 0 END), 0)`,
      expired: sql<number>`coalesce(sum(CASE WHEN ${tmdbCache.payload} IS NULL
        THEN ${tmdbCache.fetchedAt} < ${now - MISS_TTL_MS}
        ELSE ${tmdbCache.fetchedAt} < ${now - HIT_TTL_MS} END), 0)`,
      oldest: sql<number | null>`min(${tmdbCache.fetchedAt})`,
    })
    .from(tmdbCache);
  const [geo] = await db
    .select({ entries: sql<number>`count(*)`, oldest: sql<number | null>`min(${geoipCache.fetchedAt})` })
    .from(geoipCache);
  const [suggestions] = await db
    .select({
      entries: sql<number>`count(*)`,
      expired: sql<number>`coalesce(sum(CASE WHEN ${suggestionsCache.expiresAt} < ${now} THEN 1 ELSE 0 END), 0)`,
    })
    .from(suggestionsCache);

  const labels = new Map((await listServers()).map((s) => [s.id, s.label]));
  return {
    tmdb: {
      entries: Number(tmdb.entries),
      misses: Number(tmdb.misses),
      found: Number(tmdb.entries) - Number(tmdb.misses),
      expired: Number(tmdb.expired),
      oldest: tmdb.oldest,
    },
    coverage: await artworkProgress(),
    library: libraryCacheInfo().map((row) => ({ ...row, label: labels.get(row.serverId) ?? String(row.serverId) })),
    geoip: { entries: Number(geo.entries), oldest: geo.oldest },
    suggestions: { entries: Number(suggestions.entries), expired: Number(suggestions.expired) },
    job: { ...job },
  };
}

export type CacheAction =
  | 'tmdb.refresh'
  | 'tmdb.retryMisses'
  | 'tmdb.clear'
  | 'library.refresh'
  | 'geoip.clear'
  | 'suggestions.clear';

export const CACHE_ACTIONS: readonly CacheAction[] = [
  'tmdb.refresh',
  'tmdb.retryMisses',
  'tmdb.clear',
  'library.refresh',
  'geoip.clear',
  'suggestions.clear',
];

/** Runs one action. The TMDB refresh returns at once and works in the background. */
export async function runCacheAction(action: CacheAction): Promise<{ started?: boolean; removed?: number }> {
  switch (action) {
    case 'tmdb.refresh': {
      if (job.running) return { started: false };
      Object.assign(job, { running: true, startedAt: Date.now(), finishedAt: null, looked: null, error: null });
      void prefetchArtwork(MANUAL_LIMIT)
        .then((looked) => void (job.looked = looked))
        .catch((e: unknown) => void (job.error = e instanceof Error ? e.message : 'Refresh failed'))
        .finally(() => Object.assign(job, { running: false, finishedAt: Date.now() }));
      return { started: true };
    }
    case 'tmdb.retryMisses':
      // Deleting is the retry: the next prefetch pass sees them as never asked.
      return { removed: (await db.delete(tmdbCache).where(isNull(tmdbCache.payload)).returning({ k: tmdbCache.key })).length };
    case 'tmdb.clear':
      return { removed: (await db.delete(tmdbCache).returning({ k: tmdbCache.key })).length };
    case 'geoip.clear':
      return { removed: (await db.delete(geoipCache).returning({ k: geoipCache.ip })).length };
    case 'suggestions.clear':
      return {
        removed: (await db.delete(suggestionsCache).returning({ k: suggestionsCache.userId })).length,
      };
    case 'library.refresh': {
      const servers = await listServers();
      // One server being down must not stop the rest from being renewed.
      await Promise.allSettled(servers.flatMap((s) => [getLibrary(s.id, true), getSections(s.id, true)]));
      return { removed: 0 };
    }
  }
}
