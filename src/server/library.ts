import 'server-only';
import { and, desc, eq, gt } from 'drizzle-orm';
import { db } from '@/db';
import { authSessions, userLibraryAccess } from '@/db/schema';
import { isPartialLibrary, serverRoute, supportsUserSections, type LibraryItem, type LibrarySection } from './adapters';
import { getAdapter, getServer } from './config';
import { decryptSecret } from './crypto';
import type { Session } from './session';
import { globalState } from './state';
import { isStrained } from './strain';

// Trade-off: in-process cache of each server's library. Fine for a handful of servers and a
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
  paused = false,
): { wait: Promise<T> } | null {
  const fresh = hit && Date.now() - hit.at < TTL_MS;
  if (fresh && !force) return null;
  // A server in a pause (strain.ts) or marked down by the sync gets no refresh from a page view:
  // the pause exists to stop exactly this kind of request, and the old copy is still an answer.
  // Only a cold cache, which has nothing else to show, and `force` still ask.
  if (hit && !force && paused) return null;
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

/**
 * Whether a server should be left alone right now: the sync marked it down (sync.ts keeps that
 * in its process-wide state) or its host is in a strain pause. Read-only peek at the sync state
 * rather than an import: sync.ts imports this module, and creating its state from here would
 * fix the shape of an object that module owns.
 */
async function serverPaused(serverId: number): Promise<boolean> {
  const sync = (globalThis as { __watcharrState?: Map<string, unknown> }).__watcharrState?.get('sync') as
    | { downUntil?: Map<number, number> }
    | undefined;
  if ((sync?.downUntil?.get(serverId) ?? 0) > Date.now()) return true;
  const server = await getServer(serverId);
  return !!server && isStrained(serverRoute(server.serverType, server.serverUrl));
}

/** Only asked when a refresh is actually due, so a fresh hit costs no database read. */
async function pausedIfStale(serverId: number, hit: { at: number } | undefined, force: boolean): Promise<boolean> {
  if (!hit || force || Date.now() - hit.at < TTL_MS) return false;
  return serverPaused(serverId).catch(() => false);
}

export async function getLibrary(serverId: number, force = false): Promise<LibraryItem[]> {
  const hit = cache.get(serverId);
  const paused = await pausedIfStale(serverId, hit, force);
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
    let partial = false;
    const items = await adapter.getLibrary().catch((error: unknown) => {
      if (!isPartialLibrary(error)) throw error;
      // Some libraries answered, others did not: the ones that answered are refreshed and the
      // others keep what the cache held, instead of the whole refresh failing (or the failed
      // libraries emptying out until the next good run).
      partial = true;
      const failed = new Set(error.failedSections);
      const kept = (hit?.items ?? []).filter((item) => item.sectionId && failed.has(item.sectionId));
      console.warn(`[watcharr] library of server ${serverId}: ${error.message}; keeping their previous listing`);
      return [...error.items, ...kept];
    });
    // A partial listing is no base for a delta: the next refresh lists everything again.
    cache.set(serverId, { items, at: started, fullAt: partial ? 0 : started });
    return items;
  }, paused);
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
  const paused = await pausedIfStale(serverId, hit, force);
  const pending = revalidate(`sections:${serverId}`, hit, force, async () => {
    const sections = await (await getAdapter(serverId)).getLibraries();
    sectionCache.set(serverId, { sections, at: Date.now() });
    return sections;
  }, paused);
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
  const paused = await pausedIfStale(serverId, hit, false);
  const pending = revalidate(`recent:${key}`, hit, false, async () => {
    const items = await (await getAdapter(serverId)).getRecentlyAdded(limit, sectionId);
    recentCache.set(key, { items, at: Date.now() });
    return items;
  }, paused);
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

/**
 * resolveSectionKey(), after a library refresh that is already running has finished. Never starts
 * one. For an arrival: the sync refreshes the listing right before it looks for new titles, and a
 * title added minutes ago is only in the refreshed copy.
 */
