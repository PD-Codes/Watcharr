import { NextResponse } from 'next/server';
import { getAdapter } from '@/server/config';
import { supportsTerminate } from '@/server/adapters';
import { getSession } from '@/server/session';
import { sessionRowKey } from '@/server/sync';

export const dynamic = 'force-dynamic';

const MAX_REASON_LENGTH = 200;

/**
 * Stops a running stream. The native handle is read from the live session list rather than
 * from the stored row: on Plex the two are different values, and a stream that is no longer
 * live cannot be terminated anyway.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !(session.user.isAdmin || session.user.globalAdmin)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const body: unknown = await request.json().catch(() => null);
  const sessionKey = (body as { sessionKey?: unknown } | null)?.sessionKey;
  const rawReason = (body as { reason?: unknown } | null)?.reason;
  if (typeof sessionKey !== 'string' || !sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }
  const reason =
    typeof rawReason === 'string' && rawReason.trim()
      ? rawReason.trim().slice(0, MAX_REASON_LENGTH)
      : undefined;

  // The stored key names the server it came from, which is the one to talk to — a global
  // admin may be looking at a stream on a server they did not sign in through.
  const serverId = Number(sessionKey.split(':')[0]);
  if (!Number.isInteger(serverId) || serverId < 1) {
    return NextResponse.json({ error: 'Unknown session' }, { status: 400 });
  }
  if (!session.user.globalAdmin && serverId !== session.user.serverId) {
    return NextResponse.json({ error: 'Not your server' }, { status: 403 });
  }

  const adapter = await getAdapter(serverId).catch(() => null);
  if (!adapter) return NextResponse.json({ error: 'Unknown server' }, { status: 404 });
  if (!supportsTerminate(adapter)) {
    return NextResponse.json(
      { error: `${adapter.type} does not support terminating streams` },
      { status: 501 },
    );
  }

  // Stored keys carry the server prefix; the adapter reports the native one.
  const live = await adapter.getSessions();
  const target = live.find(
    (s) => sessionRowKey(serverId, s.sessionKey) === sessionKey,
  );
  if (!target?.terminateKey) {
    return NextResponse.json({ error: 'That stream is no longer running' }, { status: 404 });
  }

  try {
    await adapter.terminateSession(target.terminateKey, reason);
  } catch {
    return NextResponse.json({ error: 'The media server refused to stop the stream' }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
