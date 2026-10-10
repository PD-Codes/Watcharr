import Link from 'next/link';
import { getWrappedYears } from '@/server/wrapped';
import { getStoryInput } from '@/server/wrapped-story';
import { buildSlides, parseYear } from '@/server/wrapped-story-core';
import { syncHistory, runInBackground } from '@/server/sync';
import { requireUser } from '@/server/session';
import { resolveView, viewQuery } from '@/server/viewscope';
import { getT } from '@/i18n/server';
import StoryClient from './StoryClient';

export const dynamic = 'force-dynamic';

export default async function WrappedStoryPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[]; view?: string | string[]; server?: string | string[] }>;
}) {
  // The signed-in user's own year, or (admins) a server's; no user parameter exists on purpose.
  const session = await requireUser();
  const t = await getT();
  runInBackground(syncHistory(session), 'history sync');

  const params = await searchParams;
  const view = await resolveView(session, params);
  // Same year rule as the report, so "Play as story" opens the year the person was reading.
  const years = await getWrappedYears(view.scope);
  const requested = parseYear(params.year);
  const year = years.includes(requested) ? requested : (years[0] ?? requested);
  const query = viewQuery(
    { kind: view.kind, server: view.servers.length > 1 ? view.server.slug : undefined },
    { year },
  );
  const back = `/wrapped${query}`;

  const input = await getStoryInput(
    view.scope,
    year,
    view.kind === 'server' ? view.server.label : session.user.username,
    view.server.slug,
  );
  const slides = buildSlides(input);

  if (slides.length === 0) {
    return (
      <>
        <h1>{t('story.title')}</h1>
        <p className="muted">{t('story.empty', { year })}</p>
        <Link className="btn ghost" href={back}>
          {t('story.backToReport')}
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="sr-only">{t('story.title')}</h1>
      <StoryClient slides={slides} year={year} query={query} voice={view.kind} />
    </>
  );
}
