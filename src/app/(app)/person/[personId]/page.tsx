import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { Icon } from '@/components/Icons';
import { StatCard } from '@/components/Charts';
import { formatDate, formatDuration } from '@/components/format';
import { getSettings } from '@/server/config';
import { getPerson } from '@/server/tmdb';
import { adminScope, isAdmin, requireUser } from '@/server/session';
import { scopeFilter, type Scope } from '@/server/stats';
import { getT } from '@/i18n/server';

// No loading.tsx in this segment: it calls notFound(). See the streaming note in CLAUDE.md.
export const dynamic = 'force-dynamic';

interface SeenRow {
  label: string;
  plays: number;
  watchtimeMs: number;
  lastWatched: Date;
}

/**
 * Which of a person's credits appear in the watch history, matched on the title text.
 * There is no id to join on — the media server does not report TMDB ids and the history
 * only ever stored a display label — so this compares names, case-insensitively, in one
 * query rather than one per credit.
 */
async function seenTitles(titles: string[], scope: Scope): Promise<Map<string, SeenRow>> {
  if (!titles.length) return new Map();
  const rows = await db.all<{
    label: string;
    plays: number;
    watchtime: number;
    last_watched: number;
  }>(sql`
    SELECT coalesce(grandparent_title, title) AS label,
           count(*) AS plays,
           coalesce(sum(duration_ms), 0) AS watchtime,
           max(watched_at) AS last_watched
    FROM watch_history
    WHERE ${scopeFilter(scope)}
      AND lower(coalesce(grandparent_title, title)) IN (${sql.join(
        titles.map((title) => sql`${title.toLowerCase()}`),
        sql`, `,
      )})
    GROUP BY label
  `);

  return new Map(
    rows.map((r) => [
      r.label.toLowerCase(),
      {
        label: r.label,
        plays: Number(r.plays),
        watchtimeMs: Number(r.watchtime),
        lastWatched: new Date(Number(r.last_watched)),
      },
    ]),
  );
}

/** One actor: who they are according to TMDB, and what of theirs has actually been watched. */
export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ personId: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  const personId = Number((await params).personId);
  const settings = await getSettings();

  const person = await getPerson(settings.tmdbApiKey, personId);
  // Without a TMDB key there is nothing to show at all, which is a 404 rather than an
  // empty page: the route only exists because TMDB supplied the link that leads here.
  if (!person) notFound();

  const serverWide = (await searchParams).scope === 'server' && isAdmin(session.user);
  const scope = serverWide ? adminScope(session.user) : { userId: session.user.id };
  const seen = await seenTitles(
    person.knownFor.map((credit) => credit.title),
    scope,
  );

  const watched = person.knownFor.filter((credit) => seen.has(credit.title.toLowerCase()));
  const totalPlays = watched.reduce(
    (sum, credit) => sum + (seen.get(credit.title.toLowerCase())?.plays ?? 0),
    0,
  );
  const totalTime = watched.reduce(
    (sum, credit) => sum + (seen.get(credit.title.toLowerCase())?.watchtimeMs ?? 0),
    0,
  );

  return (
    <>
      <Link className="back-link" href="/stats">
        <Icon name="back" />
        {t('title.backToStats')}
      </Link>

      <div className="title-head">
        {person.profileUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img className="poster" src={person.profileUrl} alt="" />
        ) : (
          <span className="poster poster-blank" aria-hidden />
        )}
        <div>
          <p className="eyebrow">{t('title.cast')}</p>
          <h1>{person.name}</h1>
          <p className="subtitle">
            {[person.birthday, person.placeOfBirth].filter(Boolean).join(' · ') ||
              t('person.tmdbProfile')}
          </p>
          {person.biography && (
            <p className="overview">{person.biography.slice(0, 600)}
              {person.biography.length > 600 ? '…' : ''}
            </p>
          )}
        </div>
      </div>

      <div className="grid cols-4">
        <StatCard
          label={t('person.titlesWatched')}
          value={String(watched.length)}
          hint={t('person.ofCredits', { count: person.knownFor.length })}
          info={t('person.titlesInfo')}
        />
        <StatCard label={t('title.plays')} value={String(totalPlays)} />
        <StatCard label={t('common.watchTime')} value={formatDuration(totalTime)} />
        <StatCard
          label={t('person.scope')}
          value={serverWide ? t('person.scopeServer') : t('person.scopeYou')}
          hint={isAdmin(session.user) ? t('person.switchBelow') : undefined}
        />
      </div>

      {isAdmin(session.user) && (
        <p className="chips section">
          <Link className="badge" href={`/person/${personId}${serverWide ? '' : '?scope=server'}`}>
            {serverWide ? t('title.showMine') : t('title.showServerWide')}
          </Link>
        </p>
      )}

      <section className="section">
        <h2>{t('person.credits')}</h2>
        <div className="poster-grid">
          {person.knownFor.map((credit) => {
            const match = seen.get(credit.title.toLowerCase());
            const card = (
              <>
                {credit.posterUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img className="poster" src={credit.posterUrl} alt="" loading="lazy" />
                ) : (
                  <span className="poster poster-blank" aria-hidden />
                )}
                <p className="poster-title">{credit.title}</p>
              </>
            );

            return (
              <div key={`${credit.title}-${credit.year ?? ''}`} className="poster-card">
                {/* Only a watched credit links anywhere: a title the server does not have
                    would lead to a 404 on the title page. */}
                {match ? (
                  <Link href={`/title/${encodeURIComponent(match.label)}`}>{card}</Link>
                ) : (
                  card
                )}
                <p className="poster-meta">
                  {[credit.year, credit.character].filter(Boolean).join(' · ')}
                </p>
                {match && (
                  <p className="poster-meta num">
                    {match.plays}× · {formatDate(match.lastWatched)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
