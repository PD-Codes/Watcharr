import Link from 'next/link';
import {
  AreaChart,
  BarChart,
  ColumnChart,
  DonutChart,
  StackedColumnChart,
} from '@/components/Charts';
import { formatMinutes } from '@/components/format';
import {
  getDailyActivity,
  getDailyPlays,
  getPeakHours,
  getPlaysByMediaType,
  getPlaysByUser,
  getUserLeaderboard,
  getWeekdayPlays,
} from '@/server/stats';
import {
  getBandwidthOverTime,
  getClientSessions,
  getConcurrencyOverTime,
  getResolutions,
  getStreamTypesOverTime,
} from '@/server/playback';
import { adminScope, requireAdmin } from '@/server/session';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const PERIODS = [7, 30, 90, 365];

/** Plays and streams over time — the set of charts Tautulli's Graphs page answers with. */
export default async function AdminGraphsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await requireAdmin();
  const t = await getT();
  const requested = Number((await searchParams).days ?? 30);
  const days = PERIODS.includes(requested) ? requested : 30;

  const scope = adminScope(session.user);
  // A server admin sees their own server only; a global admin sees everything.
  const onlyServer = session.user.globalAdmin ? undefined : session.user.serverId;

  const [
    dailyPlays,
    dailyMinutes,
    weekdayPlays,
    hours,
    byType,
    byUserPlays,
    byUserMinutes,
    platforms,
    resolutions,
    streamTypes,
    concurrency,
    bandwidth,
  ] = await Promise.all([
    getDailyPlays(scope, days),
    getDailyActivity(scope, days),
    getWeekdayPlays(scope, days),
    getPeakHours(scope),
    getPlaysByMediaType(scope, days),
    getPlaysByUser(onlyServer, days),
    getUserLeaderboard(onlyServer),
    getClientSessions(days, scope),
    getResolutions(days, scope),
    getStreamTypesOverTime(Math.min(days, 90), scope),
    getConcurrencyOverTime(Math.min(days, 30), scope),
    getBandwidthOverTime(Math.min(days, 30), scope),
  ]);

  const plays = (value: number) => t('common.plays', { count: value });
  const streams = (value: number) => t('common.streams', { count: value });
  // Bandwidth is summed in kbps across overlapping sessions, so it is only readable in Mbps.
  const mbps = (value: number) => `${(value / 1000).toFixed(1)} Mbps`;

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminGraphs')}</h1>
      <p className="subtitle">{t('graphs.subtitle')}</p>

      <div className="seg">
        {PERIODS.map((period) => (
          <Link
            key={period}
            href={`/admin/graphs?days=${period}`}
            className={period === days ? 'on' : undefined}
          >
            {period === 365 ? t('common.lastYear') : t('common.days', { count: period })}
          </Link>
        ))}
      </div>

      <section className="section">
        <h2>{t('graphs.dailyPlayCount')}</h2>
        <div className="card">
          <ColumnChart data={dailyPlays} format={plays} labelEvery={Math.ceil(days / 12)} />
        </div>
      </section>

      <section className="section">
        <h2>{t('graphs.dailyWatchTime')}</h2>
        <div className="card">
          <AreaChart data={dailyMinutes} format={formatMinutes} />
        </div>
      </section>

      <section className="section">
        <h2>{t('graphs.streamDelivery')}</h2>
        <div className="card">
          <StackedColumnChart labels={streamTypes.labels} series={streamTypes.series} format={streams} />
        </div>
      </section>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('graphs.playsByWeekday')}</h2>
          <div className="card">
            <ColumnChart data={weekdayPlays} format={plays} />
          </div>
        </section>
        <section>
          <h2>{t('graphs.playsByHour')}</h2>
          <div className="card">
            <ColumnChart data={hours} format={plays} labelEvery={3} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('graphs.playsByUser')}</h2>
          <div className="card">
            <BarChart
              data={byUserPlays}
              format={plays}
              hrefFor={undefined}
            />
          </div>
        </section>
        <section>
          <h2>{t('graphs.watchTimeByUser')}</h2>
          <div className="card">
            <BarChart data={byUserMinutes} format={formatMinutes} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('graphs.playsByPlatform')}</h2>
          <div className="card">
            <BarChart data={platforms} format={streams} />
          </div>
        </section>
        <section>
          <h2>{t('graphs.playsByMediaType')}</h2>
          <div className="card">
            <DonutChart data={byType} format={plays} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('graphs.streamsByResolution')}</h2>
          <div className="card">
            <DonutChart data={resolutions} format={streams} />
          </div>
        </section>
        <section>
          <h2>{t('graphs.concurrentStreams')}</h2>
          <div className="card">
            <AreaChart
              data={concurrency.map((point) => ({ label: point.label, value: point.streams }))}
              format={streams}
            />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>{t('graphs.bandwidthSplit')}</h2>
        <p className="muted" style={{ margin: '0 0 14px' }}>
          {t('graphs.bandwidthNote')}
        </p>
        <div className="card">
          <StackedColumnChart
            labels={bandwidth.map((point) => point.label)}
            series={[
              { label: t('stream.lan'), values: bandwidth.map((point) => point.lanKbps) },
              { label: t('stream.remote'), values: bandwidth.map((point) => point.wanKbps) },
            ]}
            format={mbps}
          />
        </div>
      </section>
    </>
  );
}
