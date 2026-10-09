import Link from 'next/link';
import OpenInServer from '@/components/OpenInServer';
import { getPickData } from '@/server/pick';
import { parseFilters } from '@/server/pick-core';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';
import PickClient from './PickClient';
import './pick.css';

export const dynamic = 'force-dynamic';

export default async function PickPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireUser();
  const t = await getT();
  const { candidates, hasRuntime, suggestionsOn } = await getPickData(session);
  // A ?len= left in a shared link means nothing when no title has a runtime, and the control
  // that could undo it is hidden: drop it rather than filter by something invisible.
  const parsed = parseFilters(await searchParams);
  const filters = hasRuntime ? parsed : { ...parsed, length: 'any' as const };

  return (
    <>
      <p className="eyebrow">{t('pick.eyebrow')}</p>
      <h1>{t('pick.title')}</h1>
      <p className="subtitle">{t('pick.subtitle')}</p>

      {candidates.length === 0 ? (
        <div className="card">
          <h2>{t('pick.emptyTitle')}</h2>
          <p className="muted">{t('pick.emptyBody')}</p>
          <div className="pick-actions">
            <Link className="btn" href="/watchlist">
              {t('pick.openWatchlist')}
            </Link>
            {suggestionsOn && (
              <Link className="btn ghost" href="/suggestions">
                {t('pick.openSuggestions')}
              </Link>
            )}
          </div>
        </div>
      ) : (
        <PickClient
          candidates={candidates}
          initialFilters={filters}
          hasRuntime={hasRuntime}
          // Rendered here because the component is a server one (it reads the server config);
          // the client only decides which of these to show for the winner.
          openIn={Object.fromEntries(
            candidates.map((c) => [
              c.itemId,
              <OpenInServer key={c.itemId} itemId={c.itemId} serverId={session.user.serverId} />,
            ]),
          )}
        />
      )}
    </>
  );
}
