import { notFound } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { users, watchHistory } from '@/db/schema';
import { BarChart, ColumnChart, StackedColumnChart, StatCard } from '@/components/Charts';
import { formatDate, formatDuration, formatMinutes } from '@/components/format';
import {
  getDailyActivity,
  getDailyPlays,
  getHighlights,
  getPeakHours,
  getTopDevices,
  getTopGenres,
  getTopTitles,
  getTotals,
  getWeekdayActivity,
} from '@/server/stats';
import IpLink from '@/components/IpLink';
import RevokeSessionButton from '@/components/RevokeSessionButton';
import StreamTable from '@/components/StreamTable';
import Tabs, { activeTab, type TabDef } from '@/components/Tabs';
import TitleLink from '@/components/TitleLink';
import {
  getStreamTypesOverTime,
  getUserAddresses,
  getUserPlayers,
  listSessionHistory,
} from '@/server/playback';
import { canSee, listUserSessions, requireAdmin } from '@/server/session';
import type { TranslationKey } from '@/i18n';
import { getT } from '@/i18n/server';

// No loading.tsx in this segment: it calls notFound(). See the streaming note in CLAUDE.md.
export const dynamic = 'force-dynamic';

// Labels are resolved per request, so the tab order stays a module-level constant while the
// text follows the reader's locale.
const TAB_KEYS = [
  { key: 'overview', labelKey: 'nav.overview' },
  { key: 'stats', labelKey: 'nav.stats' },
  { key: 'history', labelKey: 'nav.history' },
  { key: 'streams', labelKey: 'nav.adminStreams' },
  { key: 'devices', labelKey: 'users.tabDevices' },
  { key: 'sessions', labelKey: 'profile.tabSessions' },
] as const satisfies readonly { key: string; labelKey: TranslationKey }[];

const HISTORY_LIMIT = 50;
const STREAM_LIMIT = 50;

/**
 * One user, split into tabs. Everything used to render on a single page, which meant a
 * dozen aggregate queries ran on every visit no matter which part was being looked at —
 * each tab now costs only its own.
 */
