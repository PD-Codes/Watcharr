import type { LibraryItem } from './adapters';
import type { TmdbTitle } from './tmdb';

export interface TasteProfile {
  genreWeights: Record<string, number>;
  decadeWeights: Record<string, number>;
  typeWeights: Record<string, number>;
  watchedItemIds: string[];
  topTitle?: string;
}

export interface Suggestion {
  itemId: string;
  title: string;
  mediaType: string;
  year?: number;
  posterUrl?: string;
  score: number;
  reason: string;
}

export interface SuggestionPayload {
  fromLibrary: Suggestion[];
  fromTmdb: TmdbTitle[];
}

const decadeOf = (year?: number) => (year ? String(Math.floor(year / 10) * 10) : 'unknown');

/** Turns watch history into weighted preferences. Recent entries are not weighted higher yet. */
export function buildProfile(
  history: { itemId: string; title: string; mediaType: string; year: number | null; genres: string[] }[],
): TasteProfile {
  const genreWeights: Record<string, number> = {};
  const decadeWeights: Record<string, number> = {};
  const typeWeights: Record<string, number> = {};
  const titleCounts: Record<string, number> = {};

  for (const entry of history) {
    for (const genre of entry.genres) genreWeights[genre] = (genreWeights[genre] ?? 0) + 1;
    const decade = decadeOf(entry.year ?? undefined);
    decadeWeights[decade] = (decadeWeights[decade] ?? 0) + 1;
    typeWeights[entry.mediaType] = (typeWeights[entry.mediaType] ?? 0) + 1;
    titleCounts[entry.title] = (titleCounts[entry.title] ?? 0) + 1;
  }

  const topTitle = Object.entries(titleCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    genreWeights,
    decadeWeights,
    typeWeights,
    watchedItemIds: history.map((h) => h.itemId),
    topTitle,
  };
}

/** Score = shared genre weight, plus smaller bonuses for matching decade and media type. */
export function scoreItem(profile: TasteProfile, item: LibraryItem): { score: number; reason: string } {
  const maxGenre = Math.max(1, ...Object.values(profile.genreWeights));
  const matched = item.genres.filter((g) => profile.genreWeights[g]);
  const genreScore = matched.reduce((sum, g) => sum + profile.genreWeights[g] / maxGenre, 0);

  const decade = decadeOf(item.year);
  const maxDecade = Math.max(1, ...Object.values(profile.decadeWeights));
  const decadeScore = (profile.decadeWeights[decade] ?? 0) / maxDecade;

  const maxType = Math.max(1, ...Object.values(profile.typeWeights));
  const typeScore = (profile.typeWeights[item.mediaType] ?? 0) / maxType;

  const score = genreScore * 3 + decadeScore + typeScore * 0.5;
  const reason = matched.length
    ? `Matches ${matched.slice(0, 3).join(', ')}`
    : decade !== 'unknown' && profile.decadeWeights[decade]
      ? `You watch a lot from the ${decade}s`
      : 'Popular in your library';
  return { score, reason };
}

