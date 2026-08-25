import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { suggestionsCache, watchHistory } from '@/db/schema';
import { getSettings } from './config';
import { getLibrary } from './library';
import { getSimilarTitles } from './tmdb';
import { buildProfile, scoreItem, type SuggestionPayload } from './scoring';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export * from './scoring';

async function build(userId: number, serverId: number): Promise<SuggestionPayload> {
  const history = await db
    .select({
      itemId: watchHistory.itemId,
      title: watchHistory.title,
      mediaType: watchHistory.mediaType,
      year: watchHistory.year,
      genres: watchHistory.genres,
    })
    .from(watchHistory)
    .where(eq(watchHistory.userId, userId));

  const profile = buildProfile(history);
  const watched = new Set(profile.watchedItemIds);
  const library = await getLibrary(serverId);

  const fromLibrary = library
    .filter((item) => !watched.has(item.itemId))
    .map((item) => ({ item, ...scoreItem(profile, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ item, score, reason }) => ({
      itemId: item.itemId,
      title: item.title,
      mediaType: item.mediaType,
      year: item.year,
      posterUrl: item.posterUrl,
      score: Math.round(score * 100) / 100,
      reason,
    }));

  const settings = await getSettings();
  const fromTmdb =
    settings.tmdbApiKey && profile.topTitle
      ? await getSimilarTitles(settings.tmdbApiKey, profile.topTitle)
      : [];

  return { fromLibrary, fromTmdb };
}

export async function getSuggestions(
  userId: number,
  serverId: number,
  force = false,
): Promise<SuggestionPayload> {
  if (!force) {
    const [cached] = await db
      .select()
      .from(suggestionsCache)
      .where(eq(suggestionsCache.userId, userId));
    if (cached && cached.expiresAt > new Date()) return cached.payload as SuggestionPayload;
  }

  const payload = await build(userId, serverId);
  const row = {
    userId,
    payload,
    generatedAt: new Date(),
    expiresAt: new Date(Date.now() + CACHE_TTL_MS),
  };
  await db
    .insert(suggestionsCache)
    .values(row)
    .onConflictDoUpdate({ target: suggestionsCache.userId, set: row });
  return payload;
}
