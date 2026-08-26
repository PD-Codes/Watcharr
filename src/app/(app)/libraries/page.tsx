import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { watchHistory } from '@/db/schema';
import { Icon } from '@/components/Icons';
import Poster from '@/components/Poster';
import { artUrl, formatDate, formatDuration, formatTimeAgo } from '@/components/format';
import { getLibrary, getSections } from '@/server/library';
import { getLibraryTotals } from '@/server/librarystats';
import { adminScope, isAdmin, requireUser } from '@/server/session';
import { cachedPosters } from '@/server/tmdb';
import { getT } from '@/i18n/server';
import type { Translate, TranslationKey } from '@/i18n';

export const dynamic = 'force-dynamic';

const UNWATCHED_LIMIT = 24;

/**
 * The sortable columns. Kept as data rather than as a switch in the markup, because the
 * header cells and the comparator have to stay in step — a column you can click but not
 * sort by is worse than one that is not clickable.
 */
const COLUMNS = [
  { key: 'name', labelKey: 'libraries.colName', numeric: false },
  { key: 'type', labelKey: 'libraries.colType', numeric: false },
  { key: 'items', labelKey: 'libraries.colItems', numeric: true },
  { key: 'seasons', labelKey: 'libraries.colSeasons', numeric: true },
  { key: 'episodes', labelKey: 'libraries.colEpisodes', numeric: true },
  { key: 'streamed', labelKey: 'libraries.colLastStreamed', numeric: true },
  { key: 'played', labelKey: 'libraries.colLastPlayed', numeric: false },
  { key: 'plays', labelKey: 'libraries.colPlays', numeric: true },
  { key: 'duration', labelKey: 'libraries.colDuration', numeric: true },
] as const satisfies readonly { key: string; labelKey: TranslationKey; numeric: boolean }[];

type SortKey = (typeof COLUMNS)[number]['key'];

interface Row {
  id: string;
  name: string;
  mediaType: string;
  items: number;
  seasons?: number;
  episodes?: number;
  plays: number;
  watchtimeMs: number;
  lastPlayedAt: Date | null;
  lastTitle: string | null;
}

function compare(a: Row, b: Row, sort: SortKey): number {
  switch (sort) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'type':
      return a.mediaType.localeCompare(b.mediaType) || a.name.localeCompare(b.name);
    case 'items':
      return b.items - a.items;
    case 'seasons':
      return (b.seasons ?? -1) - (a.seasons ?? -1);
    case 'episodes':
      return (b.episodes ?? -1) - (a.episodes ?? -1);
    case 'streamed':
      return (b.lastPlayedAt?.getTime() ?? 0) - (a.lastPlayedAt?.getTime() ?? 0);
    case 'played':
      return (a.lastTitle ?? '').localeCompare(b.lastTitle ?? '');
    case 'duration':
      return b.watchtimeMs - a.watchtimeMs;
    default:
      return b.plays - a.plays;
  }
}

/**
 * Every library on one line: how much is in it, when it was last streamed and how much has
 * been watched from it — the shape Tautulli's library list has, because a table is what
 * answers "which of these is anyone actually using".
 *
 * The figures are server-wide for an admin and personal for everyone else, the same rule
 * the per-library page follows.
 */
