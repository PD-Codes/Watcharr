import Link from 'next/link';
import type { playbackSessions } from '@/db/schema';
import { formatDuration, percent } from './format';
import IpLink from './IpLink';
import TerminateButton from './TerminateButton';

type Row = typeof playbackSessions.$inferSelect & {
  username?: string | null;
  /** Resolved country, when the optional lookup is on. Local streams never have one. */
  country?: string | null;
};

const PLAY_METHOD_LABELS: Record<string, string> = {
  directplay: 'Direct play',
  directstream: 'Direct stream',
  transcode: 'Transcode',
};

export function streamSummary(row: Row): string {
  const parts = [
    PLAY_METHOD_LABELS[row.playMethod ?? ''] ?? 'Unknown',
    row.videoCodec?.toUpperCase(),
    row.height ? `${row.height}p` : null,
    row.bitrateKbps ? `${(row.bitrateKbps / 1000).toFixed(1)} Mbps` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export default function ActivityTable({
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
  if (!rows.length) return <p className="muted">Nothing is playing right now.</p>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {showUser && <th scope="col">User</th>}
            <th scope="col">Title</th>
            <th scope="col">Progress</th>
            <th scope="col">Client</th>
            <th scope="col">Stream</th>
            {canTerminate && <th scope="col">Action</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sessionKey}>
              {showUser && (
                <td>
                  {row.userId ? (
                    <Link href={`/admin/users/${row.userId}`}>{row.username ?? 'unknown'}</Link>
                  ) : (
                    (row.username ?? 'unknown')
                  )}
                </td>
              )}
              <td>
                <Link href={`/title/${encodeURIComponent(row.grandparentTitle ?? row.title)}`}>
                  {row.grandparentTitle ? `${row.grandparentTitle} — ${row.title}` : row.title}
                </Link>
                <div
                  className="progress"
                  data-tip={`${percent(row.progressMs, row.durationMs)}% watched`}
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
                      {row.isLocal ? 'LAN' : (row.country ?? 'Remote')}
                    </span>
                    {showAddress && row.remoteAddress && (
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        <IpLink ip={row.remoteAddress} />
                      </div>
                    )}
                  </>
                )}
              </td>
              <td data-tip={row.transcodeReason ? `Reason: ${row.transcodeReason}` : 'Delivered stream'}>
                {streamSummary(row)}
                <div className="muted" style={{ fontSize: 12 }}>
                  {[row.container?.toUpperCase(), row.audioCodec?.toUpperCase()]
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
