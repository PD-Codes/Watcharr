import 'server-only';
import type { LibraryItem, LibrarySection } from './adapters';
import { getAdapter } from './config';

// ponytail: in-process cache of each server's library. Fine for a handful of servers and a
// few thousand items each; move to a table if a library grows past what memory should hold.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<number, { items: LibraryItem[]; at: number }>();

export async function getLibrary(serverId: number, force = false): Promise<LibraryItem[]> {
  const hit = cache.get(serverId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.items;
  const items = await (await getAdapter(serverId)).getLibrary();
  cache.set(serverId, { items, at: Date.now() });
  return items;
}

// The section list costs three requests per show library — series, seasons and episodes
// are separate totals — and four pages ask for it. Same TTL as the item cache above.
const sectionCache = new Map<number, { sections: LibrarySection[]; at: number }>();

/** The libraries of one server, with their counts. Cached like getLibrary(). */
export async function getSections(serverId: number, force = false): Promise<LibrarySection[]> {
  const hit = sectionCache.get(serverId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.sections;
  const sections = await (await getAdapter(serverId)).getLibraries();
  sectionCache.set(serverId, { sections, at: Date.now() });
  return sections;
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

const indexCache = new Map<number, { at: number; index: SectionIndex }>();

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
