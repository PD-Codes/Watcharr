import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions, users } from '@/db/schema';
import { checkApiKey } from '@/server/publicapi';
import { liveSessionFilter, reportSyncError, syncActivity } from '@/server/sync';

export const dynamic = 'force-dynamic';

/**
 * What is playing right now — the endpoint a status dashboard actually asks for.
 *
 * Runs the same activity sync a page render would, so a caller that only ever hits the API
 * still gets fresh data: on a deployment where nobody has the web UI open, the sync would
 * otherwise never run at all.
 */
export async function GET(request: Request) {
  const denied = await checkApiKey(request);
  if (denied) return denied;

  await syncActivity().catch(reportSyncError('activity sync'));

  const rows = await db
    .select({
      sessionKey: playbackSessions.sessionKey,
      user: users.username,
      title: playbackSessions.title,
      grandparentTitle: playbackSessions.grandparentTitle,
      mediaType: playbackSessions.mediaType,
      state: playbackSessions.state,
      progressMs: playbackSessions.progressMs,
      durationMs: playbackSessions.durationMs,
      playMethod: playbackSessions.playMethod,
      videoCodec: playbackSessions.videoCodec,
      height: playbackSessions.height,
      bitrateKbps: playbackSessions.bitrateKbps,
      clientName: playbackSessions.clientName,
      deviceName: playbackSessions.deviceName,
      isLocal: playbackSessions.isLocal,
    })
    .from(playbackSessions)
    .leftJoin(users, eq(users.id, playbackSessions.userId))
    .where(liveSessionFilter());

  return NextResponse.json({
    streamCount: rows.length,
    transcodeCount: rows.filter((row) => row.playMethod === 'transcode').length,
    // Deliberately not the remote address: the key is meant for a wall display, and an
    // address is the one field on this row that identifies a person's location.
    totalBandwidthKbps: rows.reduce((sum, row) => sum + (row.bitrateKbps ?? 0), 0),
    sessions: rows,
  });
}
