import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BarChart, StatCard } from '@/components/Charts';
import { Icon } from '@/components/Icons';
import OpenInServer from '@/components/OpenInServer';
import { artUrl, formatDate, formatDuration, formatMinutes } from '@/components/format';
import { getItemDetail } from '@/server/titles';
import { adminScope, isAdmin, requireUser } from '@/server/session';

// No loading.tsx in this segment: streaming pins the status at 200 and this route has to
// be able to answer 404. See the note in CLAUDE.md.
export const dynamic = 'force-dynamic';

/** One episode or one movie — the level below /title/[label]. */
export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await requireUser();
  const itemId = decodeURIComponent((await params).itemId);

  const serverWide = (await searchParams).scope === 'server' && isAdmin(session.user);
  const detail = await getItemDetail(itemId, serverWide ? adminScope(session.user) : { userId: session.user.id });
  if (!detail) notFound();

  return (
    <>
      <Link
        className="back-link"
        href={detail.showLabel ? `/title/${encodeURIComponent(detail.showLabel)}` : '/history'}
      >
        <Icon name="back" />
        {detail.showLabel ? `Back to ${detail.showLabel}` : 'Back to history'}
      </Link>

      <div className="title-head">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="poster" src={artUrl(session.server.slug, detail.itemId)} alt="" />
        <div>
          {detail.showLabel && <p className="eyebrow">{detail.showLabel}</p>}
          <h1>{detail.title}</h1>
          <p className="subtitle">
            {[detail.year, detail.mediaType].filter(Boolean).join(' · ')}
          </p>
          <ul className="chips">
            {detail.genres.map((genre) => (
              <li key={genre}>
                <Link className="badge" href={`/history?genre=${encodeURIComponent(genre)}`}>
                  {genre}
                </Link>
              </li>
            ))}
          </ul>
          <p className="poster-actions">
            <OpenInServer itemId={detail.itemId} serverId={session.user.serverId} />
          </p>
        </div>
      </div>

      <div className="grid cols-4">
        <StatCard label="Plays" value={String(detail.plays)} info="Every recorded playback of this exact item." />
        <StatCard label="Watch time" value={formatDuration(detail.watchtimeMs)} />
        <StatCard label="First watched" value={detail.firstWatched ? formatDate(detail.firstWatched) : '—'} />
        <StatCard label="Last watched" value={detail.lastWatched ? formatDate(detail.lastWatched) : '—'} />
      </div>

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

      <section className="section">
        <h2>Every play</h2>
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">Watched</th>
                <th scope="col">Duration</th>
                <th scope="col">Device</th>
              </tr>
            </thead>
            <tbody>
              {detail.plays_list.map((row, index) => (
                <tr key={`${row.watchedAt.getTime()}-${index}`}>
                  <td className="num muted">{formatDate(row.watchedAt)}</td>
                  <td className="num">{formatDuration(row.durationMs)}</td>
                  <td className="muted">{row.deviceName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
