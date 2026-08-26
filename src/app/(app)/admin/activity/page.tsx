import { and, eq, like } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions, users } from '@/db/schema';
import ActivityTable from '@/components/ActivityTable';
import AutoRefresh from '@/components/AutoRefresh';
import { AreaChart, StatCard } from '@/components/Charts';
import { liveSessionFilter, reportSyncError, syncActivity } from '@/server/sync';
import { getConcurrencyOverTime } from '@/server/playback';
import { getAdapter } from '@/server/config';
import { supportsTerminate } from '@/server/adapters';
import { adminScope, requireAdmin } from '@/server/session';
import { lookupCountry } from '@/server/geoip';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const PERIODS = [7, 30, 90] as const;

export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await requireAdmin();
  const t = await getT();
  const requested = Number((await searchParams).days ?? 7);
  const days = PERIODS.includes(requested as (typeof PERIODS)[number]) ? requested : 7;
  await syncActivity().catch(reportSyncError('activity sync'));

  const rows = await db
    .select({
      sessionKey: playbackSessions.sessionKey,
      userId: playbackSessions.userId,
      itemId: playbackSessions.itemId,
      title: playbackSessions.title,
      grandparentTitle: playbackSessions.grandparentTitle,
      mediaType: playbackSessions.mediaType,
      state: playbackSessions.state,
      progressMs: playbackSessions.progressMs,
      durationMs: playbackSessions.durationMs,
      clientName: playbackSessions.clientName,
      deviceName: playbackSessions.deviceName,
      playMethod: playbackSessions.playMethod,
      videoCodec: playbackSessions.videoCodec,
      audioCodec: playbackSessions.audioCodec,
      container: playbackSessions.container,
      width: playbackSessions.width,
      height: playbackSessions.height,
      bitrateKbps: playbackSessions.bitrateKbps,
      transcodeReason: playbackSessions.transcodeReason,
      audioChannels: playbackSessions.audioChannels,
      subtitleCodec: playbackSessions.subtitleCodec,
      sourceVideoCodec: playbackSessions.sourceVideoCodec,
      sourceHeight: playbackSessions.sourceHeight,
      startedAt: playbackSessions.startedAt,
      lastSeenAt: playbackSessions.lastSeenAt,
      progressAt: playbackSessions.progressAt,
      remoteAddress: playbackSessions.remoteAddress,
      isLocal: playbackSessions.isLocal,
      username: users.username,
    })
    .from(playbackSessions)
    .leftJoin(users, eq(users.id, playbackSessions.userId))
    .where(
      session.user.globalAdmin
        ? liveSessionFilter()
        : // A server admin sees their own server only. Session keys carry the server id.
          and(liveSessionFilter(), like(playbackSessions.sessionKey, `${session.user.serverId}:%`)),
    );

  // Country lookups are cached and skipped entirely for local addresses, so this stays
  // cheap even though the page refreshes every ten seconds.
  const located = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      country: row.remoteAddress ? await lookupCountry(row.remoteAddress).catch(() => null) : null,
    })),
  );

  const bandwidth = rows.reduce((sum, r) => sum + (r.bitrateKbps ?? 0), 0);
  const transcodes = rows.filter((r) => r.playMethod === 'transcode').length;

  // Backends without a terminate endpoint must not render a button that cannot work.
  const canTerminate = supportsTerminate(await getAdapter(session.user.serverId));

  const history = await getConcurrencyOverTime(days, adminScope(session.user));
  const streamSeries = history.map((p) => ({ label: p.label, value: p.streams }));
  const bandwidthSeries = history.map((p) => ({
    label: p.label,
    value: Math.round(p.bandwidthKbps / 100) / 10,
  }));

  return (
    <>
      <AutoRefresh seconds={10} />
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminActivity')}</h1>
      <p className="subtitle">{t('adminActivity.subtitle')}</p>

      <div className="grid cols-4">
        <StatCard label={t('adminActivity.activeStreams')} value={String(rows.length)} />
        <StatCard label={t('adminActivity.transcoding')} value={String(transcodes)} />
        <StatCard
          label={t('adminActivity.remoteStreams')}
          value={`${rows.filter((r) => r.isLocal === false).length} / ${rows.length}`}
          info={t('adminActivity.remoteStreamsInfo')}
        />
        <StatCard
          label={t('adminActivity.totalBandwidth')}
          value={`${(bandwidth / 1000).toFixed(1)} Mbps`}
          info={t('adminActivity.totalBandwidthInfo')}
        />
        <StatCard
          label={t('stream.directPlay')}
          value={`${rows.length - transcodes} / ${rows.length}`}
          href="/admin/transcoding"
          info={t('adminActivity.directPlayInfo')}
        />
      </div>

      <div className="card section">
        <ActivityTable rows={located} showUser showAddress canTerminate={canTerminate} />
      </div>

      <div className="section toolbar">
        <h2 style={{ margin: 0 }}>{t('nav.history')}</h2>
        <div className="seg">
          {PERIODS.map((period) => (
            <a
              key={period}
              href={`/admin/activity?days=${period}`}
              className={period === days ? 'on' : undefined}
            >
              {t('adminActivity.daysShort', { count: period })}
            </a>
          ))}
        </div>
      </div>

      <section className="section">
        <h2>
          {days <= 7
            ? t('adminActivity.streamsPerHour')
            : t('adminActivity.streamsPerDay')}
        </h2>
        <div className="card">
          <AreaChart
            data={streamSeries}
            format={(v) => t('common.streams', { count: v })}
            label={t('adminActivity.streamsChart', { days })}
          />
        </div>
      </section>

      <section className="section">
        <h2>
          {days <= 7
            ? t('adminActivity.bandwidthPerHour')
            : t('adminActivity.bandwidthPerDay')}
        </h2>
        <div className="card">
          <AreaChart
            data={bandwidthSeries}
            format={(v) => `${v} Mbps`}
            label={t('adminActivity.bandwidthChart', { days })}
          />
        </div>
      </section>
    </>
  );
}
