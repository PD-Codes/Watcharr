import Link from 'next/link';
import type { playbackSessions } from '@/db/schema';
import { artUrl, formatDuration, formatTimeAgo, percent } from './format';
import { LiveScrub, LiveTimecode } from './LiveProgress';
import { getT } from '@/i18n/server';

type Session = typeof playbackSessions.$inferSelect & { username?: string | null };

const PLAY_METHOD_KEYS = {
  directplay: 'stream.directPlay',
  directstream: 'stream.directStream',
  transcode: 'stream.transcode',
} as const;

/**
 * The signature element: what is playing, right now. This is the only place in the
 * interface that lights up — the amber wash and the playhead exist solely while a
 * session is live, which is what makes "color means playing" readable at a glance.
 */
export default async function Beam({
  session,
  serverSlug,
  showUser,
  emptyLabel,
}: {
  session: Session | null;
  /** Which media server the artwork is fetched from. */
  serverSlug: string;
  showUser?: boolean;
  emptyLabel?: string;
}) {
  const t = await getT();
  if (!session) {
    return (
      <div className="beam">
        <div className="beam-idle">{emptyLabel ?? t('beam.idle')}</div>
      </div>
    );
  }

  const progress = percent(session.progressMs, session.durationMs);
  const label = session.grandparentTitle ?? session.title;
  const remaining = Math.max(0, session.durationMs - session.progressMs);
  const paused = session.state === 'paused';
  const live = {
    progressMs: session.progressMs,
    durationMs: session.durationMs,
    playing: session.state === 'playing',
    // The position is as old as the last sync that saw this stream; capped so a stalled row
    // cannot run a bar far ahead of the truth.
    ageMs: Math.min(15_000, Math.max(0, Date.now() - session.lastSeenAt.getTime())),
  };

  const stream = [
    PLAY_METHOD_KEYS[session.playMethod as keyof typeof PLAY_METHOD_KEYS]
      ? t(PLAY_METHOD_KEYS[session.playMethod as keyof typeof PLAY_METHOD_KEYS])
      : t('stream.unknownMethod'),
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
          <span className={`badge ${paused ? '' : 'live'}`}>{paused ? t('beam.paused') : t('beam.nowPlaying')}</span>
          {showUser && session.username && <span className="muted">{session.username}</span>}
          <span className="muted">{t('beam.started', { ago: formatTimeAgo(t, session.startedAt) })}</span>
        </p>

        <p className="beam-title">
          <Link href={`/title/${encodeURIComponent(label)}`}>{label}</Link>
        </p>
        <p className="beam-sub">
          {/* The show links to /title, the episode to its own page — otherwise the item
              behind a running stream is unreachable from Now Playing. */}
          {session.grandparentTitle ? (
            <Link href={`/item/${encodeURIComponent(session.itemId)}`}>{session.title}</Link>
          ) : (
            session.mediaType
          )}
        </p>

        <LiveScrub {...live} tip={t('beam.scrub', { percent: progress, duration: formatDuration(remaining) })} />

        <div className="beam-meta">
          <LiveTimecode {...live} />
          <span className="muted">{t('beam.remaining', { duration: formatDuration(remaining) })}</span>
          <span data-tip={t('beam.player')}>{session.clientName ?? t('stream.unknownClient')}</span>
          <span data-tip={t('common.device')}>{session.deviceName ?? '—'}</span>
          <span
            data-tip={
              session.transcodeReason
                ? t('stream.reason', { reason: session.transcodeReason })
                : t('stream.delivered')
            }
          >
            {stream.join(' · ')}
          </span>
        </div>
      </div>
    </div>
  );
}
