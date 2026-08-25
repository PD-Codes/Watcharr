import Link from 'next/link';
import { StatCard } from '@/components/Charts';
import { artUrl } from '@/components/format';
import { getAdapter } from '@/server/config';
import { getLibrary } from '@/server/library';
import { db } from '@/db';
import { watchHistory } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

const RECENT_LIMIT = 12;
const UNWATCHED_LIMIT = 24;

export default async function LibrariesPage() {
  const session = await requireUser();
  const adapter = await getAdapter(session.user.serverId);

  const [sections, items, recent, watchedRows] = await Promise.all([
    adapter.getLibraries().catch(() => []),
    getLibrary(session.user.serverId).catch(() => []),
    adapter.getRecentlyAdded(RECENT_LIMIT).catch(() => []),
    db
      .select({ itemId: watchHistory.itemId, title: watchHistory.title })
      .from(watchHistory)
      .where(eq(watchHistory.userId, session.user.id)),
  ]);

  // Matched on both id and title: an episode's history row carries the episode id, never
  // the series id, so a show only counts as started through its name.
  const watchedIds = new Set(watchedRows.map((row) => row.itemId));
  const watchedTitles = new Set(watchedRows.map((row) => row.title.toLowerCase()));
  const unwatched = items.filter(
    (item) => !watchedIds.has(item.itemId) && !watchedTitles.has(item.title.toLowerCase()),
  );

  return (
    <>
      <p className="eyebrow">Server</p>
      <h1>Libraries</h1>
      <p className="subtitle">
        What is on the server, what arrived recently, and what is still sitting there
        unwatched.
      </p>

      {sections.length === 0 ? (
        <p className="muted">The media server did not report any libraries.</p>
      ) : (
        <div className="grid cols-4">
          {sections.map((section) => (
            <StatCard
              key={section.id}
              label={section.name}
              value={String(section.itemCount)}
              hint={section.mediaType === 'movie' ? 'movies' : 'series'}
              href={`/libraries/${encodeURIComponent(section.id)}`}
              info="Opens this library's own usage figures."
            />
          ))}
        </div>
      )}

      <section className="section">
        <h2>Recently added</h2>
        {recent.length === 0 ? (
          <p className="muted">Nothing new.</p>
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

      <section className="section">
        <h2>Never started</h2>
        <p className="muted" style={{ margin: '0 0 14px' }}>
          {unwatched.length} of {items.length} titles have no play in your history.
        </p>
        <div className="poster-grid">
          {unwatched.slice(0, UNWATCHED_LIMIT).map((item) => (
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
      </section>
    </>
  );
}
