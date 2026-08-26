import 'server-only';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { tmdbCache } from '@/db/schema';
import { apiFetch } from './adapters/http';
import { scopeFilter, type Scope } from './stats';

const BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Image sizes are picked per use, not per request: a backdrop behind a page header and a
// cast thumbnail have nothing in common, and TMDB serves each size as its own file.
const POSTER = `${IMAGE_BASE}/w500`;
const POSTER_SMALL = `${IMAGE_BASE}/w342`;
const BACKDROP = `${IMAGE_BASE}/w1280`;
const PROFILE = `${IMAGE_BASE}/w185`;

/**
 * TMDB images are public, unauthenticated URLs — unlike media server artwork they carry no
 * token, so they are linked directly instead of through /api/art. One proxy less to run,
 * and the browser caches them on TMDB's CDN.
 */
const image = (base: string, path?: string | null) => (path ? `${base}${path}` : undefined);

/** A hit is good for a month; a miss is remembered too, for a week. See tmdbCache. */
const HIT_TTL_MS = 30 * 86_400_000;
const MISS_TTL_MS = 7 * 86_400_000;

export interface TmdbTitle {
  title: string;
  year?: number;
  posterUrl?: string;
  overview?: string;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character?: string;
  profileUrl?: string;
}

/** Everything the detail pages show about one title. */
export interface TmdbMeta {
  tmdbId: number;
  kind: 'movie' | 'tv';
  title: string;
  year?: number;
  overview?: string;
  tagline?: string;
  posterUrl?: string;
  backdropUrl?: string;
  voteAverage?: number;
  voteCount?: number;
  runtimeMinutes?: number;
  genres: string[];
  cast: TmdbCastMember[];
}

export interface TmdbPerson {
  id: number;
  name: string;
  biography?: string;
  birthday?: string;
  placeOfBirth?: string;
  profileUrl?: string;
  knownFor: { title: string; year?: number; character?: string; posterUrl?: string }[];
}

type TmdbResult = {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
};

function toTitle(r: TmdbResult): TmdbTitle {
  const date = r.release_date ?? r.first_air_date;
  return {
    title: r.title ?? r.name ?? 'Unknown',
    year: date ? Number(date.slice(0, 4)) : undefined,
    posterUrl: image(POSTER_SMALL, r.poster_path),
    overview: r.overview,
  };
}

/**
 * Reads through the cache table. `null` is a real, cached answer ("TMDB does not know this
 * title") — without storing it, every page view of an obscure title would search again.
 */
async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const [row] = await db.select().from(tmdbCache).where(eq(tmdbCache.key, key));
  if (row) {
    const age = Date.now() - row.fetchedAt.getTime();
    if (age < (row.payload === null ? MISS_TTL_MS : HIT_TTL_MS)) return row.payload as T | null;
  }

  let value: T | null = null;
  try {
    value = await load();
  } catch {
    // A TMDB outage must not take a page down: fall through and cache nothing, so the next
    // request tries again rather than being told "no such title" for a week.
    return (row?.payload as T | null) ?? null;
  }

  await db
    .insert(tmdbCache)
    .values({ key, payload: value, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: tmdbCache.key,
      set: { payload: value, fetchedAt: new Date() },
    });
  return value;
}

/** Watch history only knows 'movie', 'episode', 'show' — TMDB splits into movie and tv. */
function tmdbKind(mediaType: string): 'movie' | 'tv' {
  return mediaType === 'movie' ? 'movie' : 'tv';
}

/**
 * The cache key for one title. Kept in one place because three callers have to agree on
 * it: the lookup, the batch read for poster grids, and the prefetch that decides what is
 * still missing.
 */
function metaKey(label: string, mediaType: string, year?: number | null): string {
  return `meta:${tmdbKind(mediaType)}:${label.trim().toLowerCase()}:${year ?? ''}`;
}

export interface TitleRef {
  itemId: string;
  title: string;
  mediaType: string;
  year?: number | null;
}

/**
 * Poster URLs for a whole grid, read from the cache only — never a lookup. A page of 24
 * tiles would otherwise fire 24 TMDB searches on its first render, and the second one
 * after that whenever a new item appeared. The cache is filled by prefetchTitleMeta()
 * from the sync tick instead, so a grid either has the poster or renders without it.
 */
