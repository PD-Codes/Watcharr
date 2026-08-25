import Link from 'next/link';
import type { playbackSessions } from '@/db/schema';
import { artUrl, formatDuration, formatTimecode, percent } from './format';

type Session = typeof playbackSessions.$inferSelect & { username?: string | null };

const PLAY_METHOD_LABELS: Record<string, string> = {
  directplay: 'Direct play',
  directstream: 'Direct stream',
  transcode: 'Transcode',
};

/**
 * The signature element: what is playing, right now. This is the only place in the
 * interface that lights up — the amber wash and the playhead exist solely while a
 * session is live, which is what makes "colour means playing" readable at a glance.
 */
export default function Beam({
  session,
  serverSlug,
  showUser,
  emptyLabel = 'Nothing is playing.',
}: {
  session: Session | null;
  /** Which media server the artwork is fetched from. */
  serverSlug: string;
  showUser?: boolean;
  emptyLabel?: string;
}) {
  if (!session) {
    return (
      <div className="beam">
        <div className="beam-idle">{emptyLabel}</div>
      </div>
    );
  }

  const progress = percent(session.progressMs, session.durationMs);
  const label = session.grandparentTitle ?? session.title;
  const remaining = Math.max(0, session.durationMs - session.progressMs);
  const paused = session.state === 'paused';

  const stream = [
    PLAY_METHOD_LABELS[session.playMethod ?? ''] ?? 'Unknown method',
    session.videoCodec?.toUpperCase(),
    session.audioCodec?.toUpperCase(),
    session.height ? `${session.height}p` : null,
    session.container?.toUpperCase(),
    session.bitrateKbps ? `${(session.bitrateKbps / 1000).toFixed(1)} Mbps` : null,
  ].filter(Boolean);

  return (
    <div className={`beam ${paused ? 'paused' : 'live'}`}>
      <Link href={`/title/${encodeURIComponent(label)}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="beam-art" src={artUrl(serverSlug, session.itemId)} alt="" />
      </Link>

      <div>
        <p className="beam-head">
          <span className={`badge ${paused ? '' : 'live'}`}>{paused ? 'Paused' : 'Now playing'}</span>
          {showUser && session.username && <span className="muted">{session.username}</span>}
          <span className="muted">started {formatTimeAgo(session.startedAt)}</span>
        </p>

        <p className="beam-title">
          <Link href={`/title/${encodeURIComponent(label)}`}>{label}</Link>
        </p>
        <p className="beam-sub">{session.grandparentTitle ? session.title : session.mediaType}</p>

        <div className="scrub" data-tip={`${progress}% · ${formatDuration(remaining)} left`}>
          <span className="scrub-fill" style={{ width: `${progress}%` }} />
          <span className="scrub-head" style={{ left: `${progress}%` }} />
        </div>

        <div className="beam-meta">
          <span className="timecode num">
            {formatTimecode(session.progressMs)} / {formatTimecode(session.durationMs)}
          </span>
          <span className="muted">{formatDuration(remaining)} left</span>
          <span data-tip="Player application">{session.clientName ?? 'Unknown client'}</span>
          <span data-tip="Device">{session.deviceName ?? '—'}</span>
          <span data-tip={session.transcodeReason ? `Reason: ${session.transcodeReason}` : 'Delivered stream'}>
            {stream.join(' · ')}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Rough, human relative time — exact seconds do not matter here. */
function formatTimeAgo(date: Date): string {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
