// Pure logic for the "pick something for me" roulette. No 'server-only' import on purpose:
// the tests run this file directly and the client component imports it for the filters,
// the weighted draw and the reel layout. Randomness is always injected so a test can pin it.

/** Hard cap on the pool: more than this and a reel is just noise. */
export const POOL_CAP = 40;
/** "Quick" means a runtime up to this many minutes (or an episode). */
export const QUICK_MAX_MIN = 100;

const DAY_MS = 86_400_000;

export type Rng = () => number;

/** Uniform in [0, 1) from the platform CSPRNG; the only rng the page itself uses. */
export function cryptoRng(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

/* ------------------------------------------------------------------ *
 * Weights and reasons
 * ------------------------------------------------------------------ */

export type PickSource = 'watching' | 'planned' | 'library';

export type PickReasonKey =
  | 'pick.reason.watching'
  | 'pick.reason.today'
  | 'pick.reason.waiting'
  | 'pick.reason.library';

/** A translation key plus the one value it may interpolate as `{text}` (already formatted). */
export interface PickReason {
  key: PickReasonKey;
  text?: string;
}

export interface PoolEntry {
  itemId: string;
  title: string;
  year: number | null;
  mediaType: string;
  genres: string[];
  /** Minutes; null when the media server did not report a runtime. */
  runtimeMin: number | null;
  source: PickSource;
  /** Epoch ms the title went on the watchlist. Watchlist entries only. */
  addedAt?: number;
  /** The suggestion score from scoring.ts. Library entries only. */
  score?: number;
}

/** What the client needs to draw one tile and one result card. */
export interface PickCandidate {
  itemId: string;
  title: string;
  year: number | null;
  mediaType: string;
  genres: string[];
  /** Minutes; null when the media server did not report a runtime. */
  runtimeMin: number | null;
  /** Artwork through the proxy, so a media server token never reaches the browser. */
  poster: string;
  /** TMDB poster from the cache, used when the media server has no artwork. */
  fallback: string | null;
  weight: number;
  reason: PickReason;
  /** On the watchlist and not yet "watching": the one case "Mark as watching" applies to. */
  canMarkWatching: boolean;
  /** /title/<title> answers 404 until there is a play, so the link is only offered after one. */
  hasPlays: boolean;
}

export function ageDays(addedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - addedAt) / DAY_MS));
}

/**
 * How likely an entry is to win, relative to the others. Something you already started is
 * the strongest signal; a planned title gains odds the longer it has waited (capped, so a
 * three-year-old entry does not drown everything else); a library suggestion scales with the
 * score scoring.ts gave it. Always above zero, so nothing in the pool is unreachable.
 */
export function weightFor(entry: PoolEntry, now: number, maxScore: number): number {
  switch (entry.source) {
    case 'watching':
      return 3;
    case 'planned':
      return 1 + Math.min(ageDays(entry.addedAt ?? now, now), 90) / 45;
    default: {
      const share = maxScore > 0 ? Math.min(1, Math.max(0, (entry.score ?? 0) / maxScore)) : 0;
      return 0.5 + 1.5 * share;
    }
  }
}

/** Why this title is in the hat. `formatDate` is injected so the server picks the locale. */
export function reasonFor(
  entry: PoolEntry,
  now: number,
  formatDate: (epochMs: number) => string,
): PickReason {
  if (entry.source === 'watching') return { key: 'pick.reason.watching' };
  if (entry.source === 'library') return { key: 'pick.reason.library' };
  if (ageDays(entry.addedAt ?? now, now) < 1) return { key: 'pick.reason.today' };
  return { key: 'pick.reason.waiting', text: formatDate(entry.addedAt ?? now) };
}

const dedupeKey = (e: PoolEntry) =>
  `${e.title.trim().toLowerCase()}|${e.year ?? ''}|${e.mediaType === 'movie' ? 'm' : 's'}`;