export async function cachedPosters(items: TitleRef[]): Promise<Map<string, string>> {
  const posters = new Map<string, string>();
  if (!items.length) return posters;

  const byKey = await readCachedMeta(items);
  for (const item of items) {
    const poster = byKey.get(metaKey(item.title, item.mediaType, item.year))?.posterUrl;
    if (poster) posters.set(item.itemId, poster);
  }
  return posters;
}

/** One query for a whole list. Misses are simply absent from the map. */
async function readCachedMeta(
  items: { title: string; mediaType: string; year?: number | null }[],
): Promise<Map<string, TmdbMeta>> {
  const keys = [...new Set(items.map((item) => metaKey(item.title, item.mediaType, item.year)))];
  const rows = await db
    .select()
    .from(tmdbCache)
    .where(inArray(tmdbCache.key, keys))
    .catch(() => []);

  const found = new Map<string, TmdbMeta>();
  for (const row of rows) {
    // A cached miss is a null payload, which is an answer but not a usable one here.
    if (row.payload) found.set(row.key, row.payload as TmdbMeta);
  }
  return found;
}

export interface TopCastMember extends TmdbCastMember {
  /** Plays across every title this person appears in. */
  plays: number;
  titles: number;
}

/**
 * Who shows up most in what somebody watched. Built entirely from the cache — no lookup
 * happens here, so a title TMDB has not been fetched for yet simply does not contribute.
 * That is also why it is worth nothing on a fresh install and fills in as prefetchTitleMeta()
 * works through the library.
 *
 * Only the top titles are considered: the tail is a long list of one-play items that would
 * add noise and a much larger cache read for no visible change in the ranking.
 */
export async function getTopCast(
  scope: Scope,
  limit = 12,
  fromTitles = 60,
): Promise<TopCastMember[]> {
  const titles = await db.all<{
    label: string;
    media_type: string;
    year: number | null;
    plays: number;
  }>(sql`
    SELECT coalesce(grandparent_title, title) AS label,
           max(media_type) AS media_type,
           max(year) AS year,
           count(*) AS plays
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    GROUP BY label
    ORDER BY plays DESC, label ASC
    LIMIT ${fromTitles}
  `);
  if (!titles.length) return [];

  const meta = await readCachedMeta(
    titles.map((t) => ({ title: t.label, mediaType: t.media_type, year: t.year })),
  );

  const people = new Map<number, TopCastMember>();
  for (const title of titles) {
    const entry = meta.get(metaKey(title.label, title.media_type, title.year));
    if (!entry) continue;
    for (const person of entry.cast) {
      const current = people.get(person.id);
      if (current) {
        current.plays += Number(title.plays);
        current.titles += 1;
      } else {
        people.set(person.id, {
          ...person,
          // The role is per title and meaningless once several are summed up.
          character: undefined,
          plays: Number(title.plays),
          titles: 1,
        });
      }
    }
  }

  return [...people.values()]
    .sort((a, b) => b.titles - a.titles || b.plays - a.plays || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** How many titles one prefetch pass looks up. Two TMDB requests each. */
const PREFETCH_BATCH = 25;

/**
 * Fills the cache for titles nothing has asked about yet, so the grids have something to
 * fall back on. Sequential on purpose: this runs in the background, nobody is waiting for
 * it, and a burst of parallel requests is the way to get rate limited.
 *
 * Returns how many were looked up, so the caller can tell a no-op from real work.
 */
export async function prefetchTitleMeta(apiKey: string | null, items: TitleRef[]): Promise<number> {
  if (!apiKey || !items.length) return 0;

  // Deduplicated by cache key, not by item id: two servers can hold the same film.
  const wanted = new Map<string, TitleRef>();
  for (const item of items) {
    if (item.title.trim()) wanted.set(metaKey(item.title, item.mediaType, item.year), item);
  }

  const known = await db
    .select({ key: tmdbCache.key })
    .from(tmdbCache)
    .where(inArray(tmdbCache.key, [...wanted.keys()]))
    .catch(() => []);
  for (const row of known) wanted.delete(row.key);

  let done = 0;
  for (const item of [...wanted.values()].slice(0, PREFETCH_BATCH)) {
    await getTitleMeta(apiKey, item.title, item.mediaType, item.year);
    done += 1;
  }
  return done;
}

type TmdbDetails = TmdbResult & {
  tagline?: string;
  vote_average?: number;
  vote_count?: number;
  runtime?: number;
  episode_run_time?: number[];
  genres?: { id: number; name: string }[];
  credits?: {
    cast?: { id: number; name: string; character?: string; profile_path?: string | null }[];
  };
};

const CAST_LIMIT = 12;

async function loadMeta(
  apiKey: string,
  label: string,
  kind: 'movie' | 'tv',
  year?: number,
): Promise<TmdbMeta | null> {
  const params = new URLSearchParams({ api_key: apiKey, query: label });
  // The year narrows a search that would otherwise pick the remake: "Dune" alone answers
  // 1984 as often as 2021.
  if (year) params.set(kind === 'movie' ? 'primary_release_year' : 'first_air_date_year', String(year));

  let search = await apiFetch<{ results: TmdbResult[] }>(`${BASE}/search/${kind}?${params}`);
  if (!search.results.length && year) {
    // A media server's year can be off by one at a release boundary, so a failed narrow
    // search retries without it rather than reporting the title as unknown.
    params.delete(kind === 'movie' ? 'primary_release_year' : 'first_air_date_year');
    search = await apiFetch<{ results: TmdbResult[] }>(`${BASE}/search/${kind}?${params}`);
  }
  const match = search.results[0];
  if (!match) return null;

  const details = await apiFetch<TmdbDetails>(
    `${BASE}/${kind}/${match.id}?api_key=${apiKey}&append_to_response=credits`,
  );
  const date = details.release_date ?? details.first_air_date;

  return {
    tmdbId: details.id,
    kind,
    title: details.title ?? details.name ?? label,
    year: date ? Number(date.slice(0, 4)) : undefined,
    overview: details.overview || undefined,
    tagline: details.tagline || undefined,
    posterUrl: image(POSTER, details.poster_path),
    backdropUrl: image(BACKDROP, details.backdrop_path),
    voteAverage: details.vote_average || undefined,
    voteCount: details.vote_count || undefined,
    runtimeMinutes: details.runtime ?? details.episode_run_time?.[0],
    genres: (details.genres ?? []).map((g) => g.name),
    cast: (details.credits?.cast ?? []).slice(0, CAST_LIMIT).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character || undefined,
      profileUrl: image(PROFILE, c.profile_path),
    })),
  };
}

