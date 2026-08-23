import 'server-only';
import type { LibraryItem } from './adapters';
import { getAdapter } from './config';

// ponytail: single in-process cache of the whole library. Fine for one server and a few
// thousand items; move to a table if the library grows past what memory should hold.
const TTL_MS = 5 * 60 * 1000;
let cache: { items: LibraryItem[]; at: number } | null = null;

export async function getLibrary(force = false): Promise<LibraryItem[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.items;
  const items = await (await getAdapter()).getLibrary();
  cache = { items, at: Date.now() };
  return items;
}

export async function searchLibrary(query: string, limit = 20): Promise<LibraryItem[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const items = await getLibrary();
  return items.filter((i) => i.title.toLowerCase().includes(needle)).slice(0, limit);
}
