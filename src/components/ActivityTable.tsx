import Link from 'next/link';
import type { playbackSessions } from '@/db/schema';
import { formatDuration, percent } from './format';

type Row = typeof playbackSessions.$inferSelect & { username?: string | null };

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

export default function ActivityTable({ rows, showUser }: { rows: Row[]; showUser?: boolean }) {
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
              </td>
              <td data-tip={row.transcodeReason ? `Reason: ${row.transcodeReason}` : 'Delivered stream'}>
                {streamSummary(row)}
                <div className="muted" style={{ fontSize: 12 }}>
                  {[row.container?.toUpperCase(), row.audioCodec?.toUpperCase()]
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