export async function resolveSectionKeySettled(serverId: number, item: PlayedItem): Promise<string | null> {
  await inflight.get(`items:${serverId}`)?.catch(() => {});
  return resolveSectionKey(serverId, item);
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

/* ------------------------------------------------------------------ *
 * What a person may see
 *
 * The caches above hold each server's whole library, listed with the admin token. A media
 * server shares libraries per person, though: a Plex friend may get "Movies" and not "Kids",
 * a Jellyfin user only the folders their policy enables. Everything below narrows the cached
 * listing to the sections one person may open, so one listing per server stays enough.
 *
 * The rule, in order:
 * - An admin of the server, or a global admin, sees everything (the media server says the same).
 * - Anybody else sees what getUserSectionIds() answers, cached per person for ten minutes and
 *   refreshed behind the page like the library itself.
 * - A failed refresh keeps the last answer: a media server hiccup must not empty everybody's
 *   pages, and a revoked share shows up on the next good answer.
 * - Plex without any token of the person: the last answer stored in user_library_access.
 * - Never answered, or answered "cannot tell" (null): nothing. A page then shows an empty
 *   library rather than somebody else's. Fail-closed is the only safe default for data the
 *   server itself would not show this person.
 * ------------------------------------------------------------------ */

const ACCESS_TTL_MS = 10 * 60_000;
/** A cold lookup that failed is asked again after this long, not on every page view. */
const ACCESS_RETRY_MS = 60_000;
/** The number of people whose answers are kept; far above any real deployment. */
const ACCESS_MAX = 5_000;

/** `ids` null: the server could not say (or never answered), which means nothing is shown. */
export interface AccessEntry {
  ids: string[] | null;
  at: number;
}

/** Everything, or exactly these section ids of the person's own server (possibly none). */
export type SectionAccess = { all: true } | { all: false; ids: ReadonlySet<string> };

export const ALL_SECTIONS: SectionAccess = { all: true };
export const NO_SECTIONS: SectionAccess = { all: false, ids: new Set() };

/** The account fields visibility depends on; a users row or a session's user both fit. */
export interface Viewer {
  id: number;
  serverId: number;
  serverUserId: string;
  isAdmin: boolean;
  globalAdmin: boolean;
}

const accessCache = globalState('library.access', () => new Map<number, AccessEntry>());
// Lookups in flight per store and person, so a page's parallel helpers ask the server once.
const accessInflight = globalState(
  'library.accessInflight',
  () => new WeakMap<Map<number, AccessEntry>, Map<number, Promise<string[] | null>>>(),
);
const accessWarned = globalState('library.accessWarned', () => new Set<number>());

/** Logs once per person and state, so a server that cannot tell does not fill the log. */
function warnAccessOnce(userId: number, reason: string): void {
  if (accessWarned.has(userId)) return;
  accessWarned.add(userId);
  console.warn(`[watcharr] library access of user ${userId} is unknown (${reason}); their library pages stay empty until the media server answers`);
}

/**
 * The cached section ids of one person. Pure apart from the clock and the injected loader, so
 * the test drives it with a store of its own. A fresh entry is answered without asking; a stale
 * one is answered at once and refreshed behind it (unless `paused`, see revalidate()); only a
 * person never asked before waits. Errors never escape: the last answer stands, and without one
 * the answer is null.
 */
export async function resolveAccess(
  userId: number,
  load: () => Promise<string[] | null>,
  options: {
    store?: Map<number, AccessEntry>;
    now?: () => number;
    paused?: () => Promise<boolean>;
    onUnknown?: (reason: string) => void;
  } = {},
): Promise<string[] | null> {
  const store = options.store ?? accessCache;
  const now = options.now ?? Date.now;
  const onUnknown = options.onUnknown ?? ((reason: string) => warnAccessOnce(userId, reason));
  const hit = store.get(userId);
  if (hit && now() - hit.at < ACCESS_TTL_MS) return hit.ids;
  if (hit && options.paused && (await options.paused().catch(() => false))) return hit.ids;

  let pending = accessInflight.get(store);
  if (!pending) {
    pending = new Map();
    accessInflight.set(store, pending);
  }
  const inflightOfStore = pending;
  let running = inflightOfStore.get(userId);
  if (!running) {
    running = (async () => {
      try {
        const ids = await load();
        store.set(userId, { ids, at: now() });
        if (ids === null) onUnknown('the media server cannot tell');
        else if (store === accessCache) accessWarned.delete(userId);
        return ids;
      } catch (error) {
        const before = store.get(userId);
        // Keeps whatever was known and asks again a minute from now rather than on every view.
        store.set(userId, { ids: before?.ids ?? null, at: now() - ACCESS_TTL_MS + ACCESS_RETRY_MS });
        if (!before || before.ids === null) onUnknown(error instanceof Error ? error.message : String(error));
        return before?.ids ?? null;
      }
    })().finally(() => inflightOfStore.delete(userId));
    inflightOfStore.set(userId, running);
    while (store.size > ACCESS_MAX) store.delete(store.keys().next().value as number);
  }
  // A stale answer is still an answer: the refresh above runs behind the page.
  return hit ? hit.ids : running;
}

/** Turns a resolved answer into an access value: null means nothing. Pure. */
export function accessOf(viewer: Pick<Viewer, 'isAdmin' | 'globalAdmin'>, ids: string[] | null): SectionAccess {
  if (viewer.isAdmin || viewer.globalAdmin) return ALL_SECTIONS;
  return ids ? { all: false, ids: new Set(ids) } : NO_SECTIONS;
}

/** Whether a section may be shown. An item without a known section is shown to admins only. Pure. */
export function canSeeSection(access: SectionAccess, sectionId: string | undefined | null): boolean {
  if (access.all) return true;
  return !!sectionId && access.ids.has(sectionId);
}

/** The items and sections a person may see. Pure. */
export function filterVisible<T extends { sectionId?: string }>(items: T[], access: SectionAccess): T[] {
  return access.all ? items : items.filter((item) => canSeeSection(access, item.sectionId));
}

/** The newest stored media server token of a person, for asking on their behalf without a request. */
async function storedToken(userId: number): Promise<string> {
  const [row] = await db
    .select({ token: authSessions.serverToken })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date())))
    .orderBy(desc(authSessions.createdAt))
    .limit(1);
  try {
    return row ? decryptSecret(row.token) : '';
  } catch {
    return '';
  }
}

