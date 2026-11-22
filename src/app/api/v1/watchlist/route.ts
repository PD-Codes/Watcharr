import { NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { appConfig, users, watchlist } from '@/db/schema';
import type { LibraryItem } from '@/server/adapters/types';
import { getLibrary } from '@/server/library';
import { checkApiKey } from '@/server/publicapi';
import { machineIdentifier } from '@/server/serveridentity';
import { isPlexGlobalId, plexItemIdResolver } from '@/server/watchlistmatch';

export const dynamic = 'force-dynamic';

const STATUSES = ['planned', 'watching', 'done'];
/** What "still wanted" means: a title somebody finished is no longer theirs to protect. */
const DEFAULT_STATUSES = ['planned', 'watching'];
const TYPES = ['movie', 'show', 'episode'];
const MAX_ITEMS = 10_000;
/** A library that is not loaded yet (only right after a start) is waited for this long. */
const LIBRARY_WAIT_MS = 15_000;

/** A comma list kept to known values; nothing known left means the fallback, not an error. */
function listParam(raw: string | null, allowed: string[], fallback: string[]): string[] {
  const picked = (raw ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => allowed.includes(value));
  return picked.length ? [...new Set(picked)] : fallback;
}

/**
 * The library for mapping plex.tv ids, or nothing within the wait. Without it a row keeps the
 * id plex.tv gave it; a request never hangs on a Plex server that is slow to list.
 */
async function libraryWithin(serverId: number): Promise<LibraryItem[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LibraryItem[]>((resolve) => {
    timer = setTimeout(() => resolve([]), LIBRARY_WAIT_MS);
  });
  try {
    return await Promise.race([getLibrary(serverId).catch(() => []), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everyone's watchlist, newest first, for tools that must leave alone what somebody still wants
 * to watch (a cleanup tool asks before it deletes). Only the fields below go out: the join to
 * app_config is for the label and slug, never for the URL or the token.
 *
 * `itemId` is the id the server itself uses. A row pulled from plex.tv carries plex.tv's global
 * id instead, which no tool working on the server can match; it is mapped to the library's
 * ratingKey here, so a title on somebody's Plex watchlist does not look unclaimed.
 */
export async function GET(request: Request) {
  const denied = await checkApiKey(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const filters = [inArray(watchlist.status, listParam(params.get('status'), STATUSES, DEFAULT_STATUSES))];
  const types = listParam(params.get('type'), TYPES, []);
  if (types.length) filters.push(inArray(watchlist.mediaType, types));
  const username = params.get('user');
  if (username) filters.push(eq(users.username, username));
  const slug = params.get('server');
  if (slug) filters.push(eq(appConfig.slug, slug));

  const rows = await db
    .select({
      itemId: watchlist.itemId,
      mediaType: watchlist.mediaType,
      title: watchlist.title,
      year: watchlist.year,
      status: watchlist.status,
      source: watchlist.source,
      addedAt: watchlist.addedAt,
      user: users.username,
      serverId: appConfig.id,
      serverSlug: appConfig.slug,
      serverType: appConfig.serverType,
      serverLabel: appConfig.label,
    })
    .from(watchlist)
    .innerJoin(users, eq(users.id, watchlist.userId))
    .innerJoin(appConfig, eq(appConfig.id, users.serverId))
    .where(and(...filters))
    .orderBy(desc(watchlist.addedAt), desc(watchlist.id))
    .limit(MAX_ITEMS);

  // Per Plex server once: its machineIdentifier, and the id mapping where a row needs one.
  const plexIds = [...new Set(rows.filter((row) => row.serverType === 'plex').map((row) => row.serverId))];
  const plex = new Map(
    await Promise.all(
      plexIds.map(async (serverId) => {
        const needsMapping = rows.some((row) => row.serverId === serverId && isPlexGlobalId(row.itemId));
        const [machineId, library] = await Promise.all([
          machineIdentifier(serverId),
          needsMapping ? libraryWithin(serverId) : Promise.resolve(null),
        ]);
        return [serverId, { machineId, resolve: library ? plexItemIdResolver(library) : null }] as const;
      }),
    ),
  );

  const items = rows.map((row) => {
    const server = plex.get(row.serverId);
    return {
      itemId: server?.resolve ? server.resolve(row) : row.itemId,
      mediaType: row.mediaType,
      title: row.title,
      year: row.year,
      status: row.status,
      source: row.source,
      addedAt: row.addedAt,
      user: row.user,
      server: {
        slug: row.serverSlug,
        type: row.serverType,
        label: row.serverLabel,
        machineIdentifier: server?.machineId ?? null,
      },
    };
  });

  // no-store: the answer decides what may be deleted, so no proxy may hand out an old one.
  return NextResponse.json({ count: items.length, items }, { headers: { 'Cache-Control': 'no-store' } });
}
