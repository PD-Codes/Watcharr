import Link from 'next/link';
import Poster from '@/components/Poster';
import { artUrl } from '@/components/format';
import { notFound } from 'next/navigation';
import OpenInServer from '@/components/OpenInServer';
import { getSettings } from '@/server/config';
import { isEnabled } from '@/server/features';
import { getSuggestions } from '@/server/suggestions';
import { cachedPosters } from '@/server/tmdb';
import { reportSyncError, syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function SuggestionsPage() {
  const session = await requireUser();
  const t = await getT();
  const settings = await getSettings();
  if (!isEnabled(settings.features, 'suggestions')) notFound();
  await syncHistory(session).catch(reportSyncError('history sync'));
  const { fromLibrary, fromTmdb } = await getSuggestions(session.user.id, session.user.serverId);
  const posters = await cachedPosters(fromLibrary);

  return (
    <>
      <p className="eyebrow">{t('stats.eyebrow')}</p>
      <h1>{t('nav.suggestions')}</h1>
      <p className="subtitle">{t('suggestions.subtitle')}</p>

      {fromLibrary.length === 0 ? (
        <p className="muted">{t('suggestions.empty')}</p>
      ) : (
        <div className="poster-grid">
          {fromLibrary.map((item) => (
            <div key={item.itemId} className="poster-card">
              {/* The card opens the app's own detail view; the button next to it hands the
                  title over to the media server, which is where you can actually play it. */}
              <Link href={`/title/${encodeURIComponent(item.title)}`}>
                <Poster
                  src={artUrl(session.server.slug, item.itemId)}
                  fallback={posters.get(item.itemId)}
                  loading="lazy"
                />
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
          <h2>{t('suggestions.tmdb')}</h2>
          <div className="poster-grid">
            {fromTmdb.map((item) => (
              <div key={`${item.title}-${item.year ?? ''}`}>
                <Poster src={item.posterUrl} loading="lazy" />
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