export default async function LibrariesPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string; q?: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  const params = await searchParams;
  const serverId = session.user.serverId;
  const scope = isAdmin(session.user) ? adminScope(session.user) : { userId: session.user.id };

  const sort = (COLUMNS.find((column) => column.key === params.sort)?.key ?? 'plays') as SortKey;
  const descending = params.dir !== 'asc';
  const query = (params.q ?? '').trim().toLowerCase();

  const [sections, items, watchedRows] = await Promise.all([
    getSections(serverId).catch(() => []),
    getLibrary(serverId).catch(() => []),
    db
      .select({ itemId: watchHistory.itemId, title: watchHistory.title })
      .from(watchHistory)
      .where(eq(watchHistory.userId, session.user.id)),
  ]);

  // One aggregate per library: watch_history has no library column, so each is resolved
  // through its own item ids and titles. See librarystats.ts.
  const rows: Row[] = await Promise.all(
    sections.map(async (section) => {
      const totals = await getLibraryTotals(serverId, section.id, scope).catch(() => null);
      return {
        id: section.id,
        name: section.name,
        mediaType: section.mediaType,
        items: section.itemCount,
        seasons: section.seasonCount,
        episodes: section.episodeCount,
        plays: totals?.plays ?? 0,
        watchtimeMs: totals?.watchtimeMs ?? 0,
        lastPlayedAt: totals?.lastPlayedAt ?? null,
        lastTitle: totals?.lastTitle ?? null,
      };
    }),
  );

  const visible = rows
    .filter((row) => !query || row.name.toLowerCase().includes(query))
    .sort((a, b) => (descending ? compare(a, b, sort) : -compare(a, b, sort)));

  // Matched on both id and title: an episode's history row carries the episode id, never
  // the series id, so a show only counts as started through its name.
  const watchedIds = new Set(watchedRows.map((row) => row.itemId));
  const watchedTitles = new Set(watchedRows.map((row) => row.title.toLowerCase()));
  const unwatched = items.filter(
    (item) => !watchedIds.has(item.itemId) && !watchedTitles.has(item.title.toLowerCase()),
  );
  const posters = await cachedPosters(unwatched.slice(0, UNWATCHED_LIMIT));

  const totals = visible.reduce(
    (sum, row) => ({
      plays: sum.plays + row.plays,
      watchtimeMs: sum.watchtimeMs + row.watchtimeMs,
    }),
    { plays: 0, watchtimeMs: 0 },
  );

  return (
    <>
      <p className="eyebrow">{t('libraries.eyebrow')}</p>
      <h1>{t('nav.libraries')}</h1>
      <p className="subtitle">{t('libraries.tableSubtitle')}</p>

      <form className="filters">
        <label>
          {t('action.search')}
          <input name="q" defaultValue={params.q ?? ''} placeholder={t('libraries.searchPlaceholder')} />
        </label>
        {/* Carried through so searching does not silently reset the sort. */}
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={descending ? 'desc' : 'asc'} />
        <button>{t('action.apply')}</button>
      </form>

      {visible.length === 0 ? (
        <p className="muted">{query ? t('libraries.noMatch') : t('libraries.none')}</p>
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col" aria-label={t('libraries.colType')} />
                {COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className={column.numeric ? 'num' : undefined}>
                    <SortLink
                      t={t}
                      column={column.key}
                      label={t(column.labelKey)}
                      active={sort === column.key}
                      descending={descending}
                      params={params}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Icon name={row.mediaType === 'movie' ? 'film' : 'tv'} />
                  </td>
                  <td>
                    <Link href={`/libraries/${encodeURIComponent(row.id)}`}>{row.name}</Link>
                  </td>
                  <td className="muted">
                    {row.mediaType === 'movie' ? t('libraries.typeMovie') : t('libraries.typeShow')}
                  </td>
                  <td className="num">{row.items}</td>
                  <td className="num muted">{row.seasons ?? '—'}</td>
                  <td className="num muted">{row.episodes ?? '—'}</td>
                  <td className="num muted" style={{ whiteSpace: 'nowrap' }}>
                    {row.lastPlayedAt ? formatTimeAgo(t, row.lastPlayedAt) : t('common.never')}
                  </td>
                  <td className="muted">{row.lastTitle ?? '—'}</td>
                  <td className="num">{row.plays}</td>
                  <td className="num">{formatDuration(row.watchtimeMs)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={8} className="muted">
                  {t('libraries.totalRow', { count: visible.length })}
                </td>
                <td className="num">{totals.plays}</td>
                <td className="num">{formatDuration(totals.watchtimeMs)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <section className="section">
        <h2>{t('libraries.neverStarted')}</h2>
        <p className="muted" style={{ margin: '0 0 14px' }}>
          {t('libraries.neverStartedHint', { count: unwatched.length, total: items.length })}
        </p>
        <div className="poster-grid">
          {unwatched.slice(0, UNWATCHED_LIMIT).map((item) => (
            <div key={item.itemId} className="poster-card">
              <Link href={`/title/${encodeURIComponent(item.title)}`}>
                <Poster
                  src={artUrl(session.server.slug, item.itemId)}
                  fallback={posters.get(item.itemId)}
                  loading="lazy"
                />
                <p className="poster-title">{item.title}</p>
              </Link>
              <p className="poster-meta">
                {item.addedAt ? formatDate(item.addedAt) : (item.year ?? '')}
              </p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** A column header that flips direction when it is already the active sort. */
function SortLink({
  t,
  column,
  label,
  active,
  descending,
  params,
}: {
  t: Translate;
  column: SortKey;
  label: string;
  active: boolean;
  descending: boolean;
  params: { q?: string };
}) {
  const next = new URLSearchParams();
  if (params.q) next.set('q', params.q);
  next.set('sort', column);
  next.set('dir', active && descending ? 'asc' : 'desc');

  return (
    <Link
      href={`/libraries?${next}`}
      className={active ? 'sort on' : 'sort'}
      aria-sort={active ? (descending ? 'descending' : 'ascending') : undefined}
      aria-label={t('libraries.sortBy', { column: label })}
    >
      {label}
      <span aria-hidden>{active ? (descending ? ' ↓' : ' ↑') : ''}</span>
    </Link>
  );
}
