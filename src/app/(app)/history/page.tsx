import Link from 'next/link';
import { desc, sql } from 'drizzle-orm';
import { db } from '@/db';
import { watchHistory } from '@/db/schema';
import { Icon } from '@/components/Icons';
import { formatDate, formatDuration, isoDay } from '@/components/format';
import { historyFilters } from '@/server/history';
import { syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface Params {
  q?: string;
  type?: string;
  days?: string;
  genre?: string;
  date?: string;
  weekday?: string;
  hour?: string;
  page?: string;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Keeps every filter when only one of them changes. */
function withParams(params: Params, patch: Record<string, string | undefined>): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...patch })) {
    if (value) next.set(key, value);
  }
  next.delete('page');
  const query = next.toString();
  return query ? `?${query}` : '?';
}

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const session = await requireUser();
  await syncHistory(session.user.id, session.user.serverUserId, session.serverToken).catch(() => {});

  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1));
  const where = historyFilters(session.user.id, params);

  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(watchHistory)
      .where(where)
      .orderBy(desc(watchHistory.watchedAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)` }).from(watchHistory).where(where),
  ]);

  const pages = Math.max(1, Math.ceil((count?.total ?? 0) / PAGE_SIZE));
  const periods: [string, string][] = [
    ['', 'All time'],
    ['7', '7 days'],
    ['30', '30 days'],
    ['365', 'Last year'],
  ];
  // The narrowing filters arrive from a click somewhere else, so they need a way back out.
  const pinned = [
    params.genre ? { key: 'genre', text: `Genre: ${params.genre}` } : null,
    params.date ? { key: 'date', text: `Day: ${params.date}` } : null,
    params.weekday && WEEKDAYS[Number(params.weekday)]
      ? { key: 'weekday', text: WEEKDAYS[Number(params.weekday)] }
      : null,
    params.hour ? { key: 'hour', text: `${String(params.hour).padStart(2, '0')}:00` } : null,
  ].filter((chip): chip is { key: string; text: string } => chip !== null);

  const exportHref = `/api/history/export${withParams(params, { page: undefined })}`;

  return (
    <>
      <p className="eyebrow">Library</p>
      <h1>History</h1>
      <p className="subtitle">{count?.total ?? 0} plays recorded.</p>

      <div className="section-head" style={{ marginTop: 0 }}>
        <div className="seg">
          {periods.map(([value, label]) => (
            <Link
              key={label}
              href={withParams(params, { days: value || undefined })}
              className={(params.days ?? '') === value ? 'on' : undefined}
            >
              {label}
            </Link>
          ))}
        </div>
        <a className="link-out" href={exportHref} download>
          <Icon name="download" />
          Export CSV
        </a>
      </div>

      {pinned.length > 0 && (
        <ul className="chips" style={{ marginBottom: 18 }}>
          {pinned.map((chip) => (
            <li key={chip.key}>
              <Link className="badge on" href={withParams(params, { [chip.key]: undefined })}>
                {chip.text} ✕
              </Link>
            </li>
          ))}
        </ul>
      )}

      <form className="filters">
        {/* Carried through the form so a search does not silently drop a pinned filter. */}
        {params.genre && <input type="hidden" name="genre" value={params.genre} />}
        {params.date && <input type="hidden" name="date" value={params.date} />}
        {params.days && <input type="hidden" name="days" value={params.days} />}
        {params.weekday && <input type="hidden" name="weekday" value={params.weekday} />}
        {params.hour && <input type="hidden" name="hour" value={params.hour} />}
        <label>
          Search
          <input name="q" defaultValue={params.q ?? ''} placeholder="Title…" />
        </label>
        <label>
          Type
          <select name="type" defaultValue={params.type ?? ''}>
            <option value="">All</option>
            <option value="movie">Movies</option>
            <option value="episode">Episodes</option>
          </select>
        </label>
        <button>Apply</button>
      </form>

      {rows.length === 0 ? (
        <p className="muted">No plays match these filters.</p>
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">Watched</th>
                <th scope="col">Title</th>
                <th scope="col">Genres</th>
                <th scope="col">Type</th>
                <th scope="col">Year</th>
                <th scope="col">Duration</th>
                <th scope="col">Device</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="num muted" style={{ whiteSpace: 'nowrap' }}>
                    <Link href={`/history?date=${isoDay(row.watchedAt)}`}>
                      {formatDate(row.watchedAt)}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/title/${encodeURIComponent(row.grandparentTitle ?? row.title)}`}>
                      {row.grandparentTitle ?? row.title}
                    </Link>
                    {row.grandparentTitle && (
                      <div style={{ fontSize: 12 }}>
                        {/* The episode itself has its own page now. */}
                        <Link className="muted" href={`/item/${encodeURIComponent(row.itemId)}`}>
                          {row.title}
                        </Link>
                      </div>
                    )}
                  </td>
                  <td className="muted">
                    {row.genres.slice(0, 2).map((genre, index) => (
                      <span key={genre}>
                        {index > 0 && ', '}
                        <Link href={`/history?genre=${encodeURIComponent(genre)}`}>{genre}</Link>
                      </span>
                    ))}
                    {row.genres.length === 0 && '—'}
                  </td>
                  <td className="muted">{row.mediaType}</td>
                  <td className="num muted">{row.year ?? '—'}</td>
                  <td className="num">{formatDuration(row.durationMs)}</td>
                  <td className="muted">{row.deviceName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <p className="row section">
          {page > 1 && (
            <a className="badge" href={`?${new URLSearchParams({ ...params, page: String(page - 1) })}`}>
              Previous
            </a>
          )}
          <span className="muted">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <a className="badge" href={`?${new URLSearchParams({ ...params, page: String(page + 1) })}`}>
              Next
            </a>
          )}
        </p>
      )}
    </>
  );
}
