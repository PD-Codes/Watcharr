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

export const dynamic = 'force-dynamic';

const PERIODS = [7, 30, 90] as const;

export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await requireAdmin();
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
      <p className="eyebrow">Admin</p>
      <h1>All Activity</h1>
      <p className="subtitle">Every active stream on the server.</p>

      <div className="grid cols-4">
        <StatCard label="Active streams" value={String(rows.length)} />
        <StatCard label="Transcoding" value={String(transcodes)} />
        <StatCard
          label="Remote streams"
          value={`${rows.filter((r) => r.isLocal === false).length} / ${rows.length}`}
          info="Streams delivered to an address outside the local network."
        />
        <StatCard
          label="Total bandwidth"
          value={`${(bandwidth / 1000).toFixed(1)} Mbps`}
          info="Sum of the delivered bitrate of all active streams."
        />
        <StatCard
          label="Direct play"
          value={`${rows.length - transcodes} / ${rows.length}`}
          href="/admin/transcoding"
          info="Streams the server sends without re-encoding. Opens the transcoding statistics."
        />
      </div>

      <div className="card section">
        <ActivityTable rows={located} showUser showAddress canTerminate={canTerminate} />
      </div>

      <div className="section toolbar">
        <h2 style={{ margin: 0 }}>History</h2>
        <div className="seg">
          {PERIODS.map((period) => (
            <a
              key={period}
              href={`/admin/activity?days=${period}`}
              className={period === days ? 'on' : undefined}
            >
              {period}d
            </a>
          ))}
        </div>
      </div>

      <section className="section">
        <h2>{days <= 7 ? 'Streams per hour' : 'Streams per day'}</h2>
        <div className="card">
          <AreaChart
            data={streamSeries}
            format={(v) => `${v} streams`}
            label={`Streams over the last ${days} days`}
          />
        </div>
      </section>

      <section className="section">
        <h2>{days <= 7 ? 'Bandwidth per hour' : 'Bandwidth per day'}</h2>
        <div className="card">
          <AreaChart
            data={bandwidthSeries}
            format={(v) => `${v} Mbps`}
            label={`Delivered bandwidth over the last ${days} days`}
          />
        </div>
      </section>
    </>
  );
}
