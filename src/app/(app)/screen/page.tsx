import AutoRefresh from '@/components/AutoRefresh';
import { getAdapter } from '@/server/config';
import { getLiveSessions, type LiveSession } from '@/server/livesessions';
import {
  isAdvancing,
  orderStreams,
  relativeAge,
  serverPosition,
  uniqueTitles,
  type ScreenSlide,
  type ScreenStats,
  type ScreenStream,
} from '@/server/screen-core';
import { isAdmin, requireUser } from '@/server/session';
import { resolveView, viewQuery } from '@/server/viewscope';
import { globalState } from '@/server/state';
import { getRecentPlays, getStreak, getTotals } from '@/server/stats';
import { cachedPosters } from '@/server/tmdb';
import type { LibraryItem } from '@/server/adapters/types';
import { getLocale, getT } from '@/i18n/server';
import ScreenClient from './ScreenClient';

export const dynamic = 'force-dynamic';

const SLIDES = 8;
/** How long the media server's answer is reused: the loop only needs to be roughly current. */
const ADDED_TTL_MS = 2 * 60_000;

// The page refreshes every ten seconds, around the clock. Asking the media server for its
// newest arrivals that often would be a request nobody needs, so the answer is kept for a
// couple of minutes (a failure too: a server that is down is not asked six times a minute).
const addedMemo = globalState('screen.recentlyAdded', () => new Map<number, { at: number; items: LibraryItem[] }>());

async function recentlyAdded(serverId: number): Promise<LibraryItem[]> {
  const hit = addedMemo.get(serverId);
  if (hit && Date.now() - hit.at < ADDED_TTL_MS) return hit.items;
  const adapter = await getAdapter(serverId).catch(() => null);
  const items = (await adapter?.getRecentlyAdded(SLIDES).catch(() => [])) ?? [];
  addedMemo.set(serverId, { at: Date.now(), items });
  return items;
}

function toStream(row: LiveSession, admin: boolean, now: number): ScreenStream {
  const progressAt = row.progressAt.getTime();
  return {
    key: row.sessionKey,
    itemId: row.itemId,
    // Same split as the Beam: the show is the headline, the episode the second line.
    title: row.grandparentTitle ?? row.title,
    episode: row.grandparentTitle ? row.title : null,
    state: row.state === 'paused' ? 'paused' : row.state === 'buffering' ? 'buffering' : 'playing',
    durationMs: row.durationMs,
    positionMs: serverPosition({ ...row, progressAt }, now),
    advancing: isAdvancing({ state: row.state, progressAt }, now),
    startedAt: row.startedAt.getTime(),
    // The dashboard hero's rule: names of who is watching are for admins only.
    user: admin ? row.username : null,
    device: row.deviceName,
    client: row.clientName,
  };
}

/**
 * The lobby display: full-screen, hands-off, readable across a room. Everything on it is
 * the dashboard's own data under the dashboard's own visibility rule, so a non-admin sees
 * their own streams and their own numbers here too and nobody else's.
 *
 * An admin chooses between the whole server (the default, what a display in the hallway is
 * for) and their own streams (`?view=me`); a global admin with several servers picks one.
 */
export default async function ScreenPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; server?: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  const locale = await getLocale();
  const now = Date.now();

  const admin = isAdmin(session.user);
  const view = await resolveView(session, await searchParams, 'server');
  const scope = view.scope;
  const serverId = view.server.id;

  const live = await getLiveSessions({
    userId: view.kind === 'me' ? session.user.id : undefined,
    serverId,
    // Never every server at once: the server view is one server, picked or the reader's own.
    globalAdmin: false,
  });
  const streams = orderStreams(live.map((row) => toStream(row, admin, now)));

  // Intermission material is only fetched while nothing is playing.
  let slides: ScreenSlide[] = [];
  let stats: ScreenStats | null = null;
  if (streams.length === 0) {
    const added = await recentlyAdded(serverId);
    const posters = await cachedPosters(added);
    if (added.length > 0) {
      slides = added.map((item) => ({
        key: item.itemId,
        itemId: item.itemId,
        fallback: posters.get(item.itemId) ?? null,
        title: item.title,
        year: item.year ?? null,
        kind: 'added',
        meta: item.addedAt ? t('screen.addedAgo', { ago: relativeAge(item.addedAt.getTime(), now, locale) }) : '',
      }));
    } else {
      // An empty library falls back to what was watched last; a show watched five times in
      // a row is one poster.
      const plays = await getRecentPlays(scope, SLIDES * 5);
      slides = uniqueTitles(
        plays.map((play) => ({ ...play, title: play.grandparentTitle ?? play.title })),
        SLIDES,
      ).map((play) => ({
        key: play.itemId,
        itemId: play.itemId,
        fallback: null,
        title: play.title,
        year: null,
        kind: 'watched',
        meta: t('screen.watchedAgo', { ago: relativeAge(play.watchedAt.getTime(), now, locale) }),
      }));
    }

    const [week, streak] = await Promise.all([getTotals(scope, 7), getStreak(scope)]);
    stats = { plays: week.plays, watchMs: week.watchtimeMs, streak };
  }

  return (
    <>
      <h1 className="scr-sr">{t('screen.title')}</h1>
      <AutoRefresh seconds={4} />
      <ScreenClient
        locale={locale}
        serverSlug={view.server.slug}
        scopeLabel={view.kind === 'server' && view.servers.length > 1 ? view.server.label : null}
        views={
          view.canServer
            ? [
                { key: 'me', label: t('view.me'), href: `/screen${viewQuery({ kind: 'me' })}`, on: view.kind === 'me' },
                ...view.servers.map((server) => ({
                  key: `server:${server.slug}`,
                  label: view.servers.length > 1 ? server.label : t('view.server'),
                  href: `/screen${viewQuery({ kind: 'server', server: view.servers.length > 1 ? server.slug : undefined })}`,
                  on: view.kind === 'server' && view.server.id === server.id,
                })),
              ]
            : []
        }
        streams={streams}
        slides={slides}
        stats={stats}
      />
    </>
  );
}
