import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { suggestionsCache, watchHistory } from '@/db/schema';
import { getSettings } from './config';
import type { LibraryItem } from './adapters';
import { visibleLibrary } from './library';
import type { Session } from './session';
import { getSimilarTitles } from './tmdb';
import { buildProfile, scoreItem, type SuggestionPayload } from './scoring';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export * from './scoring';

async function build(userId: number, library: LibraryItem[]): Promise<SuggestionPayload> {
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

/**
 * Suggestions for the session's person. Library picks come only from libraries the media server
 * shares with them (library.ts::visibleLibrary), and that holds for the cached payload too: it
 * lives a day, while a share can be withdrawn at any time, so it is narrowed again on every read.
 */
export async function getSuggestions(
  session: Pick<Session, 'user' | 'serverToken'>,
  force = false,
): Promise<SuggestionPayload> {
  const userId = session.user.id;
  // A cold cache on a server that is down: the cached payload can still be shown, narrowed to
  // nothing from the library for anyone but an admin, since nothing says what they may see.
  const library = await visibleLibrary(session).catch(() => null);
  const visible = library ? new Set(library.map((item) => item.itemId)) : null;
  const admin = session.user.isAdmin || session.user.globalAdmin;
  const narrowed = (payload: SuggestionPayload): SuggestionPayload => ({
    ...payload,
    fromLibrary: visible
      ? payload.fromLibrary.filter((item) => visible.has(item.itemId))
      : admin
        ? payload.fromLibrary
        : [],
  });
  if (!force) {
    const [cached] = await db
      .select()
      .from(suggestionsCache)
      .where(eq(suggestionsCache.userId, userId));
    if (cached && cached.expiresAt > new Date()) return narrowed(cached.payload as SuggestionPayload);
  }

  // Without a library there is nothing to build from, and storing an empty payload would keep
  // the page empty for a day after the server is back.
  if (!library) throw new Error('the library is not available right now');
  const payload = await build(userId, library);
  // An empty visible library is usually "access not known yet" (library.ts fails closed); a day
  // of cached emptiness would outlive the answer by far, so only real results are kept.
  if (!library.length) return payload;
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
