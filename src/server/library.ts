import 'server-only';
import type { LibraryItem, LibrarySection } from './adapters';
import { getAdapter } from './config';
import { globalState } from './state';

// ponytail: in-process cache of each server's library. Fine for a handful of servers and a
// few thousand items each; move to a table if a library grows past what memory should hold.
// Process-wide (see state.ts): per module graph the tick and the pages would each fetch and
// hold their own copy, and a forced refresh from a page would leave the tick's copy stale.
const TTL_MS = 5 * 60 * 1000;
/** `fullAt`: the last complete listing. Deltas build on it; a full one runs at least this often. */
const FULL_EVERY_MS = 6 * 60 * 60 * 1000;
// A change logged by the media server's clock can be a little behind ours.
const DELTA_OVERLAP_MS = 10 * 60 * 1000;
const cache = globalState('library.items', () => new Map<number, { items: LibraryItem[]; at: number; fullAt: number }>());
// Refreshes in flight, one per cache and server, so ten page views start one fetch, not ten.
const inflight = globalState('library.inflight', () => new Map<string, Promise<unknown>>());

/**
 * Stale-while-revalidate. A page used to wait for the whole Plex library every time the five
 * minutes ran out (every other dashboard view, since the sync refreshes every ten): a large
 * library takes many seconds to list. Now an old copy is answered at once and refreshed behind
 * it; only a cold cache (right after a start) waits, and `force` always does.
 */
export function revalidate<T>(
  key: string,
  hit: { at: number } | undefined,
  force: boolean,
  load: () => Promise<T>,
): { wait: Promise<T> } | null {
  const fresh = hit && Date.now() - hit.at < TTL_MS;
  if (fresh && !force) return null;
  let running = inflight.get(key) as Promise<T> | undefined;
  if (!running) {
    running = load().finally(() => inflight.delete(key));
    inflight.set(key, running);
  }
  if (hit && !force) {
    running.catch(() => {}); // a failed refresh keeps the old copy; the next view tries again
    return null;
  }
  return { wait: running };
}

export async function getLibrary(serverId: number, force = false): Promise<LibraryItem[]> {
  const hit = cache.get(serverId);
  const pending = revalidate(`items:${serverId}`, hit, force, async () => {
    const adapter = await getAdapter(serverId);
    const started = Date.now();
    if (hit && !force && adapter.getLibraryChanges && started - hit.fullAt < FULL_EVERY_MS) {
      const delta = await adapter.getLibraryChanges(new Date(hit.at - DELTA_OVERLAP_MS));
      const items = delta && mergeLibrary(hit.items, delta.changed, delta.totals);
      if (items) {
        cache.set(serverId, { items, at: started, fullAt: hit.fullAt });
        return items;
      }
    }
    const items = await adapter.getLibrary();
    cache.set(serverId, { items, at: started, fullAt: started });
    return items;
  });
  return pending ? pending.wait : hit!.items;
}

// The section list costs three requests per show library — series, seasons and episodes
// are separate totals — and four pages ask for it. Same TTL as the item cache above.
/**
 * Applies a delta to a cached listing: changed items replace or join it. Null when a library's
 * total no longer matches — something was deleted, which only a full listing can show.
 */
export function mergeLibrary(
  items: LibraryItem[],
  changed: LibraryItem[],
  totals: Record<string, number>,
): LibraryItem[] | null {
  const byId = new Map(items.map((item) => [item.itemId, item]));
  for (const item of changed) byId.set(item.itemId, item);
  const merged = [...byId.values()];
  const counts = new Map<string, number>();
  for (const item of merged) counts.set(item.sectionId ?? '', (counts.get(item.sectionId ?? '') ?? 0) + 1);
  for (const [sectionId, total] of Object.entries(totals)) {
    if ((counts.get(sectionId) ?? 0) !== total) return null;
  }
  // A library that disappeared altogether: its items must go too.
  for (const sectionId of counts.keys()) if (!(sectionId in totals)) return null;
  return merged;
}

const sectionCache = globalState(
  'library.sections',
  () => new Map<number, { sections: LibrarySection[]; at: number }>(),
);

/** The libraries of one server, with their counts. Cached like getLibrary(). */
export async function getSections(serverId: number, force = false): Promise<LibrarySection[]> {
  const hit = sectionCache.get(serverId);
  const pending = revalidate(`sections:${serverId}`, hit, force, async () => {
    const sections = await (await getAdapter(serverId)).getLibraries();
    sectionCache.set(serverId, { sections, at: Date.now() });
    return sections;
  });
  return pending ? pending.wait : hit!.sections;
}

const recentCache = globalState('library.recent', () => new Map<string, { items: LibraryItem[]; at: number }>());

/**
 * Recently added, for the dashboard, the lobby screen and a library page. These asked the
 * media server live on every render — on Plex one more request in the way of every page
 * load. Same rule as above; a cold cache waits at most for this one request.
 */
