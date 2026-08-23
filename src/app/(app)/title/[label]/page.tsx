import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BarChart, ColumnChart, StatCard } from '@/components/Charts';
import { Icon } from '@/components/Icons';
import OpenInServer from '@/components/OpenInServer';
import { formatDate, formatDuration, formatMinutes } from '@/components/format';
import { getTitleDetail } from '@/server/titles';
import { requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function TitlePage({
  params,
  searchParams,
}: {
  params: Promise<{ label: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await requireUser();
  const label = decodeURIComponent((await params).label);

  // Admins can look at a title across the whole server; everyone else sees their own plays.
  const serverWide = (await searchParams).scope === 'server' && session.user.isAdmin;
  const detail = await getTitleDetail(label, serverWide ? { userId: null } : { userId: session.user.id });
  if (!detail) notFound();

  const isShow = detail.distinctItems > 1;

  return (
    <>
      <Link className="back-link" href="/stats">
        <Icon name="back" />
        Back to statistics
      </Link>

      <div className="title-head">
        {detail.itemId && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img className="poster" src={`/api/art/${detail.itemId}`} alt="" />
        )}
        <div>
          <h1>{detail.label}</h1>
          <p className="subtitle">
            {[detail.year, isShow ? `${detail.distinctItems} episodes watched` : detail.mediaType]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {/* Genres are drill-downs, not decoration: each one filters the history. */}
          <ul className="chips">
            {detail.genres.map((genre) => (
              <li key={genre}>
                <Link className="badge" href={`/history?genre=${encodeURIComponent(genre)}`}>
                  {genre}
                </Link>
              </li>
            ))}
          </ul>
          <p className="chips">
            <OpenInServer itemId={detail.itemId} />
            {session.user.isAdmin && (
              <Link
                className="badge"
                href={`/title/${encodeURIComponent(detail.label)}${serverWide ? '' : '?scope=server'}`}
              >
                {serverWide ? 'Show only my plays' : 'Show server-wide'}
              </Link>
            )}
          </p>
        </div>
      </div>

      <div className="grid cols-4">
        <StatCard
          label="Plays"
          value={String(detail.plays)}
          info="Every recorded playback, including repeats of the same episode."
        />
        <StatCard
          label="Watch time"
          value={formatDuration(detail.watchtimeMs)}
          info="Sum of the runtime of all recorded playbacks."
        />
        <StatCard
          label="First watched"
          value={detail.firstWatched ? formatDate(detail.firstWatched) : '—'}
        />
        <StatCard
          label="Last watched"
          value={detail.lastWatched ? formatDate(detail.lastWatched) : '—'}
        />
      </div>

      <section className="section">
        <h2>Last 30 days (minutes)</h2>
        <div className="card">
          <ColumnChart data={detail.daily} format={formatMinutes} labelEvery={3} />
        </div>
      </section>

      <div className="grid cols-2 section">
        <section>
          <h2>Devices</h2>
          <div className="card">
            <BarChart data={detail.devices} format={formatMinutes} />
          </div>
        </section>
        {serverWide && (
          <section>
            <h2>Viewers</h2>
            <div className="card">
              <BarChart data={detail.viewers} format={formatMinutes} />
            </div>
          </section>
        )}
      </div>

      {/* For a show this is the episode list; for a movie it is a single row, so it is
          only worth its own section once there is more than one item. */}
      {detail.episodes.length > 1 && (
        <section className="section">
          <h2>{isShow ? 'Episodes you watched' : 'Versions you watched'}</h2>
          <div className="card">
            {detail.episodes.map((episode) => (
              <Link
                key={episode.itemId}
                className="episode-row"
                href={`/item/${encodeURIComponent(episode.itemId)}${serverWide ? '?scope=server' : ''}`}
              >
                <span className="ep-title">{episode.title}</span>
                <span className="ep-meta">
                  {episode.plays}× · {formatDuration(episode.watchtimeMs)}
                </span>
                <span className="ep-meta">{formatDate(episode.lastWatched)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <h2>Recent plays</h2>
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">Watched</th>
                <th scope="col">Item</th>
                <th scope="col">Duration</th>
                <th scope="col">Device</th>
              </tr>
            </thead>
            <tbody>
              {detail.recent.map((row, index) => (
                <tr key={`${row.title}-${index}`}>
                  <td>{formatDate(row.watchedAt)}</td>
                  <td>{row.title}</td>
                  <td>{formatDuration(row.durationMs)}</td>
                  <td>{row.deviceName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
