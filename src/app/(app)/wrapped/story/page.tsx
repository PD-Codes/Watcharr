import Link from 'next/link';
import { getWrappedYears } from '@/server/wrapped';
import { getStoryInput } from '@/server/wrapped-story';
import { buildSlides, parseYear } from '@/server/wrapped-story-core';
import { reportSyncError, syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';
import StoryClient from './StoryClient';

export const dynamic = 'force-dynamic';

export default async function WrappedStoryPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  // Always the signed-in user's own year; no user parameter exists on purpose.
  const session = await requireUser();
  const t = await getT();
  await syncHistory(session).catch(reportSyncError('history sync'));

  // Same year rule as the report, so "Play as story" opens the year the person was reading.
  const years = await getWrappedYears(session.user.id);
  const requested = parseYear((await searchParams).year);
  const year = years.includes(requested) ? requested : (years[0] ?? requested);

  const input = await getStoryInput(session.user.id, year, session.user.username, session.server.slug);
  const slides = buildSlides(input);

  if (slides.length === 0) {
    return (
      <>
        <h1>{t('story.title')}</h1>
        <p className="muted">{t('story.empty', { year })}</p>
        <Link className="btn ghost" href={`/wrapped?year=${year}`}>
          {t('story.backToReport')}
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="sr-only">{t('story.title')}</h1>
      <StoryClient slides={slides} year={year} />
    </>
  );
}