/** The last answer stored for a person, or null when there never was one. */
export async function storedSectionIds(userId: number): Promise<string[] | null> {
  const [row] = await db
    .select({ ids: userLibraryAccess.sectionIds })
    .from(userLibraryAccess)
    .where(eq(userLibraryAccess.userId, userId));
  return Array.isArray(row?.ids) ? row.ids : null;
}

/** Keeps an answer for when the person cannot be asked about; best effort, never fails a page. */
async function storeSectionIds(userId: number, ids: string[]): Promise<void> {
  const checkedAt = new Date();
  await db
    .insert(userLibraryAccess)
    .values({ userId, sectionIds: ids, checkedAt })
    .onConflictDoUpdate({ target: userLibraryAccess.userId, set: { sectionIds: ids, checkedAt } })
    .catch((error: unknown) => console.warn(`[watcharr] could not store the library access of user ${userId}: ${error}`));
}

/**
 * What one person may see on their own server. `token` is their media server token where one is
 * at hand (a request's session); without one — an admin's preview, a notification — Plex is asked
 * with the newest token the person signed in with, read-only and only for this question. With no
 * token left at all (every session expired) the last answer stored in user_library_access stands
 * in: it is what the server said about this very person, which beats both showing them nothing
 * and asking with somebody else's token. Jellyfin and Emby answer from the admin token and need none.
 */
