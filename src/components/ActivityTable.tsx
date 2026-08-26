import Link from 'next/link';
import type { playbackSessions } from '@/db/schema';
import { formatDuration, percent } from './format';
import IpLink from './IpLink';
import TerminateButton from './TerminateButton';
import TitleLink from './TitleLink';
import { getT } from '@/i18n/server';
import type { Translate } from '@/i18n';

/**
 * Only the columns this table reads, not the whole row. A page selects them explicitly, so
 * naming them here keeps a new column on playback_sessions from breaking every caller.
 */
type Row = Pick<
  typeof playbackSessions.$inferSelect,
  | 'sessionKey'
  | 'userId'
  | 'itemId'
  | 'title'
  | 'grandparentTitle'
  | 'state'
  | 'progressMs'
  | 'durationMs'
  | 'clientName'
  | 'deviceName'
  | 'playMethod'
  | 'videoCodec'
  | 'audioCodec'
  | 'container'
  | 'height'
  | 'bitrateKbps'
  | 'transcodeReason'
  | 'remoteAddress'
  | 'isLocal'
> &
  Partial<
    Pick<
      typeof playbackSessions.$inferSelect,
      'audioChannels' | 'subtitleCodec' | 'sourceVideoCodec' | 'sourceHeight'
    >
  > & {
    username?: string | null;
    /** Resolved country, when the optional lookup is on. Local streams never have one. */
    country?: string | null;
  };

const PLAY_METHOD_KEYS = {
  directplay: 'stream.directPlay',
  directstream: 'stream.directStream',
  transcode: 'stream.transcode',
} as const;

/** Translated label for a play method, falling back to the shared "Unknown". */
function playMethodLabel(t: Translate, playMethod?: string | null): string {
  const key = PLAY_METHOD_KEYS[playMethod as keyof typeof PLAY_METHOD_KEYS];
  return key ? t(key) : t('common.unknown');
}

export function streamSummary(t: Translate, row: Row): string {
  // During a transcode the delivered codec alone is misleading, so the source is shown
  // alongside it — same reasoning as the stream history table.
  const source = [
    row.sourceVideoCodec?.toUpperCase(),
    row.sourceHeight ? `${row.sourceHeight}p` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const delivered = [row.videoCodec?.toUpperCase(), row.height ? `${row.height}p` : null]
    .filter(Boolean)
    .join(' ');

  const parts = [
    playMethodLabel(t, row.playMethod),
    source && delivered && source !== delivered ? `${source} → ${delivered}` : delivered || source,
    row.bitrateKbps ? `${(row.bitrateKbps / 1000).toFixed(1)} Mbps` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export default async function ActivityTable({
  rows,
  showUser,
  canTerminate,
  showAddress,
}: {
  rows: Row[];
  showUser?: boolean;
  /** Renders the stop control. Enforced again on the server by the terminate route. */
  canTerminate?: boolean;
  /** Renders the resolvable address. Admin views only — this is viewer data. */
  showAddress?: boolean;
}) {
  const t = await getT();
  if (!rows.length) return <p className="muted">{t('activity.nothingPlaying')}</p>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {showUser && <th scope="col">{t('common.user')}</th>}
            <th scope="col">{t('common.title')}</th>
            <th scope="col">{t('activity.progress')}</th>
            <th scope="col">{t('activity.client')}</th>
            <th scope="col">{t('activity.stream')}</th>
            {canTerminate && <th scope="col">{t('activity.action')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sessionKey}>
              {showUser && (
                <td>
                  {row.userId ? (
                    <Link href={`/admin/users/${row.userId}`}>{row.username ?? t('stream.unknownUser')}</Link>
                  ) : (
                    (row.username ?? t('stream.unknownUser'))
                  )}
                </td>
              )}
              <td>
                <TitleLink
                  itemId={row.itemId}
                  title={row.title}
                  grandparentTitle={row.grandparentTitle}
                  serverWide={showUser}
                />
                <div
                  className="progress"
                  data-tip={t('activity.percentWatched', { percent: percent(row.progressMs, row.durationMs) })}
                >
                  <span style={{ width: `${percent(row.progressMs, row.durationMs)}%` }} />
                </div>
              </td>
              <td>
                {formatDuration(row.progressMs)} / {formatDuration(row.durationMs)}
                <br />
                <span className={`badge ${row.state === 'playing' ? 'live' : ''}`}>{row.state}</span>
              </td>
              <td>
                {row.clientName ?? '—'}
                <br />
                <span className="muted">{row.deviceName ?? ''}</span>
                {row.isLocal !== null && (
                  <>
                    <br />
                    <span className="badge" data-tip={showAddress ? undefined : (row.remoteAddress ?? undefined)}>
                      {row.isLocal ? t('stream.lan') : (row.country ?? t('stream.remote'))}
                    </span>
                    {showAddress && row.remoteAddress && (
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        <IpLink ip={row.remoteAddress} />
                      </div>
                    )}
                  </>
                )}
              </td>
              <td data-tip={
                  row.transcodeReason
                    ? t('stream.reason', { reason: row.transcodeReason })
                    : t('stream.delivered')
                }>
                {streamSummary(t, row)}
                <div className="muted" style={{ fontSize: 12 }}>
                  {[
                    row.container?.toUpperCase(),
                    row.audioCodec?.toUpperCase(),
                    row.audioChannels ? `${row.audioChannels}ch` : null,
                    row.subtitleCodec ? `SUB ${row.subtitleCodec.toUpperCase()}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </td>
              {canTerminate && (
                <td>
                  <TerminateButton sessionKey={row.sessionKey} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