/**
 * Artwork and metadata for one title. Keyed by what the app actually knows — a display
 * label, a media type and maybe a year — because no media server hands out TMDB ids
 * consistently across Plex, Jellyfin and Emby.
 *
 * Returns null without an API key, on a miss, and on any failure: TMDB is enrichment, so
 * every caller renders without it.
 */
export async function getTitleMeta(
  apiKey: string | null,
  label: string,
  mediaType: string,
  year?: number | null,
): Promise<TmdbMeta | null> {
  if (!apiKey || !label.trim()) return null;
  const kind = tmdbKind(mediaType);
  return cached<TmdbMeta>(metaKey(label, mediaType, year), () =>
    loadMeta(apiKey, label.trim(), kind, year ?? undefined),
  );
}

type TmdbPersonDetails = {
  id: number;
  name: string;
  biography?: string;
  birthday?: string | null;
  place_of_birth?: string | null;
  profile_path?: string | null;
  combined_credits?: {
    cast?: {
      title?: string;
      name?: string;
      character?: string;
      release_date?: string;
      first_air_date?: string;
      poster_path?: string | null;
      popularity?: number;
      media_type?: string;
    }[];
  };
};

const KNOWN_FOR_LIMIT = 20;

/** One actor, with the titles TMDB credits them for. Cached like everything else here. */
export async function getPerson(apiKey: string | null, personId: number): Promise<TmdbPerson | null> {
  if (!apiKey || !Number.isInteger(personId) || personId <= 0) return null;

  return cached<TmdbPerson>(`person:${personId}`, async () => {
    const person = await apiFetch<TmdbPersonDetails>(
      `${BASE}/person/${personId}?api_key=${apiKey}&append_to_response=combined_credits`,
    );
    const credits = (person.combined_credits?.cast ?? [])
      .filter((c) => c.media_type !== 'person')
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
      .slice(0, KNOWN_FOR_LIMIT);

    return {
      id: person.id,
      name: person.name,
      biography: person.biography || undefined,
      birthday: person.birthday || undefined,
      placeOfBirth: person.place_of_birth || undefined,
      profileUrl: image(POSTER_SMALL, person.profile_path),
      knownFor: credits.map((c) => {
        const date = c.release_date ?? c.first_air_date;
        return {
          title: c.title ?? c.name ?? 'Unknown',
          year: date ? Number(date.slice(0, 4)) : undefined,
          character: c.character || undefined,
          posterUrl: image(POSTER_SMALL, c.poster_path),
        };
      }),
    };
  });
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