export async function userSectionAccess(viewer: Viewer, token = ''): Promise<SectionAccess> {
  if (viewer.isAdmin || viewer.globalAdmin) return ALL_SECTIONS;
  const ids = await resolveAccess(
    viewer.id,
    async () => {
      const adapter = await getAdapter(viewer.serverId);
      // A backend that cannot say who sees what gets the same answer as a server that cannot tell.
      if (!supportsUserSections(adapter)) return null;
      const userToken = token || (adapter.type === 'plex' ? await storedToken(viewer.id) : '');
      if (adapter.type === 'plex' && !userToken) return storedSectionIds(viewer.id);
      const answer = await adapter.getUserSectionIds(userToken, viewer.serverUserId);
      if (answer) await storeSectionIds(viewer.id, answer);
      return answer;
    },
    { paused: () => serverPaused(viewer.serverId) },
  );
  return accessOf(viewer, ids);
}

/**
 * The access of a request's session. In an admin's preview the session carries the viewed
 * person (with no token): the preview shows exactly what they would see, and the admin's own
 * token never stands in for theirs.
 */
export function sessionAccess(session: Pick<Session, 'user' | 'serverToken'>): Promise<SectionAccess> {
  return userSectionAccess(session.user, session.serverToken);
}

/** The cached library of the session's server, narrowed to what the person may see. */
export async function visibleLibrary(session: Pick<Session, 'user' | 'serverToken'>): Promise<LibraryItem[]> {
  const [items, access] = await Promise.all([getLibrary(session.user.serverId), sessionAccess(session)]);
  return filterVisible(items, access);
}

/** The libraries of the session's server that the person may see. */
export async function visibleSections(session: Pick<Session, 'user' | 'serverToken'>): Promise<LibrarySection[]> {
  const [sections, access] = await Promise.all([getSections(session.user.serverId), sessionAccess(session)]);
  return access.all ? sections : sections.filter((section) => canSeeSection(access, section.id));
}

export async function searchVisibleLibrary(
  session: Pick<Session, 'user' | 'serverToken'>,
  query: string,
  limit = 20,
): Promise<LibraryItem[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const items = await visibleLibrary(session);
  return items.filter((i) => i.title.toLowerCase().includes(needle)).slice(0, limit);
}

/**
 * Newest arrivals the person may see. The server-wide feed carries no library on Jellyfin, so
 * someone with a part of the libraries gets one feed per visible library, merged by date —
 * filtering the shared feed instead would leave them an empty strip whenever the newest
 * titles happen to sit in a library they cannot open.
 */
export async function visibleRecentlyAdded(
  session: Pick<Session, 'user' | 'serverToken'>,
  limit: number,
): Promise<LibraryItem[]> {
  const serverId = session.user.serverId;
  const access = await sessionAccess(session);
  if (access.all) return getRecentlyAdded(serverId, limit);
  const sections = (await getSections(serverId)).filter(
    (section) => section.mediaType !== 'audio' && canSeeSection(access, section.id),
  );
  const feeds = await Promise.all(
    sections.map(async (section) =>
      (await getRecentlyAdded(serverId, limit, section.id).catch(() => [] as LibraryItem[])).map((item) => ({
        ...item,
        sectionId: item.sectionId ?? section.id,
      })),
    ),
  );
  return feeds
    .flat()
    .sort((a, b) => (b.addedAt?.getTime() ?? 0) - (a.addedAt?.getTime() ?? 0))
    .slice(0, limit);
}

/**
 * Whether one item may be shown, from the cache only (see resolveSectionKey): 'hidden' when it
 * sits in a library the person cannot open, 'unknown' when no cached library lists it (an
 * episode, a title added a minute ago) — the caller decides what unknown means.
 */
export async function itemVisibility(
  session: Pick<Session, 'user' | 'serverToken'>,
  serverId: number,
  item: PlayedItem,
): Promise<'visible' | 'hidden' | 'unknown'> {
  if (session.user.globalAdmin || (session.user.isAdmin && session.user.serverId === serverId)) return 'visible';
  const key = resolveSectionKey(serverId, item);
  if (!key) return 'unknown';
  // Another server's library is never this person's (the artwork route already refuses it).
  if (serverId !== session.user.serverId) return 'hidden';
  const access = await sessionAccess(session);
  return canSeeSection(access, key.slice(`${serverId}:`.length)) ? 'visible' : 'hidden';
}
