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
