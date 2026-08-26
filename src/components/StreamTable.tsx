import Link from 'next/link';
import IpLink from './IpLink';
import TitleLink from './TitleLink';
import { formatDate, formatDuration, percent } from './format';
import type { SessionHistoryRow } from '@/server/playback';
import { getT } from '@/i18n/server';

// Past streams with the delivery details the media server reported. The live table lives
// in ActivityTable; this is the same information after the fact, which is the half
// Tautulli users actually go looking for ("why did that transcode last night?").

const PLAY_METHOD_KEYS = {
  directplay: 'stream.directPlay',
  directstream: 'stream.directStream',
  transcode: 'stream.transcode',
} as const;

const upper = (value?: string | null) => (value ? value.toUpperCase() : null);
const mbps = (kbps?: number | null) => (kbps ? `${(kbps / 1000).toFixed(1)} Mbps` : null);

/**
 * "HEVC 2160p → H264 1080p" when the two sides differ, one side when they do not. A
 * transcode is only readable with both ends of it; showing the arrow unconditionally would
 * suggest a conversion on every direct play.
 */
function streamChain(row: SessionHistoryRow): string {
  const source = [upper(row.sourceVideoCodec), row.sourceHeight ? `${row.sourceHeight}p` : null]
    .filter(Boolean)
    .join(' ');
  const delivered = [upper(row.videoCodec), row.height ? `${row.height}p` : null]
    .filter(Boolean)
    .join(' ');
  if (!source) return delivered || '—';
  if (!delivered || source === delivered) return source;
  return `${source} → ${delivered}`;
}

function audioChain(row: SessionHistoryRow): string {
  const channels = row.audioChannels ? `${row.audioChannels}ch` : null;
  const source = [upper(row.sourceAudioCodec), channels].filter(Boolean).join(' ');
  const delivered = upper(row.audioCodec);
  if (!source) return delivered ?? '—';
  if (!delivered || upper(row.sourceAudioCodec) === delivered) return source;
  return `${source} → ${delivered}`;
}

export default async function StreamTable({
  rows,
  showUser,
  showAddress,
  emptyLabel,
}: {
  rows: SessionHistoryRow[];
  showUser?: boolean;
  /** Admin views only — this is viewer data. */
  showAddress?: boolean;
  emptyLabel: string;
}) {
  const t = await getT();
  if (!rows.length) return <p className="muted">{emptyLabel}</p>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{t('stream.started')}</th>
            {showUser && <th scope="col">{t('common.user')}</th>}
            <th scope="col">{t('common.title')}</th>
            <th scope="col">{t('common.watched')}</th>
            <th scope="col">{t('stream.player')}</th>
            <th scope="col">{t('stream.video')}</th>
            <th scope="col">{t('stream.audio')}</th>
            <th scope="col">{t('stream.delivery')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sessionKey}>
              <td className="num muted" style={{ whiteSpace: 'nowrap' }}>
                {formatDate(row.startedAt)}
              </td>
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
              </td>
              <td className="num">
                {formatDuration(row.progressMs)}
                <div className="muted" style={{ fontSize: 12 }}>
                  {percent(row.progressMs, row.durationMs)}%
                </div>
              </td>
              <td>
                {row.clientName ?? '—'}
                <div className="muted" style={{ fontSize: 12 }}>
                  {row.deviceName ?? ''}
                </div>
                {showAddress && row.remoteAddress && (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    <IpLink ip={row.remoteAddress} />
                  </div>
                )}
              </td>
              <td>
                {streamChain(row)}
                <div className="muted" style={{ fontSize: 12 }}>
                  {mbps(row.bitrateKbps) ?? ''}
                </div>
              </td>
              <td>
                {audioChain(row)}
                {row.subtitleCodec && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    SUB {upper(row.subtitleCodec)}
                  </div>
                )}
              </td>
              <td
                data-tip={
                  row.transcodeReason ? t('stream.reason', { reason: row.transcodeReason }) : undefined
                }
              >
                <span className={`badge ${row.playMethod === 'transcode' ? 'on' : ''}`}>
                  {PLAY_METHOD_KEYS[row.playMethod as keyof typeof PLAY_METHOD_KEYS]
                    ? t(PLAY_METHOD_KEYS[row.playMethod as keyof typeof PLAY_METHOD_KEYS])
                    : t('common.unknown')}
                </span>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {[upper(row.container), row.isLocal === null ? null : row.isLocal ? t('stream.lan') : t('stream.wan')]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
