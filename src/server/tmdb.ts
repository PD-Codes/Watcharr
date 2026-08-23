import 'server-only';
import { apiFetch } from './adapters/http';

const BASE = 'https://api.themoviedb.org/3';
const IMAGE = 'https://image.tmdb.org/t/p/w342';

export interface TmdbTitle {
  title: string;
  year?: number;
  posterUrl?: string;
  overview?: string;
}

type TmdbResult = {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  overview?: string;
};

function toTitle(r: TmdbResult): TmdbTitle {
  const date = r.release_date ?? r.first_air_date;
  return {
    title: r.title ?? r.name ?? 'Unknown',
    year: date ? Number(date.slice(0, 4)) : undefined,
    posterUrl: r.poster_path ? `${IMAGE}${r.poster_path}` : undefined,
    overview: r.overview,
  };
}

/**
 * Titles similar to `title`, or trending titles when nothing matches.
 * Returns an empty list on any failure — TMDB is an optional enrichment, never a hard dependency.
 */
export async function getSimilarTitles(
  apiKey: string,
  title: string,
  limit = 6,
): Promise<TmdbTitle[]> {
  try {
    const search = await apiFetch<{ results: TmdbResult[] }>(
      `${BASE}/search/multi?api_key=${apiKey}&query=${encodeURIComponent(title)}`,
    );
    const match = search.results.find((r) => r.title || r.name);
    if (!match) return await getTrending(apiKey, limit);

    const kind = match.title ? 'movie' : 'tv';
    const similar = await apiFetch<{ results: TmdbResult[] }>(
      `${BASE}/${kind}/${match.id}/similar?api_key=${apiKey}`,
    );
    return similar.results.slice(0, limit).map(toTitle);
  } catch {
    return [];
  }
}

export async function getTrending(apiKey: string, limit = 6): Promise<TmdbTitle[]> {
  try {
    const res = await apiFetch<{ results: TmdbResult[] }>(
      `${BASE}/trending/all/week?api_key=${apiKey}`,
    );
    return res.results.slice(0, limit).map(toTitle);
  } catch {
    return [];
  }
}
