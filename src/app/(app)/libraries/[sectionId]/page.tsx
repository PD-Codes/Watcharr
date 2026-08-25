import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BarChart, StatCard } from '@/components/Charts';
import { artUrl, formatDate, formatDuration } from '@/components/format';
import { getAdapter } from '@/server/config';
import { getLibrary } from '@/server/library';
import {
  getLibraryTopTitles,
  getLibraryTotals,
  getLibraryUsers,
} from '@/server/librarystats';
import { adminScope, isAdmin, requireUser } from '@/server/session';

// No loading.tsx in this segment: it calls notFound(). See the streaming note in CLAUDE.md.
export const dynamic = 'force-dynamic';

const RECENT_LIMIT = 12;

export default async function LibraryDetailPage({
  params,
}: {
  params: Promise<{ sectionId: string }>;
}) {
  const session = await requireUser();
  const { sectionId } = await params;
  const serverId = session.user.serverId;

  const sections = await (await getAdapter(serverId)).getLibraries().catch(() => []);
  const section = sections.find((s) => s.id === sectionId);
  if (!section) notFound();

  // An admin sees the whole library's usage, everyone else only their own.
  const scope = isAdmin(session.user) ? adminScope(session.user) : { userId: session.user.id };

  const [allTime, day, week, month, users, top, items, recent] = await Promise.all([
    getLibraryTotals(serverId, sectionId, scope),
    getLibraryTotals(serverId, sectionId, scope, 1),
    getLibraryTotals(serverId, sectionId, scope, 7),
    getLibraryTotals(serverId, sectionId, scope, 30),
    getLibraryUsers(serverId, sectionId, scope),
    getLibraryTopTitles(serverId, sectionId, scope),
    getLibrary(serverId).then((all) => all.filter((item) => item.sectionId === sectionId)),
    (await getAdapter(serverId)).getRecentlyAdded(RECENT_LIMIT, sectionId).catch(() => []),
  ]);

  return (
    <>
      <p className="eyebrow">
        <Link href="/libraries">Libraries</Link>
      </p>
      <h1>{section.name}</h1>
      <p className="subtitle">
        {items.length} items · {section.mediaType === 'movie' ? 'movies' : 'series'}
        {isAdmin(session.user) ? ' · server-wide figures' : ' · your plays only'}
      </p>

      <div className="grid cols-4">
        <StatCard label="Last 24 hours" value={String(day.plays)} hint={formatDuration(day.watchtimeMs)} />
        <StatCard label="Last 7 days" value={String(week.plays)} hint={formatDuration(week.watchtimeMs)} />
        <StatCard label="Last 30 days" value={String(month.plays)} hint={formatDuration(month.watchtimeMs)} />
        <StatCard
          label="All time"
          value={String(allTime.plays)}
          hint={formatDuration(allTime.watchtimeMs)}
          info="Plays counted from the media server's own history, so this reaches back before Watcharr was installed."
        />
      </div>

      {allTime.lastTitle && (
        <p className="muted section" style={{ marginTop: 18 }}>
          Last played: {allTime.lastTitle}
          {allTime.lastPlayedAt ? ` · ${formatDate(allTime.lastPlayedAt)}` : ''}
        </p>
      )}

      <div className="grid cols-2 section">
        <section>
          <h2>Most played</h2>
          <div className="card">
            <BarChart
              data={top}
              format={(v) => `${v} plays`}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}`}
            />
          </div>
        </section>
        <section>
          <h2>{isAdmin(session.user) ? 'Users' : 'Your plays'}</h2>
          <div className="card">
            <BarChart data={users} format={(v) => `${v} plays`} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>Recently added</h2>
        {recent.length === 0 ? (
          <p className="muted">Nothing new in this library.</p>
        ) : (
          <div className="poster-grid">
            {recent.map((item) => (
              <div key={item.itemId} className="poster-card">
                <Link href={`/title/${encodeURIComponent(item.title)}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="poster"
                    src={artUrl(session.server.slug, item.itemId)}
                    alt=""
                    loading="lazy"
                  />
                  <p className="poster-title">{item.title}</p>
                </Link>
                <p className="poster-meta">{item.year ?? ''}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