export async function getRecentlyAdded(serverId: number, limit: number, sectionId?: string): Promise<LibraryItem[]> {
  const key = `${serverId}|${sectionId ?? ''}|${limit}`;
  const hit = recentCache.get(key);
  const pending = revalidate(`recent:${key}`, hit, false, async () => {
    const items = await (await getAdapter(serverId)).getRecentlyAdded(limit, sectionId);
    recentCache.set(key, { items, at: Date.now() });
    return items;
  });
  return pending ? pending.wait : hit!.items;
}

/* ------------------------------------------------------------------ *
 * Resolving one item to its library
 *
 * No event a media server sends carries a library. A session reports an item id, a title
 * and — for an episode — the series name, and that is all. Asking the server per event was
 * the reason a library filter did not exist: a notification must not cost an HTTP round
 * trip, least of all one inside a page render.
 *
 * It does not have to. The library listing is already in memory for the poster prefetch
 * and the search, and it carries a section id per item. So the same matching rule that
 * librarystats.ts runs in SQL — item id for a film, series title for an episode — runs
 * here against that cache instead.
 *
 * Strictly cache-only: a cold cache answers "unknown", never a fetch. Unknown means the
 * condition cannot be evaluated, and an unanswerable condition lets the event through
 * rather than swallowing it (see features.ts::matchesConditions).
 * ------------------------------------------------------------------ */

/**
 * Section ids are only unique within one server — Plex hands out "1", "2", "3" — so the
 * key a condition stores carries the server with it. Two Plex servers would otherwise
 * filter each other's libraries.
 */
export const sectionKey = (serverId: number, sectionId: string) => `${serverId}:${sectionId}`;

export interface SectionIndex {
  byId: Map<string, string>;
  byTitle: Map<string, string>;
}

export interface PlayedItem {
  itemId?: string;
  title?: string;
  grandparentTitle?: string | null;
}

/** Both maps point at the same section keys. Pure, so the matching rule can be tested. */
export function buildSectionIndex(serverId: number, items: LibraryItem[]): SectionIndex {
  const byId = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const item of items) {
    if (!item.sectionId) continue;
    const key = sectionKey(serverId, item.sectionId);
    byId.set(item.itemId, key);
    // First writer wins: the same title in two libraries is a misconfiguration, and
    // preferring the later one would move a show between them on every refresh.
    if (!byTitle.has(item.title.toLowerCase())) byTitle.set(item.title.toLowerCase(), key);
  }
  return { byId, byTitle };
}

/**
 * The library an item belongs to. An episode is matched by its series name: its own id
 * belongs to the episode and never appears in a library listing, which is exactly the rule
 * librarystats.ts applies in SQL.
 */
export function lookupSection(index: SectionIndex, item: PlayedItem): string | null {
  if (item.itemId) {
    const byId = index.byId.get(item.itemId);
    if (byId) return byId;
  }
  const name = item.grandparentTitle || item.title;
  return name ? (index.byTitle.get(name.toLowerCase()) ?? null) : null;
}

const indexCache = globalState('library.index', () => new Map<number, { at: number; index: SectionIndex }>());

/** Cache-only. Null means "not loaded", never a fetch — see the note above. */
export function resolveSectionKey(serverId: number, item: PlayedItem): string | null {
  const hit = cache.get(serverId);
  if (!hit) return null;
  let entry = indexCache.get(serverId);
  if (!entry || entry.at !== hit.at) {
    entry = { at: hit.at, index: buildSectionIndex(serverId, hit.items) };
    indexCache.set(serverId, entry);
  }
  return lookupSection(entry.index, item);
}

/** Display name for a section key, from the cached section list. Null when unknown. */
export function cachedSectionName(key: string): string | null {
  const [serverId, ...rest] = key.split(':');
  const sections = sectionCache.get(Number(serverId))?.sections;
  return sections?.find((section) => section.id === rest.join(':'))?.name ?? null;
}

/**
 * Loads the library and the section list into the caches above without needing a page to
 * ask for them. Called on the slow sync clock so the lookup is warm by the time an event
 * fires — and so a deployment without a TMDB key, where the poster prefetch never runs,
 * still gets a working library filter.
 */
export async function warmLibraryCache(serverId: number): Promise<void> {
  await Promise.all([getLibrary(serverId), getSections(serverId)]);
}

/** The listing if it is already in memory; never fetches (status polls must stay cheap). */
export function cachedLibrary(serverId: number): LibraryItem[] | null {
  return cache.get(serverId)?.items ?? null;
}

/** What the caches page shows: how much is held per server and how old it is. */
export function libraryCacheInfo(): { serverId: number; items: number; sections: number; ageMs: number }[] {
  return [...cache].map(([serverId, hit]) => ({
    serverId,
    items: hit.items.length,
    sections: sectionCache.get(serverId)?.sections.length ?? 0,
    ageMs: Date.now() - hit.at,
  }));
}

export async function searchLibrary(
  serverId: number,
  query: string,
  limit = 20,
): Promise<LibraryItem[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const items = await getLibrary(serverId);
  return items.filter((i) => i.title.toLowerCase().includes(needle)).slice(0, limit);
}
