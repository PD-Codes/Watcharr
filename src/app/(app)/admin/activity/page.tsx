import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions, users } from '@/db/schema';
import ActivityTable from '@/components/ActivityTable';
import AutoRefresh from '@/components/AutoRefresh';
import { StatCard } from '@/components/Charts';
import { liveSessionFilter, syncActivity } from '@/server/sync';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function AdminActivityPage() {
  await requireAdmin();
  await syncActivity().catch(() => {});

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
      username: users.username,
    })
    .from(playbackSessions)
    .leftJoin(users, eq(users.id, playbackSessions.userId))
    .where(liveSessionFilter());

  const bandwidth = rows.reduce((sum, r) => sum + (r.bitrateKbps ?? 0), 0);
  const transcodes = rows.filter((r) => r.playMethod === 'transcode').length;

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
        <ActivityTable rows={rows} showUser />
      </div>
    </>
  );
}