/**
 * Weighs, de-duplicates and caps the raw entries. The same title can arrive twice (on the
 * watchlist and as a library suggestion, or under two item ids); the heavier copy wins,
 * which in practice means the watchlist one. Generic so the loader can carry its poster and
 * link fields through untouched.
 *
 * The cap keeps everything heavier than the cut-off weight and fills the rest by lot from
 * the entries that tie at it. Cutting by list order instead would drop the same tail every
 * time, so a newly added title could never get a seat while the pool stayed full.
 */
export function buildPool<T extends PoolEntry>(
  entries: readonly T[],
  now: number,
  formatDate: (epochMs: number) => string,
  cap = POOL_CAP,
  rng: Rng = cryptoRng,
): (T & { weight: number; reason: PickReason })[] {
  const maxScore = Math.max(0, ...entries.filter((e) => e.source === 'library').map((e) => e.score ?? 0));
  const weighted = entries
    .map((entry) => ({
      ...entry,
      weight: weightFor(entry, now, maxScore),
      reason: reasonFor(entry, now, formatDate),
    }))
    // Stable sort: equal weights keep the loader's order until the cap decides by lot.
    .sort((a, b) => b.weight - a.weight);

  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const unique: typeof weighted = [];
  for (const entry of weighted) {
    const key = dedupeKey(entry);
    if (seenIds.has(entry.itemId) || seenTitles.has(key)) continue;
    seenIds.add(entry.itemId);
    seenTitles.add(key);
    unique.push(entry);
  }
  if (unique.length <= cap) return unique;

  const edge = unique[cap - 1].weight;
  const above = unique.filter((entry) => entry.weight > edge);
  const tied = unique.filter((entry) => entry.weight === edge);
  // Fisher-Yates, then take as many as there are seats left.
  for (let i = tied.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [tied[i], tied[j]] = [tied[j], tied[i]];
  }
  return [...above, ...tied.slice(0, cap - above.length)];
}

/* ------------------------------------------------------------------ *
 * The draw
 * ------------------------------------------------------------------ */

/**
 * One weighted draw, skipping everything in `exclude` (the titles rejected so far).
 * Null when nothing is left. A non-positive or non-finite weight counts as zero; if every
 * remaining weight is zero the draw falls back to uniform rather than returning nothing.
 */
