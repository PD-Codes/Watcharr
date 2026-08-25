import Link from 'next/link';
import { artUrl } from '@/components/format';
import { notFound } from 'next/navigation';
import OpenInServer from '@/components/OpenInServer';
import { getSettings } from '@/server/config';
import { isEnabled } from '@/server/features';
import { getSuggestions } from '@/server/suggestions';
import { reportSyncError, syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function SuggestionsPage() {
  const session = await requireUser();
  const settings = await getSettings();
  if (!isEnabled(settings.features, 'suggestions')) notFound();
  await syncHistory(session.user, session.serverToken).catch(reportSyncError('history sync'));
  const { fromLibrary, fromTmdb } = await getSuggestions(session.user.id, session.user.serverId);

  return (
    <>
      <p className="eyebrow">You</p>
      <h1>Suggestions</h1>
      <p className="subtitle">
        Based on the genres, decades and formats you already watch. Refreshed daily.
      </p>

      {fromLibrary.length === 0 ? (
        <p className="muted">Watch a few titles first — suggestions need some history to work with.</p>
      ) : (
        <div className="poster-grid">
          {fromLibrary.map((item) => (
            <div key={item.itemId} className="poster-card">
              {/* The card opens the app's own detail view; the button next to it hands the
                  title over to the media server, which is where you can actually play it. */}
              <Link href={`/title/${encodeURIComponent(item.title)}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="poster" src={artUrl(session.server.slug, item.itemId)} alt="" loading="lazy" />
                <p className="poster-title">{item.title}</p>
              </Link>
              <p className="poster-meta">
                {item.year ?? ''} · {item.reason}
              </p>
              <div className="poster-actions">
                <OpenInServer itemId={item.itemId} serverId={session.user.serverId} />
              </div>
            </div>
          ))}
        </div>
      )}

      {fromTmdb.length > 0 && (
        <section className="section">
          <h2>Similar titles from TMDB</h2>
          <div className="poster-grid">
            {fromTmdb.map((item) => (
              <div key={`${item.title}-${item.year ?? ''}`}>
                {item.posterUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img className="poster" src={item.posterUrl} alt="" loading="lazy" />
                )}
                <p className="poster-title">{item.title}</p>
                <p className="poster-meta">{item.year ?? ''}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