export default async function AdminUserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await requireAdmin();
  const t = await getT();
  const TABS: TabDef[] = TAB_KEYS.map(({ key, labelKey }) => ({ key, label: t(labelKey) }));
  const userId = Number((await params).id);
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  // 404 rather than 403: a server admin should not learn that an account exists on another
  // server just because the page refuses to show it.
  if (!user || !canSee(session.user, user)) notFound();

  const tab = activeTab(TABS, (await searchParams).tab);
  const scope = { userId };

  const head = (
    <>
      <h1>{user.username}</h1>
      <p className="subtitle">
        {user.isAdmin ? t('common.administrator') : t('users.roleUser')} ·{' '}
        {user.lastSeenAt
          ? t('users.lastSeen', { date: formatDate(user.lastSeenAt) })
          : t('users.neverSignedIn')}
      </p>
      <Tabs tabs={TABS} current={tab} hrefFor={(key) => `/admin/users/${userId}?tab=${key}`} />
    </>
  );

  if (tab === 'overview') {
    const [totals, highlights, daily, titles] = await Promise.all([
      getTotals(scope),
      getHighlights(scope),
      getDailyActivity(scope, 30),
      getTopTitles(scope),
    ]);

    return (
      <>
        {head}
        <div className="grid cols-4">
          <StatCard
            label={t('common.watchTime')}
            value={formatDuration(totals.watchtimeMs)}
            info={t('users.watchTimeInfo')}
          />
          <StatCard
            label={t('users.colPlays')}
            value={String(totals.plays)}
            hint={t('users.activeDays', { count: totals.activeDays })}
          />
          <StatCard label={t('common.movies')} value={String(totals.movies)} />
          <StatCard label={t('common.episodes')} value={String(totals.episodes)} />
          <StatCard
            label={t('users.distinctTitles')}
            value={String(highlights.distinctTitles)}
            info={t('users.distinctTitlesInfo')}
          />
          <StatCard
            label={t('users.longestStreak')}
            value={t('users.longestStreakValue', { count: highlights.longestStreak })}
            info={t('users.longestStreakInfo')}
          />
          <StatCard label={t('users.averagePlay')} value={formatDuration(highlights.averagePlayMs)} />
          <StatCard
            label={t('users.busiestDay')}
            value={highlights.busiestDay ? formatMinutes(highlights.busiestDay.minutes) : '—'}
            hint={highlights.busiestDay?.day}
          />
        </div>

        <section className="section">
          <h2>{t('users.last30Days')}</h2>
          <div className="card">
            <ColumnChart data={daily} format={formatMinutes} labelEvery={3} />
          </div>
        </section>

        <section className="section">
          <h2>{t('users.topTitles')}</h2>
          <div className="card">
            <BarChart
              data={titles}
              format={(v) => t('common.plays', { count: v })}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}?scope=server`}
            />
          </div>
        </section>
      </>
    );
  }

  if (tab === 'stats') {
    const [genres, weekdays, hours, plays, devices] = await Promise.all([
      getTopGenres(scope),
      getWeekdayActivity(scope),
      getPeakHours(scope),
      getDailyPlays(scope, 30),
      getTopDevices(scope),
    ]);

    return (
      <>
        {head}
        <div className="grid cols-2">
          <section>
            <h2>{t('users.topGenres')}</h2>
            <div className="card">
              <BarChart
                data={genres}
                format={(v) => t('common.plays', { count: v })}
                hrefFor={(label) => `/history?genre=${encodeURIComponent(label)}`}
              />
            </div>
          </section>
          <section>
            <h2>{t('users.devices')}</h2>
            <div className="card">
              <BarChart data={devices} format={formatMinutes} />
            </div>
          </section>
        </div>

        <div className="grid cols-2 section">
          <section>
            <h2>{t('users.byWeekday')}</h2>
            <div className="card">
              <ColumnChart data={weekdays} format={formatMinutes} />
            </div>
          </section>
          <section>
            <h2>{t('users.byHour')}</h2>
            <div className="card">
              <ColumnChart
                data={hours}
                format={(v) => t('common.plays', { count: v })}
                labelEvery={3}
              />
            </div>
          </section>
        </div>

        <section className="section">
          <h2>{t('users.dailyPlayCount')}</h2>
          <div className="card">
            <ColumnChart
              data={plays}
              format={(v) => t('common.plays', { count: v })}
              labelEvery={3}
            />
          </div>
        </section>
      </>
    );
  }

  if (tab === 'history') {
    const recent = await db
      .select()
      .from(watchHistory)
      .where(eq(watchHistory.userId, userId))
      .orderBy(desc(watchHistory.watchedAt))
      .limit(HISTORY_LIMIT);

    return (
      <>
        {head}
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('common.watched')}</th>
                <th scope="col">{t('common.title')}</th>
                <th scope="col">{t('common.type')}</th>
                <th scope="col">{t('common.duration')}</th>
                <th scope="col">{t('common.device')}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id}>
                  <td className="num muted" style={{ whiteSpace: 'nowrap' }}>
                    {formatDate(row.watchedAt)}
                  </td>
                  <td>
                    <TitleLink
                      itemId={row.itemId}
                      title={row.title}
                      grandparentTitle={row.grandparentTitle}
                      serverWide
                    />
                  </td>
                  <td className="muted">{row.mediaType}</td>
                  <td className="num">{formatDuration(row.durationMs)}</td>
                  <td className="muted">{row.deviceName ?? '—'}</td>
                </tr>
              ))}
              {recent.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    {t('users.nothingPlayed')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  if (tab === 'streams') {
    const [streams, types] = await Promise.all([
      listSessionHistory({ scope, limit: STREAM_LIMIT }),
      getStreamTypesOverTime(30, scope),
    ]);

    return (
      <>
        {head}
        <section>
          <h2>{t('users.streamDelivery')}</h2>
          <div className="card">
            <StackedColumnChart
              labels={types.labels}
              series={types.series}
              format={(v) => t('common.streams', { count: v })}
            />
          </div>
        </section>

        <section className="section">
          <h2>{t('users.recentStreams')}</h2>
          <div className="card">
            <StreamTable rows={streams.rows} showAddress emptyLabel={t('users.noStreams')} />
          </div>
        </section>
      </>
    );
  }

  if (tab === 'devices') {
    const [players, addresses] = await Promise.all([
      getUserPlayers(userId),
      getUserAddresses(userId),
    ]);

    return (
      <>
        {head}
        <div className="grid cols-2">
          <section>
            <h2>{t('users.players')}</h2>
            <div className="card">
              <BarChart data={players} format={(v) => t('common.sessions', { count: v })} />
            </div>
          </section>
          <section>
            <h2>{t('users.addresses')}</h2>
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('users.colAddress')}</th>
                    <th scope="col">{t('users.colLastStreamed')}</th>
                    <th scope="col">{t('users.colPlays')}</th>
                  </tr>
                </thead>
                <tbody>
                  {addresses.map((row) => (
                    <tr key={row.ip}>
                      <td>
                        <IpLink ip={row.ip} />
                        <div className="muted" style={{ fontSize: 12 }}>
                          {row.isLocal ? t('stream.lan') : t('stream.wan')}
                          {row.lastPlayer ? ` · ${row.lastPlayer}` : ''}
                        </div>
                      </td>
                      <td className="muted">{formatDate(row.lastSeen)}</td>
                      <td className="num">{row.plays}</td>
                    </tr>
                  ))}
                  {addresses.length === 0 && (
                    <tr>
                      <td colSpan={3} className="muted">
                        {t('users.noAddresses')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </>
    );
  }

  const sessions = await listUserSessions(userId);
  return (
    <>
      {head}
      <p className="subtitle" style={{ marginTop: -8 }}>
        {t('users.sessionsSubtitle')}
      </p>
      <div className="table-wrap card">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('users.colSignedIn')}</th>
              <th scope="col">{t('users.colExpires')}</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{formatDate(s.createdAt)}</td>
                <td>{formatDate(s.expiresAt)}</td>
                <td>
                  <RevokeSessionButton id={s.id} />
                </td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  {t('users.noSessions')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