export function weightedPick<T extends { itemId: string; weight: number }>(
  candidates: readonly T[],
  rng: Rng,
  exclude: ReadonlySet<string> | readonly string[] = [],
): T | null {
  const skip = exclude instanceof Set ? exclude : new Set(exclude);
  const pool = candidates.filter((c) => !skip.has(c.itemId));
  if (!pool.length) return null;

  const weights = pool.map((c) => (Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];

  let roll = rng() * total;
  let last = 0;
  for (let i = 0; i < pool.length; i++) {
    if (weights[i] <= 0) continue;
    last = i;
    roll -= weights[i];
    if (roll < 0) return pool[i];
  }
  // rng() = 1 or float rounding: land on the last entry that could have won.
  return pool[last];
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

export type TypeFilter = 'any' | 'movie' | 'series';
export type LengthFilter = 'any' | 'quick' | 'long';
export interface PickFilters {
  type: TypeFilter;
  length: LengthFilter;
}

export const DEFAULT_FILTERS: PickFilters = { type: 'any', length: 'any' };

type Filterable = { mediaType: string; runtimeMin: number | null };

/** Media servers disagree on the word: Jellyfin says "series", Plex "show". */
export function kindOf(mediaType: string): 'movie' | 'series' | null {
  if (mediaType === 'movie') return 'movie';
  if (['series', 'show', 'season', 'episode'].includes(mediaType)) return 'series';
  return null;
}

/** Null when the runtime is unknown: such a title is neither quick nor long. */
export function lengthOf(item: Filterable): 'quick' | 'long' | null {
  if (item.mediaType === 'episode') return 'quick';
  if (item.runtimeMin == null) return null;
  return item.runtimeMin <= QUICK_MAX_MIN ? 'quick' : 'long';
}

/** The length filter is only offered when at least one title can answer it. */
export function hasRuntimeData(items: readonly Filterable[]): boolean {
  return items.some((item) => lengthOf(item) !== null);
}

export function applyFilters<T extends Filterable>(items: readonly T[], filters: PickFilters): T[] {
  return items.filter(
    (item) =>
      (filters.type === 'any' || kindOf(item.mediaType) === filters.type) &&
      (filters.length === 'any' || lengthOf(item) === filters.length),
  );
}

const first = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw);

/** Query string to filters; anything unrecognized falls back to "any". */
export function parseFilters(params: Record<string, string | string[] | undefined>): PickFilters {
  const type = first(params.type);
  const length = first(params.len);
  return {
    type: type === 'movie' || type === 'series' ? type : 'any',
    length: length === 'quick' || length === 'long' ? length : 'any',
  };
}

/** The inverse, omitting defaults so the plain page keeps a clean URL. Empty when default. */
export function filtersToQuery(filters: PickFilters): string {
  const params = new URLSearchParams();
  if (filters.type !== 'any') params.set('type', filters.type);
  if (filters.length !== 'any') params.set('len', filters.length);
  return params.toString();
}

/* ------------------------------------------------------------------ *
 * Reel layout
 * ------------------------------------------------------------------ */

export interface Reel<T> {
  tiles: T[];
  /** Index of the tile centered before the spin. */
  start: number;
  /** Index of the tile the reel stops on; equals `start` for a reel that is not spinning. */
  land: number;
}

/** Tiles in the visible window of a reel: the carry-over between two spins. */
export const REEL_HEAD = 11;
// Long enough that the fast part reads as a spin before the deceleration takes over.
const REEL_TRAVEL = 34;
const REEL_TAIL = 6;

/** A random run of tiles with no tile next to itself (as far as the pool allows). */
export function seedTiles<T extends { itemId: string }>(
  pool: readonly T[],
  rng: Rng,
  count = REEL_HEAD,
): T[] {
  const tiles: T[] = [];
  for (let i = 0; i < count; i++) {
    tiles.push(pickAvoiding(pool, rng, tiles.length ? [tiles[i - 1].itemId] : []));
  }
  return tiles;
}

function pickAvoiding<T extends { itemId: string }>(pool: readonly T[], rng: Rng, avoid: string[]): T {
  const options = pool.filter((c) => !avoid.includes(c.itemId));
  const from = options.length ? options : pool;
  return from[Math.min(from.length - 1, Math.floor(rng() * from.length))];
}

/**
 * The strip a spin runs along. It starts with `head` (what is on screen right now, so the
 * spin begins seamlessly from the previous result), then random filler, then the winner at
 * `land`, then a short tail so the right side is not empty once it stops. The filler is laid
 * out backwards from the winner, which is what lets the winner's neighbors differ from it.
 * With a two-title pool a clash at the join is fixed by moving the landing one tile.
 */
export function buildReel<T extends { itemId: string }>(
  pool: readonly T[],
  winner: T,
  rng: Rng,
  head: readonly T[] = seedTiles(pool, rng),
): Reel<T> {
  const start = Math.floor(head.length / 2);
  let tiles: T[] = [];
  let land = start + REEL_TRAVEL;

  for (const extra of [0, 1]) {
    land = start + REEL_TRAVEL + extra;
    tiles = [...head];
    const between: T[] = [];
    let next = winner;
    for (let i = land - 1; i >= head.length; i--) {
      const avoid = [next.itemId, ...(i === head.length ? [head[head.length - 1].itemId] : [])];
      next = pickAvoiding(pool, rng, avoid);
      between.unshift(next);
    }
    tiles.push(...between, winner);
    let prev = winner;
    for (let i = 0; i < REEL_TAIL; i++) {
      prev = pickAvoiding(pool, rng, [prev.itemId]);
      tiles.push(prev);
    }
    if (pool.length < 2 || tiles.every((tile, i) => i === 0 || tile.itemId !== tiles[i - 1].itemId)) break;
  }
  return { tiles, start, land };
}
