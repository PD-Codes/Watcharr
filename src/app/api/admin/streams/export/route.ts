import { NextResponse } from 'next/server';
import { csvResponse, toCsv } from '@/server/csv';
import { listSessionHistory } from '@/server/playback';
import { adminScope, getSession, isAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

const MAX_ROWS = 50000;

/**
 * The stream table as a file. Scoped the same way the page is — a server admin exports
 * their own server's streams, never the whole deployment's.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session || !isAdmin(session.user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const sp = new URL(request.url).searchParams;
  const days = sp.get('days') ? Number(sp.get('days')) : undefined;

  const { rows } = await listSessionHistory({
    scope: adminScope(session.user),
    days: Number.isFinite(days) ? days : undefined,
    limit: MAX_ROWS,
    transcodesOnly: sp.get('transcodes') === '1',
  });

  const body = toCsv(
    [
      'Started',
      'Ended',
      'User',
      'Title',
      'Episode',
      'Type',
      'Watched (min)',
      'Duration (min)',
      'Player',
      'Device',
      'Delivery',
      'Video',
      'Source video',
      'Height',
      'Source height',
      'Audio',
      'Channels',
      'Subtitles',
      'Container',
      'Bitrate (kbps)',
      'Source bitrate (kbps)',
      'Transcode reason',
      'Address',
      'Network',
    ],
    rows.map((row) => [
      row.startedAt.toISOString(),
      row.lastSeenAt.toISOString(),
      row.username ?? '',
      row.grandparentTitle ?? row.title,
      row.grandparentTitle ? row.title : '',
      row.mediaType,
      Math.round(row.progressMs / 60000),
      Math.round(row.durationMs / 60000),
      row.clientName ?? '',
      row.deviceName ?? '',
      row.playMethod ?? '',
      row.videoCodec ?? '',
      row.sourceVideoCodec ?? '',
      row.height ?? '',
      row.sourceHeight ?? '',
      row.audioCodec ?? '',
      row.audioChannels ?? '',
      row.subtitleCodec ?? '',
      row.container ?? '',
      row.bitrateKbps ?? '',
      row.sourceBitrateKbps ?? '',
      row.transcodeReason ?? '',
      row.remoteAddress ?? '',
      row.isLocal === null ? '' : row.isLocal ? 'LAN' : 'WAN',
    ]),
  );

  return csvResponse('watcharr-streams.csv', body);
}
